/**
 * blogGenLoop.ts — autorun: picks "New Logic" rows that have a Target URL
 * but no Blog Content yet, generates the article and cover image
 * CONCURRENTLY in two separate Chrome windows (blogGenAgent.ts /
 * blogImageAgent.ts each launch their own persistent context — see those
 * files), writes the result back, then re-reads that same cell from the
 * sheet to verify it actually landed with real content (and the image URL,
 * if requested) before moving on to the next row. One bad write can't
 * silently pass as "generated."
 *
 * Deliberately NOT wired into scheduler-new.ts's node-cron jobs: each row
 * takes ~12-15 min (blog) / up to ~9 min (image) of real ChatGPT generation
 * time through visible, logged-in Chrome windows — running that inside the
 * same process as the tightly-timed 10:30-18:00 posting cron would block or
 * collide with posting batches. Run this as its own long-lived process.
 */

import { generateBlogViaChatGpt, BlogGenResult } from '../agents/blogGenAgent.js';
import { generateBlogCoverImageWithText } from '../agents/blogImageAgent.js';
// import { runBlogSanityChecks } from '../agents/blogSanityAgent.js';
// import { validateBrandAuthority } from '../agents/blogBrandValidator.js';
// normalizeImgTags alone (not the full runBlogSanityChecks suite above,
// which stays disabled pending the KPI-check redesign) — every <img> tag
// this loop produces MUST end up as the canonical `<img src='URL'>` shape
// (single-quoted, no alt) before it's saved; this was the one piece of that
// disabled suite actually needed here, and it was silently not running.
import { normalizeImgTags } from '../agents/blogSanityAgent.js';
import { generateAndUploadSnapshotImage } from '../agents/blogSnapshotImageAgent.js';
import { generateAndUploadLandscapeImage } from '../agents/blogLandscapeImageAgent.js';
import { applyPreferredSourceCTA, validatePreferredSourceCTA, PreferredSourceMode } from '../agents/blogPreferredSourceAgent.js';
import { registerAutomation, startRun, finishRun } from '../dashboard/client.js';
import { AUTOMATION_CONFIG } from '../dashboard/config.js';
import { getContentPoolRowsNeedingGeneration, saveGeneratedBlogToPool, saveCoverImageUrlToPool, saveNewLogicImageText, getSheetRowByIndex } from '../sheets/sheets.js';

// 'tracked' by default — lets us start collecting Preferred Source CTA Click
// data from day one (can't back-fill it later). Switch to 'direct' here (or
// wire up per-row rotation) once there's baseline click data to compare
// against. See src/agents/blogPreferredSourceAgent.ts for what each mode does.
const PREFERRED_SOURCE_MODE: PreferredSourceMode = 'direct';

/**
 * Force the cover/header image at the very TOP of the article, before the
 * H1 — ALWAYS prepends, never replaces an existing <img>.
 *
 * The V1.3 prompt (see blogGenAgent.ts) never writes a leading <img> of its
 * own — the only <img> in its raw output is the mid-article snapshot
 * placeholder (YOUR_IMAGE_URL_HERE, inside a <figure> after the intro).
 * The old "replace the first <img> tag" behavior therefore grabbed THAT
 * placeholder and put the cover image mid-article instead of at the top —
 * confirmed live 2026-09-18. Snapshot injection must also run BEFORE this,
 * so its placeholder is already gone by the time this ever looks for one.
 */
function injectCoverImage(html: string, imageUrl: string): string {
  if (!imageUrl) return html;
  // Double quotes — matches the mid-article snapshot <img> (which keeps
  // whatever quote style the V1.3 prompt's "<img src=... alt=...>" spec
  // uses, itself double-quoted) so both images use the same attribute
  // quoting throughout the article, not a mix of ' and ".
  return `<img src="${imageUrl}">\n${html}`;
}

/**
 * Same pattern as injectCoverImage — replace the V1.3 prompt's mid-article
 * <img src="YOUR_IMAGE_URL_HERE"> placeholder with the real, generated-and-
 * uploaded snapshot chart URL. The negative lookahead keeps this from also
 * matching the SECOND placeholder (YOUR_IMAGE_URL_HERE_2), since that token
 * starts with the same literal text.
 */
function injectSnapshotImage(html: string, snapshotUrl: string): string {
  if (!snapshotUrl) return html;
  return html.replace(/YOUR_IMAGE_URL_HERE(?!_2)/g, snapshotUrl);
}

/** Second mid-article image — replaces <img src="YOUR_IMAGE_URL_HERE_2"> with the generated-and-uploaded "Forecast Outlook & Market Landscape" image URL. */
function injectSnapshotImage2(html: string, landscapeUrl: string): string {
  if (!landscapeUrl) return html;
  return html.replace(/YOUR_IMAGE_URL_HERE_2/g, landscapeUrl);
}

/**
 * Safety net for the case a snapshot/landscape image generation step throws
 * (caught non-fatally above) or blog.imageData(2) was empty to begin with —
 * either way the placeholder token never gets replaced, survives
 * normalizeImgTags() as a syntactically valid but broken <img src='...'>
 * tag (src = literal placeholder text, not a URL), and would otherwise get
 * written straight into the sheet as a dead image. Runs AFTER
 * normalizeImgTags, so every <img> is already in the canonical
 * `<img src='...'>` shape and this only needs one simple pattern. Any tag
 * whose src isn't a real http(s) URL is dropped entirely — better an
 * article with one fewer image than one with a visibly broken one.
 */
function stripUnresolvedImagePlaceholders(html: string): { html: string; removed: number } {
  let removed = 0;
  const out = html.replace(/<img\s+src='([^']*)'\s*>\s*\n?/gi, (tag, src) => {
    if (/^https?:\/\//i.test(src.trim())) return tag;
    removed++;
    return '';
  });
  return { html: out, removed };
}

const MIN_WORDS = 400; // real articles are 1,450-1,600 words — this is a "did anything land at all" floor, not a quality bar

/** Re-read the row from the sheet and confirm the write actually took (content present). A missing cover
 * image is NOT a failure — the text is still good and stays in the sheet; we just note it. */
async function verifyWrite(rowIndex: number, expectImage: boolean): Promise<{ ok: boolean; reason?: string }> {
  const fresh = await getSheetRowByIndex(rowIndex, 'newLogic');
  if (!fresh) return { ok: false, reason: 'row disappeared on re-read' };

  const html = fresh.blogContent || '';
  const wordCount = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORDS) return { ok: false, reason: `Blog Content only ~${wordCount} words after write` };

  if (expectImage && !/<img\b[^>]*src=["']https?:\/\//i.test(html)) {
    return { ok: true, reason: 'no cover image, but text content is fine — accepting' };
  }

  return { ok: true };
}

export interface BlogGenBatchOptions {
  limit?: number;
  withImage?: boolean;
  imagePromptChoice?: '1' | '2';
  blogAccountHandle?: string;
  imageAccountHandle?: string;
  /** Retry once if the post-write verification fails (default true). */
  retryOnVerifyFail?: boolean;
  /** 'master' forces the master prompt every time, skipping the normal 50/50 Prompt B split — for manually testing the master prompt itself. */
  promptVersion?: 'v1' | 'v2' | 'master';
}

/** One pass: generate up to `limit` pending Content Pool rows, verifying each write before moving on. */
export async function runBlogGenBatch(opts: BlogGenBatchOptions = {}): Promise<{ attempted: number; generated: number; failed: number }> {
  // Dashboard reporting — best-effort, never blocks or fails this batch (see
  // dashboard/client.ts doc comment). Registration is cheap/idempotent, so
  // it's fine to call on every batch rather than once at process start.
  await registerAutomation(AUTOMATION_CONFIG);
  const dashboardRunId = await startRun(AUTOMATION_CONFIG.automationId, { workerId: process.env.COMPUTERNAME || process.env.HOSTNAME, currentStage: 'blog_generation' });

  const limit = opts.limit ?? 3;
  const retryOnVerifyFail = opts.retryOnVerifyFail ?? true;
  const rows = await getContentPoolRowsNeedingGeneration(limit, 'newLogic');

  if (rows.length === 0) {
    console.log('[BLOG GEN] No New Logic rows need generation (Target URL set + Blog Content empty).');
    await finishRun(dashboardRunId, { status: 'SUCCESS', executionQuality: 'NO_EXECUTION', metrics: { blogs_attempted: 0, blogs_generated: 0, blogs_failed: 0 } });
    return { attempted: 0, generated: 0, failed: 0 };
  }

  console.log(`[BLOG GEN] ${rows.length} row(s) need generation.`);
  let generated = 0;
  let failed = 0;

  for (const row of rows) {
    const title = row.title || row.targetUrl;
    console.log(`\n[BLOG GEN] Row ${row.rowIndex}: "${title}"`);

    let attemptsLeft = retryOnVerifyFail ? 2 : 1;
    let rowOk = false;

    // "Blocked" verdicts — LINK_VALIDATION_BLOCKED (ChatGPT couldn't verify
    // 12+ Ken Research link placements), RESEARCH_BLOCKED (couldn't verify
    // the primary report page), and PREAMBLE_ONLY (ChatGPT replied with an
    // acknowledgement/question instead of the article, even after the
    // in-agent "proceed" nudge) — get their own shared retry budget,
    // independent of attemptsLeft above: close the browser, reopen, resend
    // the identical prompt, up to MAX_BLOCKED_RETRIES times, then give up on
    // this row explicitly instead of silently falling into generic retries.
    const BLOCKED_ERROR_PREFIXES = ['LINK_VALIDATION_BLOCKED', 'RESEARCH_BLOCKED', 'PREAMBLE_ONLY'];
    let blockedRetries = 0;
    const MAX_BLOCKED_RETRIES = 2;

    // Always generate a fresh cover image — never reuse whatever is already
    // saved in the sheet's Cover Image URL column from a previous run
    // (2026-09-16: doing that was silently skipping image generation
    // entirely, opening only the blog's Chrome window). Still reused WITHIN
    // this row's own retry attempts below — once generated on attempt 1, a
    // blog-text-only retry (attempt 2) won't regenerate it, since the
    // up-to-15-min image generation has no reason to re-run just because the blog
    // side failed validation.
    let coverImageUrl = '';
    // Set once the cover-image attempt fails for ANY reason (closed browser
    // window, timeout, etc.) — without this, a retry attempt only checks
    // `!coverImageUrl` (still empty after a failure) and reopens a second
    // Chrome window to try the ~15-min image generation all over again, even
    // when the failure was the user intentionally closing that window.
    // Cover image is best-effort everywhere it's used — one failed attempt
    // per row is enough; the row proceeds blog-only from here on.
    let coverImageGaveUp = false;

    while (attemptsLeft > 0 && !rowOk) {
      attemptsLeft--;
      try {
        let blog: BlogGenResult;

        // Prompt selection is fully owned inside generateBlogViaChatGpt() now
        // (50% the master prompt / 50% the 4-prompt Prompt B pool, picked
        // there and logged there) — no promptVersion passed here means it
        // never falls into the old v2 (keyword-focused) branch, which is
        // intentionally retired from rotation (2026-09-25).

        if (opts.withImage && !coverImageUrl && !coverImageGaveUp) {
          // Blog (Chrome window #1) and cover image (Chrome window #2) run
          // concurrently — two separate, independent browser contexts.
          console.log(`   Opening 2 parallel Chrome windows (blog + image)...`);
          const [imgResult, blogResult] = await Promise.all([
            generateBlogCoverImageWithText({
              marketName: title,
              reportUrl: row.targetUrl,
              promptChoice: opts.imagePromptChoice ?? '1',
              accountHandle: opts.imageAccountHandle,
            })
              .then(async ({ url, imageText }) => {
                // Write the image URL to the sheet the moment it exists —
                // don't wait for the blog, which may still fail/retry. The
                // image text is purely observational (New Logic!Z) — never
                // let it block or fail this step.
                if (url) {
                  coverImageUrl = url;
                  await saveCoverImageUrlToPool(row, url, 'newLogic').catch((e: any) =>
                    console.log(`   ⚠️ Could not save cover image URL immediately (will be saved with the blog): ${e.message}`));
                }
                if (imageText) await saveNewLogicImageText(row, imageText);
                return url;
              })
              .catch((imgErr: any) => {
                console.log(`   ⚠️ Cover image failed — continuing without one: ${imgErr.message}`);
                coverImageGaveUp = true;
                return '';
              }),
            generateBlogViaChatGpt({ title, url: row.targetUrl, accountHandle: opts.blogAccountHandle, promptVersion: opts.promptVersion }),
          ]);
          if (imgResult) coverImageUrl = imgResult;
          blog = blogResult;
        } else {
          if (opts.withImage) {
            console.log(coverImageGaveUp
              ? `   Cover image already failed once for this row — not retrying it, opening 1 Chrome window (blog only)...`
              : `   Cover image already available — opening 1 Chrome window (blog only)...`);
          }
          blog = await generateBlogViaChatGpt({ title, url: row.targetUrl, accountHandle: opts.blogAccountHandle, promptVersion: opts.promptVersion });
        }

        let htmlWithImage = blog.html;

        // Mid-article snapshot chart (donut/gauge/bar widgets built from
        // blog.imageData — see blogSnapshotImageAgent.ts) replacing the
        // prompt's YOUR_IMAGE_URL_HERE placeholder. MUST run before
        // injectCoverImage below — it's the only <img> in the model's raw
        // output, so the cover-image step needs it already resolved.
        // Non-fatal — a failed snapshot never fails the row, the
        // placeholder just stays as-is.
        let snapshotMetrics: import('../agents/blogSnapshotImageAgent.js').SnapshotMetric[] = [];
        if (blog.imageData) {
          try {
            const snapshot = await generateAndUploadSnapshotImage({ marketName: blog.seoTitle || title, imageData: blog.imageData });
            htmlWithImage = injectSnapshotImage(htmlWithImage, snapshot.url);
            snapshotMetrics = snapshot.metrics;
            console.log(`   [SNAPSHOT IMAGE] Inserted (${snapshot.metrics.length} metrics) → ${snapshot.url}`);
          } catch (snapErr: any) {
            console.log(`   ⚠️ Snapshot image failed — continuing without it: ${snapErr.message}`);
          }
        }

        // Second mid-article image — "Forecast Outlook & Market Landscape"
        // (Growth Drivers / Emerging Trends / Competitive Landscape, plus the
        // forecast trajectory reused from the FIRST image's already-parsed
        // base/forecast/CAGR metrics) — see blogLandscapeImageAgent.ts. Same
        // non-fatal pattern as the snapshot image above; must also run before
        // injectCoverImage.
        if (blog.imageData2 || snapshotMetrics.length) {
          try {
            const landscape = await generateAndUploadLandscapeImage({
              marketName: blog.seoTitle || title,
              heroSourceMetrics: snapshotMetrics,
              imageData2: blog.imageData2,
            });
            htmlWithImage = injectSnapshotImage2(htmlWithImage, landscape.url);
            console.log(`   [LANDSCAPE IMAGE] Inserted → ${landscape.url}`);
          } catch (landErr: any) {
            console.log(`   ⚠️ Landscape image failed — continuing without it: ${landErr.message}`);
          }
        }

        // Cover/header image ALWAYS prepends at the top, after the snapshot
        // placeholder above is already resolved — see injectCoverImage's
        // doc comment for why order matters here.
        if (coverImageUrl) htmlWithImage = injectCoverImage(htmlWithImage, coverImageUrl);

        // 2026-09-18: runBlogSanityChecks / validateBrandAuthority
        // temporarily disabled (imports commented out above) — their KPI
        // checks are being redesigned around the new image pipeline. Write
        // straight through for now; the retry-on-failure loop around this
        // block (attemptsLeft / BLOCKED_ERROR_PREFIXES) is untouched.
        //
        // normalizeImgTags is the one exception — non-negotiable canonical
        // <img src='URL'> shape for every image, regardless of what quote
        // style ChatGPT's raw output or injectCoverImage/injectSnapshotImage
        // used going in.
        const imgNormalized = normalizeImgTags(htmlWithImage, { title: blog.title || title });
        if (imgNormalized.changed) console.log('   [IMG NORMALIZE] Rewrote <img> tag(s) to canonical single-quoted shape');
        htmlWithImage = imgNormalized.html;

        // Must run AFTER normalizeImgTags (needs the canonical <img src='...'>
        // shape) and BEFORE saveGeneratedBlogToPool below — never let a
        // broken/unresolved image placeholder reach the sheet.
        const placeholderCheck = stripUnresolvedImagePlaceholders(htmlWithImage);
        if (placeholderCheck.removed > 0) {
          console.log(`   ⚠️ Removed ${placeholderCheck.removed} unresolved image placeholder(s) before saving — that image's generation must have failed or its data was empty.`);
        }
        htmlWithImage = placeholderCheck.html;

        const preferredSource = applyPreferredSourceCTA(htmlWithImage, { mode: PREFERRED_SOURCE_MODE, title: blog.title || title });
        console.log(`   [PREFERRED SOURCE] ${preferredSource.applied ? `Inserted (${preferredSource.placement})` : `Skipped (${preferredSource.placement})`}`);
        const preferredSourceCheck = validatePreferredSourceCTA(preferredSource.html, PREFERRED_SOURCE_MODE);
        if (preferredSourceCheck.status !== 'PASS') {
          console.log(`   [PREFERRED SOURCE] ⚠️ Validation issues (non-fatal): ${preferredSourceCheck.issues.join(' | ')}`);
        }

        await saveGeneratedBlogToPool(row, {
          coverImageUrl,
          html: preferredSource.html,
          seoTitle: blog.seoTitle,
          metaDescription: blog.description,
          imageData: blog.imageData,
          imageData2: blog.imageData2,
        }, 'newLogic');

        console.log(`   Verifying write for row ${row.rowIndex}...`);
        const verdict = await verifyWrite(row.rowIndex, !!opts.withImage);
        if (verdict.ok) {
          console.log(`   ✅ Row ${row.rowIndex} verified.${verdict.reason ? ` (${verdict.reason})` : ''}`);
          rowOk = true;
          generated++;
        } else {
          console.log(`   ⚠️ Verification failed: ${verdict.reason}${attemptsLeft > 0 ? ' — retrying this row...' : ' — giving up on this row.'}`);
        }
      } catch (err: any) {
        const blockedPrefix = typeof err.message === 'string'
          ? BLOCKED_ERROR_PREFIXES.find((p) => err.message.startsWith(p))
          : undefined;
        if (blockedPrefix) {
          blockedRetries++;
          if (blockedRetries > MAX_BLOCKED_RETRIES) {
            console.log(`   ❌ Row ${row.rowIndex}: ${blockedPrefix} persisted after ${MAX_BLOCKED_RETRIES} retries — skipping this row.`);
            attemptsLeft = 0;
          } else {
            console.log(`   ⚠️ Row ${row.rowIndex}: ${blockedPrefix} (retry ${blockedRetries}/${MAX_BLOCKED_RETRIES}) — reopening ChatGPT and resending...`);
            attemptsLeft = Math.max(attemptsLeft, 1);
          }
        } else {
          console.log(`   ❌ Row ${row.rowIndex} failed: ${err.message}${attemptsLeft > 0 ? ' — retrying...' : ' — giving up on this row.'}`);
        }
      }
    }

    if (!rowOk) failed++;
  }

  console.log(`\n[BLOG GEN] Pass complete: ${generated} generated, ${failed} failed, out of ${rows.length}.`);
  await finishRun(dashboardRunId, {
    status: generated > 0 ? (failed > 0 ? 'WARNING' : 'SUCCESS') : 'FAILED',
    executionQuality: generated > 0 ? 'REAL_EXECUTION' : 'NO_EXECUTION',
    metrics: { blogs_attempted: rows.length, blogs_generated: generated, blogs_failed: failed },
  });
  return { attempted: rows.length, generated, failed };
}

/**
 * Continuous loop — generate a pass, wait `intervalSeconds`, repeat forever.
 * Meant to be run as its own long-lived process (see src/index.ts's
 * "run-blog-gen-loop" mode), not called from inside the cron daemon.
 */
export async function runBlogGenLoop(opts: BlogGenBatchOptions & { intervalSeconds?: number } = {}): Promise<void> {
  const intervalSeconds = opts.intervalSeconds ?? 1800; // 30 min default
  console.log(`[BLOG GEN] Starting continuous loop (checking every ${intervalSeconds}s)...`);
  for (;;) {
    try {
      await runBlogGenBatch(opts);
    } catch (err: any) {
      console.log(`[BLOG GEN] Pass errored: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
  }
}
