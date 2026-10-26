/**
 * Final-blog mode: runs the REAL supervised pipeline for one report and saves the finished article locally.
 *
 *   npm run blog:final -- --structure=f-regulatory-explainer [--url=<report url> --title=<market>] [--with-cover] [--no-review] [--show-browser]
 *
 * Same flow as `blog:run` (evidence gate, structure, ChatGPT writes, Hermes draft gate with same-chat retries, snapshot
 * and landscape images, preferred-source CTA, final gate), but nothing is written to the Sheet and nothing is uploaded
 * to Google Drive. Images are rendered to local PNG files and the article points at them, so final.html shows the blog
 * the way it would look once published.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig } from '../../../src/config/index.js';
import { openBlogChatSession, type BlogGenResult } from '../../src/agents/blogGenAgent.js';
import { generateCoverImageLocalOnly } from '../../src/agents/blogImageAgent.js';
import { buildLandscapeHtml, parseLandscapeData } from '../../src/agents/blogLandscapeImageAgent.js';
import { applyPreferredSourceCTA, validatePreferredSourceCTA } from '../../src/agents/blogPreferredSourceAgent.js';
import { normalizeImgTags } from '../../src/agents/blogSanityAgent.js';
import { buildSnapshotHtml, findHeroMetrics, parseSnapshotMetrics } from '../../src/agents/blogSnapshotImageAgent.js';
import { describeStructure, STRUCTURE_CATALOG } from '../../src/agents/blogStructures.js';
import { injectCoverImage, injectSnapshotImage, injectSnapshotImage2, PREFERRED_SOURCE_MODE } from '../../src/coordinator/blogGenLoop.js';
import { gatherBlogEvidence } from './evidence.js';
import { formatMeasurements, measureBlog } from './measure.js';
import { processBlogRow, type BlogRowDeps } from './orchestrator.js';
import { PREVIEW_CSS, resolveTarget } from './sample.js';
import { BlogLedger, BlogStateStore } from './state.js';
import { BlogLimits, BlogSupervisor, createBlogHermesAsk, loadBlogRole, type HermesAsk } from './supervisor.js';

export const FINAL_ROOT = path.resolve('output/blog-final');

export interface FinalOptions {
  structure: string;
  url?: string;
  title?: string;
  /** Skip the Hermes gates (every gate proceeds); code's structural checks still apply. */
  noReview: boolean;
  /** Also generate the cover image through ChatGPT (account2), saved locally. */
  withCover: boolean;
  blogAccount?: string;
  imageAccount?: string;
}

async function renderPng(html: string, viewport: { width: number; height: number }, outPath: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.evaluate(() => (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready).catch(() => {});
    await page.locator('.card').first().screenshot({ path: outPath });
  } finally {
    await browser.close();
  }
}

/**
 * Everything between an approved draft and the finished article, kept local: render the snapshot and landscape images to
 * PNG files, point the article at them, add the cover image if there is one, normalise the image tags and add the
 * preferred-source CTA. Same order as the live pipeline, minus the Google Drive upload.
 */
/** Renders the snapshot and landscape PNGs from the article's metric blocks. Returns which of the two could be drawn. */
export async function renderLocalImages(
  blog: Pick<BlogGenResult, 'imageData' | 'imageData2' | 'seoTitle'>,
  title: string,
  imgDir: string,
  note: (summary: string) => unknown = () => {},
): Promise<{ snapshot: boolean; landscape: boolean }> {
  await mkdir(imgDir, { recursive: true });
  const marketName = blog.seoTitle || title;
  const metrics = parseSnapshotMetrics(blog.imageData);
  let snapshot = false;
  let landscapeDrawn = false;
  if (metrics.length > 0) {
    await renderPng(buildSnapshotHtml(marketName, metrics), { width: 900, height: 2600 }, path.join(imgDir, 'snapshot.png'));
    snapshot = true;
    await note(`snapshot image rendered (${metrics.length} metrics)`);
  } else await note('no snapshot metrics returned, so no snapshot image');
  const hero = findHeroMetrics(metrics);
  const landscape = parseLandscapeData(blog.imageData2);
  if ((hero.base && hero.forecast) || landscape.drivers.length || landscape.competitive.length || landscape.regions.length) {
    await renderPng(buildLandscapeHtml(marketName, hero, landscape), { width: 900, height: 1400 }, path.join(imgDir, 'landscape.png'));
    landscapeDrawn = true;
    await note(`landscape image rendered (drivers ${landscape.drivers.length}, competitive ${landscape.competitive.length}, competitor names ${landscape.competitiveNames?.length ?? 0}, regions ${landscape.regions.length})`);
  } else await note('no landscape data returned, so no second image');
  return { snapshot, landscape: landscapeDrawn };
}

/**
 * Quick test: redraw the two images of an earlier `blog:final` run with the current image code, without regenerating the
 * article. The article already points at images/snapshot.png and images/landscape.png, so final.html shows the new ones
 * as soon as you refresh it. Needs no ChatGPT and no Hermes.
 */
export async function rerenderImages(folderArg: string): Promise<string> {
  const dir = path.isAbsolute(folderArg) ? folderArg : path.join(FINAL_ROOT, folderArg);
  let det: string;
  try {
    det = await readFile(path.join(dir, 'deliverable.txt'), 'utf8');
  } catch {
    throw new Error(`No deliverable.txt in ${dir}. Pass the name of a folder under output/blog-final (for example the one printed by a previous blog:final run).`);
  }
  const section = (label: string, next: string): string => {
    const start = det.indexOf(`${label}\n`);
    if (start < 0) return '';
    const rest = det.slice(start + label.length + 1);
    const end = next ? rest.indexOf(`\n\n${next}`) : -1;
    return (end >= 0 ? rest.slice(0, end) : rest).trim();
  };
  const blog = {
    seoTitle: section('SEO TITLE', 'META DESCRIPTION'),
    imageData: section('KEY SNAPSHOT METRICS', 'IMAGE 2 INSIGHTS'),
    imageData2: section('IMAGE 2 INSIGHTS', ''),
  };
  const drawn = await renderLocalImages(blog, blog.seoTitle, path.join(dir, 'images'), (m) => console.log(`  ${m}`));
  const out = [
    `[FINAL] Images redrawn in ${path.join(dir, 'images')} (snapshot: ${drawn.snapshot ? 'yes' : 'no data'}, landscape: ${drawn.landscape ? 'yes' : 'no data'}).`,
    `[FINAL] Refresh the final blog in your browser (Ctrl+F5):\n${pathToFileURL(path.join(dir, 'final.html')).href}`,
  ].join('\n');
  console.log(out);
  return out;
}

export async function assembleLocal(blog: BlogGenResult, title: string, coverImagePath: string, imgDir: string, note: (summary: string) => unknown = () => {}): Promise<string> {
  let html = blog.html;
  const drawn = await renderLocalImages(blog, title, imgDir, note);
  if (drawn.snapshot) html = injectSnapshotImage(html, 'images/snapshot.png');
  if (drawn.landscape) html = injectSnapshotImage2(html, 'images/landscape.png');
  if (coverImagePath) {
    html = injectCoverImage(html, `images/${path.basename(coverImagePath)}`);
    await note('cover image added at the top');
  }
  html = normalizeImgTags(html, { title: blog.title || title }).html;
  // Any placeholder that could not be filled is dropped, as in the live pipeline.
  html = html.replace(/<img\s+src='YOUR_IMAGE_URL_HERE[^']*'\s*>\s*\n?/gi, '');
  const preferred = applyPreferredSourceCTA(html, { mode: PREFERRED_SOURCE_MODE, title: blog.title || title });
  const check = validatePreferredSourceCTA(preferred.html, PREFERRED_SOURCE_MODE);
  await note(`preferred-source CTA ${preferred.applied ? `inserted (${preferred.placement})` : `skipped (${preferred.placement})`}${check.status === 'PASS' ? '' : `; ${check.issues.join(' | ')}`}`);
  return preferred.html;
}

/** A reviewer that approves every gate. Used only with --no-review. */
const approveAll: HermesAsk = async (prompt) => {
  const gate = /## GATE\n(\w+)/.exec(prompt)?.[1] ?? 'draft';
  return JSON.stringify({ gate, action: 'proceed', reason: 'Hermes review skipped (--no-review); code checks still apply.', concerns: [] });
};

export async function runFinal(opts: FinalOptions): Promise<string> {
  if (opts.structure !== 'v1.3' && !describeStructure(opts.structure)) {
    throw new Error(`Unknown structure "${opts.structure}". Use v1.3 or one of: ${STRUCTURE_CATALOG.map((s) => s.id).join(', ')}`);
  }
  const target = await resolveTarget({ ...(opts.url ? { url: opts.url } : {}), ...(opts.title ? { title: opts.title } : {}) });
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const runDir = path.join(FINAL_ROOT, `${stamp}-${opts.structure}`);
  const imgDir = path.join(runDir, 'images');
  await mkdir(imgDir, { recursive: true });

  const config = loadConfig();
  const limits = new BlogLimits();
  const supervisor = new BlogSupervisor(opts.noReview ? approveAll : createBlogHermesAsk(), loadBlogRole(), limits);
  const ledger = new BlogLedger(runDir, 'run', (line) => console.log(line));
  const store = new BlogStateStore(path.join(runDir, 'state'));
  console.log(`[FINAL] ${opts.structure} on "${target.title}"${opts.noReview ? ' (Hermes review skipped)' : ''}\n[FINAL] Output folder: ${runDir}`);

  let finalHtml = '';
  let finalBlog: BlogGenResult | undefined;

  const deps: BlogRowDeps = {
    supervisor, limits, ledger, store,
    evidence: (input) => gatherBlogEvidence(input, { config }),
    openChat: (p) => openBlogChatSession({
      title: p.title, url: p.url, structure: p.structure,
      ...(p.promptSuffix ? { promptSuffix: p.promptSuffix } : {}),
      ...(opts.blogAccount ? { accountHandle: opts.blogAccount } : {}),
    }),
    ...(opts.withCover
      ? {
          cover: async ({ title, url }: { title: string; url: string }) => ({
            url: await generateCoverImageLocalOnly({ marketName: title, reportUrl: url, promptChoice: '1', outputDir: imgDir, ...(opts.imageAccount ? { accountHandle: opts.imageAccount } : {}) }),
          }),
        }
      : {}),
    finishArticle: ({ blog, title, coverImageUrl }) => assembleLocal(blog, title, coverImageUrl, imgDir, (summary) => ledger.append('assemble', { summary }).catch(() => {})),
    save: async (_row, data) => { finalHtml = data.html; finalBlog = data.blog; },
    verify: async () => ({ ok: true }),
    structureMode: opts.structure,
  };

  const result = await processBlogRow({ rowIndex: 1, title: target.title, targetUrl: target.url }, deps);
  await writeFile(path.join(runDir, 'decisions.json'), JSON.stringify(result, null, 2), 'utf8');

  if (result.status !== 'written' || !finalBlog) {
    const out = `\n[FINAL] No final blog was produced: ${result.status}. ${result.reason}\n[FINAL] Gate decisions: ${path.join(runDir, 'decisions.json')}`;
    console.log(out);
    return out;
  }

  const evidence = await gatherBlogEvidence({ url: target.url, title: target.title }, { config });
  const m = measureBlog({ html: finalHtml, seoTitle: finalBlog.seoTitle, metaDescription: finalBlog.description, primaryUrl: evidence.finalUrl, evidenceText: evidence.evidenceText });
  const esc = (s: string) => s.replace(/</g, '&lt;');
  const gateLines = result.gates.map((g) => `${g.gate}: ${g.action}`).join(' | ');
  const page =
    `<!doctype html><meta charset="utf-8"><title>${esc(finalBlog.seoTitle)}</title><style>${PREVIEW_CSS}</style>` +
    `<div class="meta"><b>FINAL BLOG</b> (${result.structure})<br>SEO title: ${esc(finalBlog.seoTitle)}<br>Meta: ${esc(finalBlog.description)}<br>${m.words} words, ${m.headings.h2} H2, ${m.images} images<br>Hermes gates: ${esc(gateLines)}</div>` +
    finalHtml;
  await writeFile(path.join(runDir, 'final.html'), page, 'utf8');
  await writeFile(path.join(runDir, 'article-final.html'), finalHtml, 'utf8');
  await writeFile(path.join(runDir, 'measurements.txt'), formatMeasurements(m), 'utf8');
  await writeFile(path.join(runDir, 'deliverable.txt'), `SEO TITLE\n${finalBlog.seoTitle}\n\nMETA DESCRIPTION\n${finalBlog.description}\n\nKEY SNAPSHOT METRICS\n${finalBlog.imageData}\n\nIMAGE 2 INSIGHTS\n${finalBlog.imageData2}\n`, 'utf8');

  const out = [
    `\n[FINAL] Done: ${m.words} words, ${m.headings.h2} H2, ${m.images} images. Gates: ${gateLines}`,
    `[FINAL] Open the final blog in your browser:\n${pathToFileURL(path.join(runDir, 'final.html')).href}`,
  ].join('\n');
  console.log(out);
  return out;
}

