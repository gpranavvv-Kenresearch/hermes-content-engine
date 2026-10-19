import { chromium, BrowserContext, Page } from 'playwright';
import path from 'path';
import fs from 'fs';
import 'dotenv/config';
import { createInterface } from 'readline/promises';
import { killChromeForProfile } from '../../utils/killChrome.js';
import { safeCloseContext } from '../../utils/safeClose.js';
import { sessionDirForAccount } from '../../config/chatGptAccountTracker.js';

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Composer is a contenteditable ProseMirror div, not a <textarea>, in current
// chatgpt.com. ChatGPT rolled out a UI redesign (confirmed live 2026-09-26,
// screenshotted on the "social-image" account: new "Chat"/"Work" toggle,
// "Ask ChatGPT" input) that dropped the #prompt-textarea id entirely — the
// composer is now a bare `div.ProseMirror[contenteditable="true"]` with no
// id. The rollout is staggered per-account (the "account2" ChatGPT session
// still had the old #prompt-textarea id at the same time), so match both,
// comma-separated (Playwright locators support a CSS selector list same as
// querySelectorAll) — whichever UI a given account currently has.
const COMPOSER_SELECTOR = '#prompt-textarea, div[contenteditable="true"].ProseMirror';
const LOGIN_BUTTON_SELECTOR = 'button:has-text("Log in"), a:has-text("Log in")';

let browserContext: BrowserContext | null = null;
let page: Page | null = null;
let activeAccount: string | null = null;
let currentSessionDir: string | null = null;

export async function closeChatGptBrowser(): Promise<void> {
  await safeCloseContext(browserContext, { label: 'ChatGPT', sessionDir: currentSessionDir });
  browserContext = null;
  page = null;
  activeAccount = null;
}

async function launchBrowser(accountName: string): Promise<Page> {
  // Already have a live page for this exact account — reuse it.
  if (page && !page.isClosed() && activeAccount === accountName) return page;

  // Switching accounts (or first launch) — close whatever's open first,
  // since a persistent context is tied to one profile directory.
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    page = null;
  }

  const sessionDir = sessionDirForAccount(accountName);
  currentSessionDir = sessionDir;
  fs.mkdirSync(sessionDir, { recursive: true });

  const chromePath = fs.existsSync(CHROME_PATH) ? CHROME_PATH : chromium.executablePath();
  await killChromeForProfile(sessionDir);

  console.log(`   Using ChatGPT session folder (account: ${accountName}): ${sessionDir}`);
  console.log('   Launching ChatGPT browser...');

  browserContext = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1366, height: 900 },
    slowMo: 50,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      // Without an explicit window size, Chrome opens at whatever size the
      // profile last saved (or the OS default) while the PAGE renders at
      // the 1366x900 viewport above — the mismatch is what shows up as a
      // skewed/zoomed window with buttons cut off. Match the two exactly.
      '--window-size=1366,900',
      '--window-position=0,0',
    ],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  await browserContext.grantPermissions(['clipboard-read', 'clipboard-write']);

  page = await browserContext.newPage();
  await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded' });
  activeAccount = accountName;
  return page;
}

/**
 * Opens (or reuses) a persistent ChatGPT browser session for the given
 * account. On first run there is no saved session, so the composer won't be
 * present — the browser stays open and visible until you log in by hand (and
 * clear any verification challenge), auto-detected by polling for the
 * composer; the session is then reused on every future run. Used by the
 * unattended generate scripts.
 */
export async function ensureChatGptPage(accountName: string): Promise<Page> {
  const p = await launchBrowser(accountName);
  await logSessionState(p);
  return p;
}

/**
 * Same as ensureChatGptPage(), but for the interactive one-time login script:
 * instead of polling with a timeout, explicitly asks you to press Enter in
 * the terminal once you've finished logging in.
 */
export async function ensureChatGptPageInteractive(accountName: string): Promise<Page> {
  const p = await launchBrowser(accountName);

  if (await isComposerVisible(p)) {
    console.log('   ✅ ChatGPT: already logged in (session restored)');
    return p;
  }

  const loginBtn = p.locator(LOGIN_BUTTON_SELECTOR).first();
  if (await loginBtn.isVisible().catch(() => false)) {
    await loginBtn.click().catch(() => {});
  }

  console.log('   ⚠️  ChatGPT: no active session — please log in manually in the open browser window.');
  await waitForEnter('   Press Enter here once you have finished logging in... ');

  if (!(await isComposerVisible(p))) {
    console.log('   Composer not visible yet — waiting a bit longer...');
    await p.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  }

  if (!(await isComposerVisible(p))) {
    await closeChatGptBrowser();
    throw new Error('ChatGPT: composer still not visible after login confirmation.');
  }

  console.log('   ✅ ChatGPT: login confirmed — session saved for future runs');
  return p;
}

async function waitForEnter(promptText: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(promptText);
  rl.close();
}

async function isComposerVisible(p: Page): Promise<boolean> {
  return await p.locator(COMPOSER_SELECTOR).first().isVisible().catch(() => false);
}

// Diagnostic only — never blocks for a manual login and never aborts the
// run. The unattended generate scripts run under the cron daemon where
// nobody is watching to log in by hand, so the old 120s manual-login wait
// just stalled the batch before failing anyway. Log what we see and let
// the caller proceed; if the session really is dead, the composer step
// downstream fails on its own with a specific error.
async function logSessionState(p: Page): Promise<void> {
  const composerVisible = await p.locator(COMPOSER_SELECTOR).first()
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  console.log(composerVisible
    ? '   ✅ ChatGPT: session active (composer visible)'
    : '   ⚠️  ChatGPT: composer not visible — continuing anyway (session may be expired)');
}

export { COMPOSER_SELECTOR };
