/**
 * blogGenAgent.ts — generate a full blog article by driving the user's own
 * logged-in ChatGPT session (not an API call). ChatGPT does its own research
 * against the report URL, verifies its data, and assembles a publication-ready
 * article per the master SERP/AI-citation prompt below.
 *
 * Generation takes ~12-15 minutes per article — this is not a fast path.
 *
 * Launches its OWN persistent Chrome context per call (does not go through
 * browser/chatgpt/login.ts's shared single-browser singleton) — that's what
 * lets this run at the same time as blogImageAgent.ts's cover-image
 * generation in a second, independent Chrome window, instead of the two
 * fighting over one shared browser/page.
 *
 * Usage:
 *   const result = await generateBlogViaChatGpt({ title: row.title, url: row.targetUrl });
 *   // result: { title, description, html }
 */

import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { sessionDirForAccount } from '../config/chatGptAccountTracker.js';
import { killChromeForProfile } from '../utils/killChrome.js';
import { pasteIntoChatGptComposer, attachPromptAsTextFile, dismissBlockingModals } from '../utils/chatgptComposer.js';
import { recordChatGptFailure, recordChatGptSuccess } from '../config/chatGptAccountTracker.js';
import { injectUTM, UTM_PARAMS } from '../utils/utm.js';

// Matches both the old #prompt-textarea id and the new UI's bare
// div.ProseMirror composer (no id) — see the comment on the canonical
// definition in src/browser/chatgpt/login.ts for the full explanation.
const COMPOSER_SELECTOR = '#prompt-textarea, div[contenteditable="true"].ProseMirror';
const SEND_BUTTON_SELECTOR = 'button[data-testid="send-button"], button[aria-label="Send prompt"]';
const STOP_BUTTON_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop streaming"], button[aria-label*="Stop"]';
// ChatGPT's UI redesign (confirmed live 2026-09-26) dropped the
// data-message-author-role attribute entirely — the assistant's rendered
// markdown now lives in a div[data-markdown-text-style="assistant-message"]
// instead, found by walking up from a live "PONG" test reply. Match both,
// comma-separated, same as COMPOSER_SELECTOR above.
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]';

// Blog TEXT generation now shares the same ChatGPT account/session as the
// LI carousel image generator (socialPostImageAgent.ts's DEFAULT_ACCOUNT) —
// both resolve through sessionDirForAccount('social-image'), same session
// folder. Kept separate from blogImageAgent.ts's own default account (below)
// so blog text + cover image still run in separate Chrome profiles/windows
// concurrently; login once via: npx tsx src/tools/loginChatGpt.ts social-image
const DEFAULT_BLOG_ACCOUNT = 'social-image';

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Blog generation is slow (~5-15 min, varies) — no way to know in advance
// how long a given article will take, so just poll once a minute and stop
// as soon as completion is detected, capped at MAX_POLLS as a hard ceiling.
const POLL_MS = 60 * 1000; // check every 1 min
const MAX_POLLS = 15; // 15 checks * 1 min = 15 min total hard cap

/**
 * Ken Research Market Blog Master Prompt V1.3 is the only blog prompt. It lives in
 * browser-generation/prompts/blog-generation/01-master-v1.3-live.txt (edit that file to change the prompt);
 * {{REPORT_TITLE}} / {{REPORT_URL}} are filled in here. There is no built-in fallback: a missing or empty
 * file stops generation so a stale prompt is never sent silently.
 */
const MASTER_PROMPT_FILE = path.resolve('browser-generation/prompts/blog-generation/01-master-v1.3-live.txt');
export function buildMasterBlogPrompt(reportTitle: string, reportUrl: string): string {
  const tpl = fs.readFileSync(MASTER_PROMPT_FILE, 'utf-8');
  if (tpl.trim().length < 1000) {
    throw new Error(`${MASTER_PROMPT_FILE} is empty or too short; refusing to send an incomplete master prompt`);
  }
  return tpl.replace(/\{\{REPORT_TITLE\}\}/g, reportTitle).replace(/\{\{REPORT_URL\}\}/g, reportUrl);
}

// ChatGPT's rate-limit / session-nudge popups can appear at any point during
// the ~12-15 min generation, not just at the fixed checkpoints
// dismissBlockingModals() covers (before typing, before sending). A generic
// dialog/overlay is detected by role, then Enter is pressed to dismiss it —
// repeated until it's actually gone (not a fixed count), since some ChatGPT
// dialogs re-render themselves once after the first dismissal.
const GENERIC_POPUP_SELECTOR = '[role="dialog"], [role="alertdialog"]';
const MAX_POPUP_DISMISS_ATTEMPTS = 8;

async function popupPresent(page: Page): Promise<boolean> {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const style = window.getComputedStyle(el as Element);
    return style.display !== 'none' && style.visibility !== 'hidden' && (el as HTMLElement).offsetParent !== null;
  }, GENERIC_POPUP_SELECTOR).catch(() => false);
}

/** Keep pressing Enter for as long as a popup keeps showing up (capped so a stuck dialog can't hang generation forever). */
async function clearPopups(page: Page): Promise<void> {
  for (let i = 0; i < MAX_POPUP_DISMISS_ATTEMPTS; i++) {
    await dismissBlockingModals(page);
    if (!(await popupPresent(page))) return;
    console.log(`   [blog] Popup detected — pressing Enter to dismiss (attempt ${i + 1}/${MAX_POPUP_DISMISS_ATTEMPTS})...`);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(600);
  }
}

const POPUP_WATCHER_INTERVAL_MS = 1500;

/**
 * Runs dismissBlockingModals() on its own short cycle for the ENTIRE
 * lifetime of the ChatGPT tab — independent of waitForBlogCompletion's
 * 60s poll (POLL_MS), which also doesn't run at all during its first fixed
 * 5-minute wait. Popups (rate-limit/session-nudge/upgrade dialogs) can
 * reappear within seconds and block typing/streaming until dismissed;
 * confirmed live 2026-09-16 that the previous once-a-minute-at-best checking
 * left them sitting long enough to need a manual click. Call the returned
 * stop function in a `finally` so this never outlives the page/context.
 */
function startContinuousPopupWatcher(page: Page): () => void {
  let stopped = false;
  (async () => {
    while (!stopped) {
      await dismissBlockingModals(page).catch(() => {});
      await page.waitForTimeout(POPUP_WATCHER_INTERVAL_MS);
    }
  })().catch(() => {});
  return () => { stopped = true; };
}

/** Wait until the assistant response finished streaming (send re-enabled, text stable). */
async function waitForBlogCompletion(page: Page): Promise<void> {
  const start = Date.now();
  let goneChecks = 0;
  let lastLength = -1;
  let unchangedChecks = 0;
  let tinyStallChecks = 0;
  // Generation takes anywhere from ~5 to ~15 min with no way to know in
  // advance — so just wait 1 min, check, repeat, up to MAX_POLLS times
  // (~15 min total), instead of guessing a blind upfront wait.
  for (let poll = 1; poll <= MAX_POLLS; poll++) {
    await page.waitForTimeout(POLL_MS);
    await clearPopups(page);
    const stopping = await page.locator(STOP_BUTTON_SELECTOR).first().isVisible({ timeout: 2000 }).catch(() => false);
    const text = await lastAssistantText(page);
    console.log(`   …check ${poll}/${MAX_POLLS} at ${Math.round((Date.now() - start) / 60000)} min: ${stopping ? 'still writing' : 'looks finished'} (${text.length} characters so far)`);
    if (!stopping && text.length > 500) {
      goneChecks++;
      if (goneChecks >= 2) return; // Stop button gone for ~2 checks → done
    } else {
      goneChecks = 0;
    }
    // Second, independent completion signal: the Stop-button check can get
    // stuck reporting "still writing" (a UI glitch) even though generation
    // actually finished. If the character count is IDENTICAL for 3 checks in
    // a row, treat that as done regardless of what the Stop button says.
    if (text.length > 500 && text.length === lastLength) {
      unchangedChecks++;
      if (unchangedChecks >= 3) {
        console.log('   Character count unchanged for 3 checks in a row — treating as finished.');
        return;
      }
    } else {
      unchangedChecks = 0;
    }
    // Stalled/dead generation: the response isn't actively streaming
    // ("looks finished") but is far too short to be a real 1,450-1,600 word
    // article, and its length hasn't moved between checks. Without this,
    // a response stuck at e.g. 55 characters never crosses the 500-char
    // threshold above, so neither completion branch fires and this just
    // polls uselessly for the full 30-minute timeout before failing. Fail
    // fast instead — the caller's own per-row retry (see blogGenLoop.ts)
    // already retries once and then moves on to the next row.
    if (!stopping && text.length > 0 && text.length < 500 && text.length === lastLength) {
      tinyStallChecks++;
      if (tinyStallChecks >= 2) {
        throw new Error(`STALLED: ChatGPT response stuck at ${text.length} characters across 2 consecutive checks — treating as a dead generation instead of waiting out the full timeout.`);
      }
    } else {
      tinyStallChecks = 0;
    }
    lastLength = text.length;
  }
}

async function lastAssistantText(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const msgs = document.querySelectorAll(sel);
    let text = msgs.length ? ((msgs[msgs.length - 1] as HTMLElement).innerText || '') : '';
    if (text.replace(/\s/g, '').length < 100) {
      const body = (document.body as HTMLElement).innerText || '';
      const idx = body.lastIndexOf('Title:');
      if (idx >= 0) text = body.slice(idx);
    }
    return text;
  }, ASSISTANT_MESSAGE_SELECTOR);
}

/** Extract Title / Description / HTML from the last assistant message (both code-block and raw-HTML shapes). */
// Section labels the V1.3 prompt's "Return exactly:" list produces, in order
// — used to slice ChatGPT's structured reply into SEO Title / Meta
// Description / Key Snapshot Metrics / FINAL ARTICLE HTML.
const SECTION_LABELS = [
  'SEO Title', 'Meta Description', 'Primary Search Intent', 'Primary Keyword',
  'Secondary Semantic Topics', 'Suggested Snapshot Image Alt',
  'Key Snapshot Metrics for Image', 'Key Qualitative Insights for Image 2',
  'Internal Link Map', 'External Source Map',
  'FINAL ARTICLE',
];

/** Pull the plain-text block between a standalone `label` line and the next known section label (or end of text). */
function extractLabeledSection(text: string, label: string): string {
  const lines = text.split('\n');
  const norm = (s: string) => s.trim().toLowerCase();
  const startIdx = lines.findIndex((l) => norm(l) === norm(label));
  if (startIdx === -1) return '';
  const otherLabels = new Set(SECTION_LABELS.filter((l) => l !== label).map(norm));
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (otherLabels.has(norm(lines[i]))) { endIdx = i; break; }
  }
  return lines.slice(startIdx + 1, endIdx).map((l) => l.trim()).filter(Boolean).join('\n').trim();
}

export interface BlogGenResult {
  title: string;
  description: string;
  html: string;
  seoTitle: string;
  imageData: string;
  /** Raw "Key Qualitative Insights for Image 2" block — Growth Drivers / Competitive Landscape / Regional Landscape — feeds blogLandscapeImageAgent.ts's second mid-blog image. */
  imageData2: string;
}

// The prompt is delivered to ChatGPT as an attached file named
// "chatgpt-prompt-<timestamp>-blog-prompt.txt" (see attachPromptAsTextFile).
// ChatGPT then renders a "file citation" pill for that attachment inside its
// reply — as VISIBLE text, truncated by the UI, e.g.
// "chatgpt-prompt-1790724820272-bl…" — which landed glued onto the end of the
// SEO Title (confirmed 2026-10-05). CITATION_CHIP_RE only knows web-domain
// pills, so this one slipped through. Match the SHAPE (fixed prefix + long
// timestamp + any filename remainder, with or without the UI's ellipsis).
const FILE_PILL_RE = /\s*chatgpt-prompt-\d{6,}-[^\s<>"']*…?/gi;
function stripFilePill(s: string): string {
  return s.replace(FILE_PILL_RE, (m) => {
    console.warn(`   ⚠️  Stripped a ChatGPT file-attachment pill from generated text: "${m.trim()}"`);
    return '';
  }).trim();
}

async function extractBlog(page: Page, fallbackTitle: string): Promise<BlogGenResult> {
  const data = await page.evaluate((sel) => {
    const msgs = document.querySelectorAll(sel);
    const last = msgs.length ? (msgs[msgs.length - 1] as HTMLElement) : null;
    let code = '';
    let text = last ? (last.innerText || '') : '';
    if (last) { const c = last.querySelector('pre code, pre'); code = c ? (c.textContent || '') : ''; }
    if (text.replace(/\s/g, '').length < 100) {
      const body = (document.body as HTMLElement).innerText || '';
      const idx = body.lastIndexOf('SEO Title');
      if (idx >= 0) text = body.slice(idx);
    }
    return { code, text };
  }, ASSISTANT_MESSAGE_SELECTOR);

  const text = data.text || '';
  const stripTags = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  // ChatGPT's web-search citation pills (a bare domain, optionally followed
  // by "+N" for "and N more sources") render as literal visible text in the
  // chat UI wherever a citation lands — including, confirmed live
  // 2026-09-18, right after the SEO Title and inside the Key Snapshot
  // Metrics list, contaminating both the plain-text title and the
  // downstream chart data with garbage like "kenresearch.com +1".
  const CITATION_CHIP_RE = /\s*(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\s*\+\d+)?\s*$/i;
  const stripCitationChip = (s: string) => stripFilePill(s).replace(CITATION_CHIP_RE, '').trim();
  const isCitationChipLine = (s: string) => /^(?:(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\s*\+\d+)?|\+\d+)$/i.test(s.trim());

  // V1.3 prompt structured deliverable: SEO Title, Meta Description, ...,
  // Key Snapshot Metrics for Image, Internal Link Map, External Source Map,
  // then "FINAL ARTICLE" followed by the publication-ready HTML. These two
  // fields are plain-text metadata — strip any literal "<strong>" etc. that
  // ChatGPT sometimes carries over from the article's bolding rules (its
  // chat UI shows raw HTML as visible text, not live tags, so it leaks
  // straight into these strings if not stripped here).
  const seoTitle = stripCitationChip(stripTags(extractLabeledSection(text, 'SEO Title')));
  const metaDescription = stripCitationChip(stripTags(extractLabeledSection(text, 'Meta Description')));
  // Strip the "5–7 supported metrics" sub-label ChatGPT sometimes echoes as
  // the first line of this section (a prompt instruction, not a metric),
  // and drop any line that's nothing but a leaked citation chip.
  const imageData = extractLabeledSection(text, 'Key Snapshot Metrics for Image')
    .replace(/^\d[\s\S]{0,4}\d?\s*supported metrics\s*\n?/i, '')
    .split('\n')
    .filter((l) => !isCitationChipLine(l))
    .map((l) => stripCitationChip(l))
    .join('\n')
    .trim();

  const imageData2 = extractLabeledSection(text, 'Key Qualitative Insights for Image 2')
    .split('\n')
    .filter((l) => !isCitationChipLine(l))
    .map((l) => stripCitationChip(l))
    .join('\n')
    .trim();

  // Only search for the HTML fragment from the "FINAL ARTICLE" marker
  // onward — everything before it (SEO Title, link maps, source maps) is
  // plain text/metadata, not the article, and must never be mistaken for it.
  const finalArticleIdx = text.search(/^\s*FINAL ARTICLE\s*$/im);
  const htmlSearchText = finalArticleIdx >= 0 ? text.slice(finalArticleIdx) : text;

  let html = '';
  if (data.code && data.code.includes('<')) {
    html = data.code.trim();
  } else {
    // Raw HTML in the message text: from the first tag to the last tag (drops
    // any trailing page chrome like "ChatGPT can make mistakes" / "Sources").
    const firstTag = htmlSearchText.indexOf('<');
    html = firstTag >= 0 ? htmlSearchText.slice(firstTag) : htmlSearchText;
    const lastTag = html.lastIndexOf('>');
    if (lastTag >= 0) html = html.slice(0, lastTag + 1);
    html = html.trim();
  }

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const firstPMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const blogTitle = h1Match ? stripFilePill(stripTags(h1Match[1])) : (seoTitle || fallbackTitle);
  const description = metaDescription || (firstPMatch ? stripTags(firstPMatch[1]).slice(0, 170) : '');

  return { title: blogTitle, description, html, seoTitle: seoTitle || blogTitle, imageData, imageData2 };
}

// A popup can still land exactly while extractBlog() reads the DOM (race
// between the poll loop above and the modal re-rendering). Clear popups,
// extract, clear again, and repeat until two consecutive extractions agree
// on HTML length — protects against a mid-scrape popup silently truncating
// the extracted HTML.
const MAX_EXTRACTION_STABILITY_CHECKS = 4;

async function extractBlogStable(page: Page, fallbackTitle: string): Promise<BlogGenResult> {
  let last: BlogGenResult | null = null;
  let previousLen = -1;

  for (let i = 0; i < MAX_EXTRACTION_STABILITY_CHECKS; i++) {
    await clearPopups(page);

    last = await extractBlog(page, fallbackTitle);
    const len = last.html.length;
    console.log(`   [blog] Extraction check ${i + 1}/${MAX_EXTRACTION_STABILITY_CHECKS}: ${len} chars`);

    await clearPopups(page);

    if (len > 0 && len === previousLen) {
      console.log('   [blog] Char count stable across checks — accepting extraction.');
      return last;
    }
    previousLen = len;
  }

  console.log(`   [blog] Char count did not fully stabilize after ${MAX_EXTRACTION_STABILITY_CHECKS} checks — using last extraction anyway.`);
  return last!;
}

/** Fix ChatGPT quirks: mis-encoded closing quotes (%22) and web-search citation tags. */
function sanitizeHtml(html: string): string {
  return html
    .replace(/%22(?=[\s>])/g, '"')   // closing attribute quote emitted as %22
    .replace(/%22$/g, '"')
    // ChatGPT occasionally wraps an href/src URL in its OWN extra pair of
    // quotes on top of the real attribute quotes — e.g.
    // href=""https://...automation"" — which breaks the link entirely
    // (confirmed live 2026-09-18). Collapse the doubled quote down to one.
    .replace(/(href|src)="{2,}(https?:\/\/[^"]+?)"{2,}/gi, '$1="$2"')
    // ChatGPT's internal tool/citation markup (web-search citations, and
    // whatever else it may emit) always has the same underlying shape:
    // "[:]word-word[optional-bracket-part]{...index...}" — e.g. the old
    // ":contentReference[oaicite:0]{index=0}", a renamed variant confirmed
    // live 2026-09-28, ":chatgpt-content-reference{index=\"9\"}", and a
    // THIRD variant confirmed live 2026-09-29 that drops the leading colon
    // entirely: "chatgpt-content-reference{index=\"9\"}" — the original
    // regex required that colon and let this one straight through into
    // published content. Matching each exact name is whack-a-mole — ChatGPT
    // keeps changing the exact spelling — so this matches the SHAPE instead:
    // an optional leading colon, a hyphenated identifier, an optional
    // bracket part, and a brace group that contains "index" (real prose
    // never contains a literal "word{index...}" token, colon or not).
    // Logs each strip so a genuinely new artifact shape gets noticed, not
    // silently swallowed forever.
    .replace(/\s*:?[\w-]+(?:\[[^\]]*\])?\{[^}]*index[^}]*\}/gi, (match) => {
      console.warn(`   ⚠️  Stripped a ChatGPT tool-markup artifact from generated HTML: "${match.trim()}"`);
      return '';
    })
    // File-attachment citation pill for the attached prompt file (see FILE_PILL_RE).
    .replace(FILE_PILL_RE, '')
    .trim();
}

/**
 * Ensure every kenresearch.com link carries the correct UTM params — strips
 * whatever ChatGPT wrote and rebuilds fresh with the LinkedIn Pulse UTM
 * (matches every platform poster's own injectUTM call downstream, so this is
 * really just what shows up before any platform-specific posting overrides it).
 */
function injectBlogUtm(html: string): string {
  return injectUTM(html, UTM_PARAMS.LinkedinPulse);
}

async function isLoggedIn(page: Page): Promise<boolean> {
  return page.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
}

// Minimizes the window to the taskbar (not headless — the account still needs
// a real, logged-in-looking browser) via CDP; '--start-minimized' alone is
// unreliable once the page has already navigated. Best-effort — a failure
// here should never abort generation.
async function minimizeToTaskbar(context: BrowserContext, page: Page): Promise<void> {
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await (cdp as any).send('Browser.getWindowForTarget');
    await (cdp as any).send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore if CDP unavailable */ }
}

// Diagnostic only — never blocks for a manual login and never aborts the
// run. These generate scripts run unattended under the cron daemon, where
// nobody is watching to log in by hand, so the old 120s manual-login wait
// just stalled the batch before failing anyway.
async function logChatGptSessionState(page: Page): Promise<void> {
  console.log(await isLoggedIn(page)
    ? '   ✅ ChatGPT: session active (composer visible)'
    : '   ⚠️  ChatGPT: composer not visible — continuing anyway (session may be expired)');
}

/**
 * Generate one blog article via the user's own logged-in ChatGPT session.
 * Launches its own persistent Chrome context (session dir per account),
 * sends the master prompt, waits ~12-15 min, extracts and sanitizes the
 * result, then closes that context. Throws on failure so the caller can
 * retry/skip. Independent of blogImageAgent.ts's browser — safe to run both
 * concurrently via Promise.all.
 */
export async function generateBlogViaChatGpt(params: {
  title: string;
  url: string;
  accountHandle?: string;
}): Promise<BlogGenResult> {
  const accountName = params.accountHandle || DEFAULT_BLOG_ACCOUNT;
  const sessionDir = sessionDirForAccount(accountName);
  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  const chromePath = fs.existsSync(CHROME_PATH) ? CHROME_PATH : chromium.executablePath();
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1366, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      // Match the OS window size to the viewport — otherwise Chrome opens
      // at a mismatched size and the page renders skewed/zoomed with parts
      // cut off, before minimizeToTaskbar() below hides it anyway.
      '--window-size=1366,900',
      '--window-position=0,0',
    ],
  });

  let stopPopupWatcher: () => void = () => {};
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await minimizeToTaskbar(context, page);
    await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    await logChatGptSessionState(page);

    stopPopupWatcher = startContinuousPopupWatcher(page);

    const prompt = buildMasterBlogPrompt(params.title, params.url);
    console.log(`   [blog:${accountName}] Sending blog prompt (master V1.3) for: "${params.title}" (~12-15 min generation)...`);
    // The master prompt is ~45-50k characters — long enough that a clipboard
    // paste unreliably lands as either composer text or an auto-converted
    // file attachment (confirmed live, see attachPromptAsTextFile's doc
    // comment). Attach it as a real .txt file directly instead.
    //
    // Without an explicit instruction, ChatGPT treats a bare file attachment
    // conversationally — it reads the file, summarizes what it calls for,
    // and asks "If you want, I can execute the full prompt now" instead of
    // just doing it (confirmed live 2026-09-28). This instruction forces
    // immediate execution with zero commentary.
    await attachPromptAsTextFile(page, prompt, {
      filename: 'blog-prompt.txt',
      instruction: 'Execute the attached prompt file exactly and immediately. Do not summarize it, do not describe what it calls for, and do not ask for confirmation — just produce the full deliverable it specifies, starting with "SEO Title", right now.',
    });
    await page.waitForTimeout(1000);

    // The blocking modal can re-render itself seconds after being removed —
    // check again right before the send click, not just once before typing.
    await dismissBlockingModals(page);
    const sendBtn = page.locator(SEND_BUTTON_SELECTOR).first();
    async function clickSend(): Promise<boolean> {
      if (!(await sendBtn.isVisible({ timeout: 3000 }).catch(() => false))) return false;
      await sendBtn.click();
      return true;
    }

    // A click (or Enter fallback) can silently no-op — confirmed live
    // 2026-09-28: right after attachPromptAsTextFile, the file was still
    // finishing its upload/processing when the click fired, so the whole
    // prompt sat unsent in the composer while waitForBlogCompletion below
    // burned through its full ~15-min poll budget seeing 0 characters the
    // entire time. Verify the send actually registered — the Stop button or
    // a new assistant message appearing — before committing to that long
    // wait, and retry a few times if it didn't.
    async function trySendAndConfirm(): Promise<boolean> {
      if (!(await clickSend())) await page.keyboard.press('Enter').catch(() => {});
      return await Promise.race([
        page.locator(STOP_BUTTON_SELECTOR).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false),
        page.locator(ASSISTANT_MESSAGE_SELECTOR).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false),
      ]);
    }

    let sent = false;
    const MAX_SEND_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS && !sent; attempt++) {
      await dismissBlockingModals(page);
      sent = await trySendAndConfirm();
      if (!sent && attempt < MAX_SEND_ATTEMPTS) {
        console.log(`   [blog:${accountName}] ⚠️ Send did not register (attempt ${attempt}/${MAX_SEND_ATTEMPTS}) — retrying...`);
        await page.waitForTimeout(2000);
      }
    }
    if (!sent) {
      throw new Error('SEND_NOT_CONFIRMED: Could not confirm the blog prompt was actually sent after 3 attempts (no Stop button or assistant message appeared).');
    }

    await waitForBlogCompletion(page);
    console.log(`   [blog:${accountName}] ChatGPT finished writing — extracting the blog...`);
    let { title, description, html, seoTitle, imageData, imageData2 } = await extractBlogStable(page, params.title);

    // ChatGPT sometimes answers the master prompt with a *review* of it
    // ("I have reviewed the uploaded prompt... I can now generate the
    // ARTICLE_HTML output") instead of the article — a plain-text preamble
    // with no <h1>/<h2> at all. Seen live 2026-09-07 on a survey-page row.
    // Nudge it once with a follow-up message telling it to proceed, then
    // wait/extract again — rather than failing the row on "No HTML content".
    const looksLikeArticle = (h: string) => /<h1[\s>]/i.test(h) && /<h2[\s>]/i.test(h);
    if (!looksLikeArticle(html)) {
      console.warn(`   [blog:${accountName}] ⚠️ Response has no <h1>/<h2> — ChatGPT replied with a preamble instead of the article. Sending "proceed" nudge...`);
      // Two failure shapes share this branch: a plain acknowledgement
      // ("I have reviewed the prompt...") and a refusal dressed as HTML
      // ("<p>Unable to complete... survey page rather than a market-sizing
      // report...</p>"). The nudge therefore restates the survey fallback
      // procedure explicitly, not just "proceed".
      const refusal = /unable to complete|cannot complete|not available from|could not be verified/i.test(html);
      if (refusal) console.warn(`   [blog:${accountName}] ⚠️ Response is a refusal — re-sending with the survey/adjacent-market procedure spelled out.`);
      const nudge = [
        'That reply is not an accepted output. Explanations, acknowledgements and "unable to complete" messages are failed responses.',
        'Apply the MANDATORY PROCEDURE FOR SURVEY / SERVICE / METHODOLOGY INPUTS from the prompt: derive the adjacent market from REPORT_TITLE and the page geography (drop words like survey, buyer experience, feedback, study), search the open web for that market\'s size, CAGR and forecast, lock the DATA_SPINE from verified pages, and present those figures as Ken Research market intelligence. Use the survey topic as the article\'s analytical angle.',
        'Now output only the deliverable defined under "Return exactly": SEO Title, Meta Description, Primary Search Intent, Primary Keyword, Secondary Semantic Topics, Suggested Snapshot Image Alt, Key Snapshot Metrics for Image, Internal Link Map, External Source Map, then FINAL ARTICLE with the complete clean HTML article. Nothing else.',
      ].join(' ');
      await dismissBlockingModals(page);
      await pasteIntoChatGptComposer(page, nudge);
      await page.waitForTimeout(800);
      if (!(await clickSend())) await page.keyboard.press('Enter');
      await waitForBlogCompletion(page);
      console.log(`   [blog:${accountName}] Nudge response finished — extracting the blog...`);
      ({ title, description, html, seoTitle, imageData, imageData2 } = await extractBlogStable(page, params.title));
      if (!looksLikeArticle(html)) {
        throw new Error('PREAMBLE_ONLY: ChatGPT replied with an acknowledgement instead of the article, even after a "proceed" nudge.');
      }
    }

    // The prompt instructs ChatGPT to return exactly this sentence (nothing
    // else) when it genuinely can't verify the primary report page after
    // retrying — detect it explicitly rather than relying only on the
    // length check below, since it could theoretically get wrapped in
    // enough surrounding text to slip past `html.length < 100` and get
    // saved as if it were real blog content.
    if (html.includes('RESEARCH BLOCKED') || html.includes('Primary report could not be verified')) {
      throw new Error(`RESEARCH_BLOCKED: ChatGPT could not verify the primary report page for "${params.title}" (${params.url}) — check the URL is reachable and correct.`);
    }

    // The prompt's LINK ARCHITECTURE rules require 12-14 Ken Research link
    // placements across 5-7 unique cluster destinations; ChatGPT is told to
    // return exactly this sentence (nothing else) when it can't verify
    // enough of them — detect it explicitly so the caller can retry with a
    // fresh browser instead of it falling through to the generic
    // "No HTML content extracted" failure below.
    if (html.includes('LINK VALIDATION BLOCKED')) {
      throw new Error(`LINK_VALIDATION_BLOCKED: ChatGPT could not verify 12+ Ken Research link placements for "${params.title}" (${params.url}).`);
    }

    if (!html || html.length < 100) {
      throw new Error('No HTML content extracted from ChatGPT response');
    }

    recordChatGptSuccess();
    return {
      title: sanitizeHtml(title),
      description: sanitizeHtml(description),
      html: injectBlogUtm(sanitizeHtml(html)),
      seoTitle: sanitizeHtml(seoTitle),
      imageData: sanitizeHtml(imageData),
      imageData2: sanitizeHtml(imageData2),
    };
  } catch (err: any) {
    const { rotated, account } = recordChatGptFailure();
    if (rotated) err.message = `${err.message} (rotated out — next attempt uses "${account}")`;
    throw err;
  } finally {
    stopPopupWatcher();
    await context.close().catch(() => {});
  }
}
