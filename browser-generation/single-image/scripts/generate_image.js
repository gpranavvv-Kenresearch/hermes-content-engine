// Agent 04 runner â€” generate image via ChatGPT using Playwright.
//
// Usage:
//   node scripts/generate_image.js --prompt-file=path/to/prompt.txt --slug=topic-slug
//   node scripts/generate_image.js --prompt="..."                   --slug=topic-slug
//
// Output: ./images/image_[YYYY-MM-DD]_[slug].png
//
// Login: uses the already-logged-in "carousel-single" ChatGPT account
// (its own dedicated session, separate from blog-gen/blog-image/storyline)
// at ../.sessions/chatgpt-accounts/carousel-single — the same session-dir
// convention the rest of the project uses. If that session is not active,
// the script will wait up to 5 minutes for manual login in the Chrome
// window it opens. Override with CHATGPT_PROFILE_DIR if needed.

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pasteIntoChatGPTComposer } from './chatgpt_composer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROFILE_DIR = process.env.CHATGPT_PROFILE_DIR || path.resolve('.sessions', 'chatgpt-accounts', 'carousel-single');
const IMAGES_DIR = path.join(ROOT, 'images');
const CHATGPT_URL = 'https://chatgpt.com/images';

// ---------- CLI args ----------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);
let prompt = args.prompt;
if (args['prompt-file']) {
  prompt = fs.readFileSync(args['prompt-file'], 'utf8').trim();
}
const slug = args.slug ?? 'untitled';
if (!prompt) {
  console.error('Missing --prompt or --prompt-file');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const outPath = path.join(IMAGES_DIR, `image_${today}_${slug}.png`);
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ---------- Image finder (permissive) ----------
// The new ChatGPT UI (2026 onward) places generated images in a preview
// overlay outside <main>. Strategy: scan every <img> in document, filter by
// naturalWidth >= 800 (real generated images are 1024+; UI icons are < 100).
// Also returns blob: / data: URLs which the new UI uses.
async function scanForGeneratedImage(page) {
  return page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    // Filter to images that look like a generated slide (â‰¥800px on long edge)
    const candidates = imgs.filter(img => {
      const long = Math.max(img.naturalWidth || 0, img.naturalHeight || 0);
      return long >= 800;
    });
    if (!candidates.length) return null;
    // Prefer the most recently added (highest in DOM order = last)
    const target = candidates[candidates.length - 1];
    return {
      src: target.src,
      naturalWidth: target.naturalWidth,
      naturalHeight: target.naturalHeight,
      // Best-effort path identifier so the caller can re-locate via JS
      srcLen: target.src.length,
    };
  });
}

// After pasting the prompt: recheck every 1 minute, up to 15 times
// (15 minutes total) before giving up.
async function findGeneratedImage(page) {
  for (let attempt = 1; attempt <= 15; attempt++) {
    console.log(`Checking for image (${attempt}/15)...`);
    await page.waitForTimeout(60 * 1000);
    const found = await scanForGeneratedImage(page);
    if (found && found.src) {
      console.log(`Image found: ${found.naturalWidth}x${found.naturalHeight} (src starts: ${found.src.slice(0, 60)}...)`);
      return found;
    }
  }

  throw new Error('Generated image not found after timeout (no img with naturalWidth >= 800 in document)');
}

// ---------- Main ----------
console.log(`Slug: ${slug}`);
console.log(`Output target: ${outPath}`);
console.log('Launching Chrome...');

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: null,
  acceptDownloads: true,
  args: [
    '--start-maximized',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

const page = context.pages()[0] ?? await context.newPage();

try {
  console.log('Opening ChatGPT...');
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Login-check/wait loop removed — this account (carousel-single) is
  // already logged in, and the check itself was flaky (1s-timeout
  // visibility probes on a page that can take longer than that to render),
  // producing an incorrect "Not logged in" on some runs and burning up to
  // 5 minutes waiting for a login that already happened. Go straight to
  // the actual work: paste, send, record.

  // ---------- Dismiss any blocking modals ----------
  // Same smart-quote bug as the close-button selectors below — this used
  // ” instead of " and so NEVER matched anything, meaning modalVisible was
  // always false and this whole dismissal block never ran at all.
  const modalSel = '[data-testid="modal-conversation-history-rate-limit"], [id="modal-conversation-history-rate-limit"]';
  const modalVisible = await page.locator(modalSel).isVisible({ timeout: 2000 }).catch(() => false);
  if (modalVisible) {
    console.log('Rate-limit modal detected — dismissing...');
    // Try close/OK buttons inside the modal. (These used typographic smart
    // quotes — ”/“ instead of " — inside the selector strings before,
    // which made every one of them syntactically invalid and silently
    // never-matching. "Got it" and the others never actually got clicked.)
    const closeBtns = [
      `${modalSel} button`,
      'button[aria-label="Close"]',
      'button:has-text("Got it")',
      'button:has-text("OK")',
      'button:has-text("Continue")',
    ];
    let dismissed = false;
    for (const sel of closeBtns) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await btn.click().catch(() => {});
        dismissed = true;
        console.log(`Dismissed via "${sel}"`);
        break;
      }
    }
    if (!dismissed) {
      // Navigate to fresh chat to clear the modal
      console.log('Could not dismiss modal — navigating to fresh chat...');
      await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
    }
    await page.waitForTimeout(2000);
  }

  // Page-wide fallback, not scoped to the modal container above: ChatGPT's
  // "Too many requests" rate-limit popup doesn't always carry the same
  // data-testid/id as the named modal — its "Got it" button can just be
  // sitting anywhere in the DOM. Click it wherever it is.
  {
    const gotIt = page.getByRole('button', { name: 'Got it', exact: true }).first();
    if (await gotIt.isVisible({ timeout: 1000 }).catch(() => false)) {
      await gotIt.click().catch(() => {});
      console.log('Dismissed "Got it" popup (page-wide fallback)');
      await page.waitForTimeout(500);
    }
  }

  // ---------- Submit prompt ----------
  // NB: .fill() truncates on ChatGPT's Lexical composer — delivers only the
  // first line. Use the paste-event helper which preserves the full prompt.
  console.log('Pasting prompt...');
  await pasteIntoChatGPTComposer(page, prompt);
  console.log('Prompt pasted');
  await page.waitForTimeout(1000);

  console.log('Clicking send...');
  const sendSelectors = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send"]',
    'button:has(svg)[data-disabled="false"]',
    'div[class*="composer"] button:last-child',
    'form button[type="submit"]',
  ];

  let sendClicked = false;
  for (const sel of sendSelectors) {
    const btn = page.locator(sel).last();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await btn.click();
      sendClicked = true;
      console.log(`Send clicked via "${sel}"`);
      break;
    }
  }
  if (!sendClicked) {
    console.log('Send button not found, using Enter key...');
    await page.keyboard.press('Enter');
  }

  // ---------- Wait for image (returns plain JS object {src, naturalWidth, naturalHeight}) ----------
  console.log('Waiting for image (up to 10 minutes)...');
  const generatedImage = await findGeneratedImage(page);

  console.log(`Full image ready: ${generatedImage.naturalWidth}x${generatedImage.naturalHeight}px`);

  // ---------- Stability buffer ----------
  console.log('Stability wait (30s) for full generation to settle...');
  await page.waitForTimeout(30 * 1000);

  // Re-check the image src â€” the largest image may have been swapped (e.g.,
  // from initial preview to final full-res) during the stability wait.
  const finalImage = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    const candidates = imgs.filter(img => Math.max(img.naturalWidth || 0, img.naturalHeight || 0) >= 800);
    if (!candidates.length) return null;
    const target = candidates[candidates.length - 1];
    return { src: target.src, naturalWidth: target.naturalWidth, naturalHeight: target.naturalHeight };
  });
  const imgSrc = finalImage?.src || generatedImage.src;
  if (!imgSrc) throw new Error('Could not resolve final image src after stability wait');
  console.log(`Final src: ${imgSrc.slice(0, 80)}... (${finalImage?.naturalWidth}x${finalImage?.naturalHeight})`);

  console.log('Downloading via browser fetch...');
  const base64Data = await page.evaluate(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }, imgSrc);

  const buffer = Buffer.from(base64Data, 'base64');
  fs.writeFileSync(outPath, buffer);

  if (!fs.existsSync(outPath)) throw new Error('File not found after saving');
  const stats = fs.statSync(outPath);
  console.log(`Saved: ${outPath} (${(stats.size / 1024).toFixed(1)} KB)`);

  console.log(JSON.stringify({ status: 'success', savedPath: outPath, slug }));
} catch (err) {
  console.error(`Error: ${err.message}`);
  try {
    const stamp = Date.now();
    const debugPath = path.join(IMAGES_DIR, `error_${slug}_${stamp}.png`);
    await page.screenshot({ path: debugPath, fullPage: true });
    console.log(`Debug screenshot: ${debugPath}`);
    const htmlPath = path.join(IMAGES_DIR, `error_${slug}_${stamp}.html`);
    fs.writeFileSync(htmlPath, await page.content(), 'utf8');
    console.log(`Debug HTML: ${htmlPath}`);
  } catch {}
  console.log(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
} finally {
  await context.close();
}
