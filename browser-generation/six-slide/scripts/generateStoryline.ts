/**
 * generateStoryline.ts — sends the static storyline-master-prompt to ChatGPT
 * for one report (title + URL), waits for the full text response, and
 * extracts the 6 "Prompt N:" image-generation prompt blocks into separate
 * files ready for generateImages.ts.
 *
 * Fully standalone from li-carousel/ — only reuses the shared ChatGPT
 * login module (src/browser/chatgpt/login.ts) read-only via import.
 *
 * Usage:
 *   npx tsx li-carousel-storyline/scripts/generateStoryline.ts \
 *     --title="Report Title Here" --url="https://www.kenresearch.com/..." [--account=storyline]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { ensureChatGptPage, closeChatGptBrowser } from '../../src/browser/chatgpt/login.js';
import { pasteIntoChatGptComposer, clickSend } from './promptComposer.js';
import { assertProfileFree } from './profileGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROMPT_TEMPLATE_PATH = path.join(ROOT, 'prompts', 'storyline-master-prompt.txt');
const RUNS_DIR = path.join(ROOT, 'runs');

const STOP_BUTTON_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop streaming"], button[aria-label*="Stop"]';
// ChatGPT's UI redesign (confirmed live 2026-09-26, on this exact
// "storyline" account) dropped the data-message-author-role attribute
// entirely — the assistant's rendered markdown now lives in a
// div[data-markdown-text-style="assistant-message"] instead, found by
// walking up from a live "PONG" test reply. Match both, comma-separated.
// Without this fix every poll read 0 chars forever, so a fully-generated
// reply was thrown away as "still writing"/empty.
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]';
const POLL_MS = 30 * 1000;
const MAX_POLLS = 20; // 10 min hard cap

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/s);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
) as Record<string, string>;

const reportTitle = args.title;
const reportUrl = args.url;
const accountName = args.account || 'storyline';

if (!reportTitle || !reportUrl) {
  console.error('Usage: npx tsx generateStoryline.ts --title="..." --url="..." [--account=storyline]');
  process.exit(1);
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function lastAssistantText(page: import('playwright').Page): Promise<string> {
  return page.evaluate((sel) => {
    const msgs = document.querySelectorAll(sel);
    return msgs.length ? ((msgs[msgs.length - 1] as HTMLElement).innerText || '') : '';
  }, ASSISTANT_MESSAGE_SELECTOR);
}

async function waitForCompletion(page: import('playwright').Page): Promise<string> {
  let lastLength = -1;
  let unchangedChecks = 0;
  for (let poll = 1; poll <= MAX_POLLS; poll++) {
    await page.waitForTimeout(POLL_MS);
    const stopping = await page.locator(STOP_BUTTON_SELECTOR).first().isVisible({ timeout: 2000 }).catch(() => false);
    const text = await lastAssistantText(page);
    console.log(`   …check ${poll}/${MAX_POLLS}: ${stopping ? 'still writing' : 'looks finished'} (${text.length} chars so far)`);
    if (!stopping && text.length > 300) return text;
    if (text.length > 300 && text.length === lastLength) {
      unchangedChecks++;
      if (unchangedChecks >= 3) return text;
    } else {
      unchangedChecks = 0;
    }
    lastLength = text.length;
  }
  throw new Error('Timed out waiting for storyline response to finish.');
}

/** Split the raw response into 6 prompt blocks on "Prompt N:" markers. */
function extractPrompts(rawText: string): string[] {
  const prompts: string[] = [];
  for (let n = 1; n <= 6; n++) {
    const startRe = new RegExp(`Prompt\\s*${n}\\s*:`, 'i');
    const startMatch = rawText.match(startRe);
    if (!startMatch || startMatch.index === undefined) {
      throw new Error(`Could not find "Prompt ${n}:" marker in the response — cannot extract 6 prompts.`);
    }
    const contentStart = startMatch.index + startMatch[0].length;
    const nextRe = new RegExp(`Prompt\\s*${n + 1}\\s*:`, 'i');
    const nextMatch = rawText.slice(contentStart).match(nextRe);
    const contentEnd = nextMatch && nextMatch.index !== undefined ? contentStart + nextMatch.index : rawText.length;
    const block = rawText.slice(contentStart, contentEnd).trim();
    if (!block) throw new Error(`"Prompt ${n}:" block is empty.`);
    prompts.push(block);
  }
  return prompts;
}

(async () => {
  const slug = slugify(reportTitle);
  const runDir = path.join(RUNS_DIR, slug);
  fs.mkdirSync(runDir, { recursive: true });

  const template = fs.readFileSync(PROMPT_TEMPLATE_PATH, 'utf8');
  const filledPrompt = template
    .replace('{REPORT_TITLE}', reportTitle)
    .replace('{REPORT_URL}', reportUrl);

  console.log(`Slug: ${slug}`);
  console.log(`Account: ${accountName}`);
  console.log('Opening ChatGPT...');
  await assertProfileFree(accountName);
  const page = await ensureChatGptPage(accountName);

  console.log('Navigating to a fresh chat...');
  await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Confirmed live 2026-09-24: the composer sometimes never rendered after
  // the goto above (chatgpt.com's own SPA render stalling) — a hard refresh
  // here fixes it far more reliably than just waiting longer on the same
  // stuck page.
  console.log('Hard refreshing ChatGPT...');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);

  console.log('Pasting storyline master prompt...');
  await pasteIntoChatGptComposer(page, filledPrompt);
  await page.waitForTimeout(1000);

  console.log('Sending...');
  await clickSend(page);

  console.log('Waiting for the storyline response to finish...');
  const rawResponse = await waitForCompletion(page);

  const rawPath = path.join(runDir, 'raw_response.txt');
  fs.writeFileSync(rawPath, rawResponse, 'utf8');
  console.log(`Saved raw response: ${rawPath} (${rawResponse.length} chars)`);

  console.log('Extracting 6 prompts...');
  const prompts = extractPrompts(rawResponse);
  prompts.forEach((p, i) => {
    const n = String(i + 1).padStart(2, '0');
    const promptPath = path.join(runDir, `prompt_${n}.txt`);
    fs.writeFileSync(promptPath, p, 'utf8');
    console.log(`   Saved: ${promptPath} (${p.length} chars)`);
  });

  console.log(JSON.stringify({ status: 'success', slug, runDir, prompts: prompts.length }));
  await closeChatGptBrowser();
})().catch((err) => {
  console.error(`Error: ${err.message}`);
  console.log(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});
