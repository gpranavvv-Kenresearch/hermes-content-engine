/**
 * generateImages.ts — takes the 6 extracted prompt files from a
 * generateStoryline.ts run and pastes them into ChatGPT one by one (a fresh
 * chat per slide, same pattern as li-carousel's generate_image.js), waiting
 * for each generated image and downloading it.
 *
 * Usage:
 *   npx tsx li-carousel-storyline/scripts/generateImages.ts --slug=<slug> [--account=storyline]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Page } from 'playwright';
import 'dotenv/config';
import { ensureChatGptPage, closeChatGptBrowser } from '../../src/browser/chatgpt/login.js';
import { pasteIntoChatGptComposer, clickSend } from './promptComposer.js';
import { assertProfileFree } from './profileGuard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(ROOT, 'runs');
const IMAGES_DIR = path.join(ROOT, 'images');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/s);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
) as Record<string, string>;

const slug = args.slug;
const accountName = args.account || 'storyline';

if (!slug) {
  console.error('Usage: npx tsx generateImages.ts --slug=<slug> [--account=storyline]');
  process.exit(1);
}

const runDir = path.join(RUNS_DIR, slug);
if (!fs.existsSync(runDir)) {
  console.error(`Run folder not found: ${runDir} — run generateStoryline.ts first.`);
  process.exit(1);
}

// Same permissive scan as li-carousel/scripts/generate_image.js — real
// generated images are 1024px+, UI icons are under 100px.
async function scanForGeneratedImage(page: Page): Promise<{ src: string; naturalWidth: number; naturalHeight: number } | null> {
  return page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    const candidates = imgs.filter(img => Math.max(img.naturalWidth || 0, img.naturalHeight || 0) >= 800);
    if (!candidates.length) return null;
    const target = candidates[candidates.length - 1];
    return { src: target.src, naturalWidth: target.naturalWidth, naturalHeight: target.naturalHeight };
  });
}

// ChatGPT's UI redesign dropped data-message-author-role — its assistant
// replies now live in [data-markdown-text-style="assistant-message"]
// instead (confirmed live 2026-09-26). Match both.
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]';

async function assistantState(page: Page): Promise<{ count: number; text: string; generating: boolean }> {
  const { count, text } = await page.evaluate((sel) => {
    const msgs = document.querySelectorAll(sel);
    return { count: msgs.length, text: msgs.length ? ((msgs[msgs.length - 1] as HTMLElement).innerText || '') : '' };
  }, ASSISTANT_MESSAGE_SELECTOR).catch(() => ({ count: 0, text: '' }));
  const generating = await page.locator('button[data-testid="stop-button"], button[aria-label*="Stop"]').first().isVisible({ timeout: 500 }).catch(() => false);
  return { count, text, generating };
}

// ChatGPT sometimes finishes its turn with plain TEXT instead of an image:
//  - misreads the slide as an edit and asks to resend "Generate from scratch"
//    (confirmed live 2026-09-27),
//  - "Image generation failed" / "tool error" (confirmed live 2026-10-22),
//  - asks the user to upload a reference image from slides 1/2 before it will
//    draw slide 3 (confirmed live 2026-10-23).
// Rather than regex every possible wording, treat ANY finished text-only reply
// (no Stop button, same text on two consecutive polls, no image on the page) as
// a failed attempt and resend, instead of burning the full 15-min wait.
const MAX_RESENDS = 2;
const RESEND_PREFIX = 'Generate from scratch. There is NO reference image and none will be provided — do not ask for uploads or earlier slides. Follow the brief below exactly and generate the image now.';

// ChatGPT sometimes shows "Which image do you like more?" with two candidates
// and holds the result until one is picked or skipped. Skip it so the page
// settles on one final image instead of swapping/revoking blob URLs.
async function dismissImageComparison(page: Page): Promise<boolean> {
  const skip = page.getByRole('button', { name: 'Skip', exact: true }).first();
  if (await skip.isVisible({ timeout: 500 }).catch(() => false)) {
    await skip.click().catch(() => {});
    console.log('   Dismissed "Which image do you like more?" comparison (Skip)');
    await page.waitForTimeout(2000);
    return true;
  }
  return false;
}

async function findGeneratedImage(page: Page, prompt: string): Promise<{ src: string; naturalWidth: number; naturalHeight: number }> {
  let resends = 0;
  let baselineCount = 0; // assistant messages present when the prompt was last sent
  let prevText = '';
  for (let attempt = 1; attempt <= 15; attempt++) {
    console.log(`   Checking for image (${attempt}/15)...`);
    await page.waitForTimeout(60 * 1000);
    await dismissImageComparison(page);
    const found = await scanForGeneratedImage(page);
    if (found?.src) {
      console.log(`   Image found: ${found.naturalWidth}x${found.naturalHeight}`);
      return found;
    }

    const state = await assistantState(page);
    const textOnlyReply = !state.generating && state.count > baselineCount && state.text.trim().length > 0 && state.text === prevText;
    prevText = state.text;
    if (textOnlyReply) {
      if (resends >= MAX_RESENDS) throw new Error(`ChatGPT replied with text instead of an image after ${MAX_RESENDS} resends: ${state.text.slice(0, 200)}`);
      resends++;
      console.log(`   ⚠️ ChatGPT replied with text, no image (${JSON.stringify(state.text.slice(0, 120))}...) — resending (${resends}/${MAX_RESENDS})...`);
      baselineCount = state.count;
      await pasteIntoChatGptComposer(page, `${RESEND_PREFIX}

${prompt}`);
      await page.waitForTimeout(1000);
      await clickSend(page);
    }
  }
  throw new Error('Generated image not found after 15 min timeout.');
}

async function downloadImage(page: Page, src: string, outPath: string): Promise<void> {
  const base64Data: string = await page.evaluate(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    const blob = await response.blob();
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }, src);
  fs.writeFileSync(outPath, Buffer.from(base64Data, 'base64'));
}

// ChatGPT's own "You're making requests too quickly" rate-limit overlay
// (id="modal-conversation-history-rate-limit") sits on top of the composer
// and physically blocks clicks on it — confirmed live 2026-09-22, this is
// what turned into a 30s "locator.click: Timeout exceeded" on
// #prompt-textarea when a --count=100 batch fired slide after slide with
// no gap between them. It's an app-level overlay, not per-conversation, so
// it can still be showing right after navigating to a brand-new chat.
const RATE_LIMIT_MODAL_SEL = '#modal-conversation-history-rate-limit';

async function isRateLimited(page: Page): Promise<boolean> {
  return page.locator(RATE_LIMIT_MODAL_SEL).first().isVisible({ timeout: 1000 }).catch(() => false);
}

async function generateOneSlide(page: Page, promptPath: string, outPath: string): Promise<void> {
  const prompt = fs.readFileSync(promptPath, 'utf8').trim();

  console.log('   Navigating to a fresh chat...');
  await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  // Confirmed live 2026-09-24: the composer sometimes never rendered after
  // the goto above (chatgpt.com's own SPA render stalling) — a hard refresh
  // here fixes it far more reliably than just waiting longer on the same
  // stuck page. Same fix as generateStoryline.ts.
  console.log('   Hard refreshing ChatGPT...');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);

  if (await isRateLimited(page)) {
    console.warn('   ⚠️ Rate-limit modal already showing on this fresh chat — trying "Got it" first...');
    const gotIt = page.getByRole('button', { name: 'Got it', exact: true }).first();
    const dismissed = await gotIt.isVisible({ timeout: 2000 }).then(() => gotIt.click().then(() => true)).catch(() => false);
    if (dismissed) {
      console.log('   ✅ Dismissed rate-limit modal via "Got it"');
      await page.waitForTimeout(1000);
    } else {
      console.warn('   ⚠️ "Got it" not found — waiting 90s before trying to paste...');
      await page.waitForTimeout(90 * 1000);
    }
  }

  console.log('   Pasting slide prompt...');
  await pasteIntoChatGptComposer(page, prompt);
  await page.waitForTimeout(1000);

  console.log('   Sending...');
  await clickSend(page);

  console.log('   Waiting for image (up to 15 min)...');
  const generated = await findGeneratedImage(page, prompt);

  console.log('   Stability wait (30s)...');
  await page.waitForTimeout(30 * 1000);

  // Re-resolve after the stability wait (a comparison prompt may have swapped
  // the candidates) and retry the download: blob URLs can be revoked between
  // resolve and fetch.
  console.log('   Downloading...');
  let lastErr: any;
  let saved = false;
  for (let attempt = 1; attempt <= 3 && !saved; attempt++) {
    await dismissImageComparison(page);
    const finalImage = await scanForGeneratedImage(page);
    try {
      await downloadImage(page, (finalImage ?? generated).src, outPath);
      if (fs.statSync(outPath).size < 50 * 1024) throw new Error('Downloaded image too small');
      saved = true;
    } catch (err: any) {
      lastErr = err;
      console.warn(`   Download attempt ${attempt}/3 failed: ${err.message}`);
      await page.waitForTimeout(5000);
    }
  }
  if (!saved) throw new Error(`Could not download generated image: ${lastErr?.message}`);

  const stats = fs.statSync(outPath);
  console.log(`   Saved: ${outPath} (${(stats.size / 1024).toFixed(1)} KB)`);
}

// Retry a slide from scratch (brand-new chat, full re-paste, re-send) on
// any failure — a rate-limit hit mid-slide leaves ChatGPT's UI in an
// unpredictable state, so patching around it in place is less reliable
// than just starting the whole slide over. Cooldown grows each attempt
// (60s -> 120s -> 180s) to actually clear a rate limit rather than
// immediately re-tripping it.
const MAX_SLIDE_ATTEMPTS = 3;
const RETRY_COOLDOWN_SEC = [60, 120, 180];

async function generateOneSlideWithRetry(page: Page, promptPath: string, outPath: string): Promise<void> {
  let lastErr: any;
  for (let attempt = 1; attempt <= MAX_SLIDE_ATTEMPTS; attempt++) {
    try {
      await generateOneSlide(page, promptPath, outPath);
      return;
    } catch (err: any) {
      lastErr = err;
      const rateLimited = /making requests too quickly|rate.?limit/i.test(err.message || '') || await isRateLimited(page);
      console.warn(`   ⚠️ Slide attempt ${attempt}/${MAX_SLIDE_ATTEMPTS} failed${rateLimited ? ' (looks like a ChatGPT rate limit)' : ''}: ${err.message?.split('\n')[0] ?? err}`);
      if (attempt < MAX_SLIDE_ATTEMPTS) {
        const cooldown = RETRY_COOLDOWN_SEC[attempt - 1] ?? 180;
        console.log(`   Cooling down ${cooldown}s, then retrying this slide from a fresh chat...`);
        await page.waitForTimeout(cooldown * 1000);
      }
    }
  }
  throw new Error(`Slide failed after ${MAX_SLIDE_ATTEMPTS} attempts (from fresh each time): ${lastErr?.message ?? lastErr}`);
}

(async () => {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const outDir = path.join(IMAGES_DIR, slug);
  fs.mkdirSync(outDir, { recursive: true });

  const promptFiles = fs.readdirSync(runDir)
    .filter(f => /^prompt_\d{2}\.txt$/.test(f))
    .sort();

  if (promptFiles.length !== 6) {
    console.warn(`   ⚠️ Expected 6 prompt files, found ${promptFiles.length}: ${promptFiles.join(', ')}`);
  }

  console.log(`Opening ChatGPT (account: ${accountName})...`);
  await assertProfileFree(accountName);
  const page = await ensureChatGptPage(accountName);

  // Clear slides from any previous run only AFTER login succeeds, so a failed
  // launch never wipes good images, and a partly-failed run can never be
  // silently combined with stale slides from an older storyline.
  for (const f of fs.readdirSync(outDir)) {
    if (/^slide_\d+\.png$/i.test(f)) fs.unlinkSync(path.join(outDir, f));
  }

  const results: Array<{ prompt: string; image: string; status: string; error?: string }> = [];

  for (const file of promptFiles) {
    const promptPath = path.join(runDir, file);
    const n = file.match(/\d{2}/)?.[0] ?? '00';
    const outPath = path.join(outDir, `slide_${n}.png`);
    console.log(`\n=== Slide ${n} ===`);
    try {
      await generateOneSlideWithRetry(page, promptPath, outPath);
      results.push({ prompt: file, image: outPath, status: 'success' });
    } catch (err: any) {
      console.error(`   ❌ Slide ${n} failed: ${err.message}`);
      results.push({ prompt: file, image: outPath, status: 'error', error: err.message });
    }
  }

  await closeChatGptBrowser();
  console.log('\n' + JSON.stringify({ status: 'done', slug, outDir, results }, null, 2));
})().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
