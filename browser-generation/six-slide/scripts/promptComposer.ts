// Reliable text input for ChatGPT's Lexical/ProseMirror composer.
//
// Same technique as li-carousel/scripts/chatgpt_composer.js (read for
// reference, not imported — this directory stays fully standalone): .fill()
// truncates a multi-line prompt to its first line on ChatGPT's Lexical
// composer, so this dispatches a synthetic paste event with a DataTransfer
// payload instead, which Lexical handles natively and preserves newlines.
import { Page } from 'playwright';
import { COMPOSER_SELECTOR } from '../../src/browser/chatgpt/login.js';

// Confirmed live 2026-09-24: the composer sometimes never appears at all —
// the page navigated but chatgpt.com's own SPA render never finished — and
// this used to just throw once after one flat 15s wait. Reload the page
// and try again instead of giving up on the first miss; same fix applied
// to src/utils/chatgptComposer.ts (the main daemon's copy of this helper —
// this file is a separate, standalone duplicate for the storyline scripts).
async function waitForComposerWithReload(page: Page, composer: import('playwright').Locator, maxAttempts = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const visible = await composer.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
    if (visible) return;
    if (attempt === maxAttempts) {
      throw new Error(`ChatGPT composer never became visible after ${maxAttempts} attempts (15s wait + reload each time).`);
    }
    console.log(`   [composer] Composer not visible after 15s (attempt ${attempt}/${maxAttempts}) — reloading and retrying...`);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
}

// ChatGPT's "Too many requests" rate-limit popup can block the composer.
// This file previously had no modal-dismiss logic at all (unlike the other
// two copies of this helper — src/utils/chatgptComposer.ts and
// li-carousel/scripts/chatgpt_composer.js) — click its "Got it" button
// wherever it is in the DOM before waiting for the composer.
async function dismissGotIt(page: Page): Promise<void> {
  const gotIt = page.getByRole('button', { name: 'Got it', exact: true }).first();
  if (await gotIt.isVisible({ timeout: 500 }).catch(() => false)) {
    await gotIt.click().catch(() => {});
    console.log('   [composer] Dismissed "Got it" popup');
    await page.waitForTimeout(300);
  }
}

export async function pasteIntoChatGptComposer(page: Page, text: string): Promise<void> {
  await dismissGotIt(page);
  const composer = page.locator(COMPOSER_SELECTOR).first();
  await waitForComposerWithReload(page, composer);
  await composer.click();
  await page.waitForTimeout(300);

  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);

  await composer.evaluate((target, textToInsert) => {
    (target as HTMLElement).focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', textToInsert);
    const pasteEvent = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    target.dispatchEvent(pasteEvent);
  }, text);

  await page.waitForTimeout(1500);

  const actualLen = await composer.evaluate(el => (el as HTMLElement).innerText.length);
  if (actualLen < text.length * 0.5) {
    console.warn(`   ⚠️ Paste may be incomplete (${actualLen}/${text.length} chars) — falling back to keyboard.insertText`);
    await composer.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.insertText(text);
    await page.waitForTimeout(500);
  }
}

// Click Send and confirm ChatGPT took the prompt. The send button stays
// disabled while a long paste/attachment is still processing, and clicking a
// disabled button silently does nothing — wait for it to be enabled, then
// verify Send was swapped for Stop/voice; if not, retry with Enter.
export async function clickSend(page: Page): Promise<void> {
  const sendSelectors = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="Send"]',
  ];
  const hasStop = () => page.locator('button[data-testid="stop-button"], button[aria-label*="Stop"]').first().isVisible({ timeout: 500 }).catch(() => false);
  const sendVisible = () => page.locator(sendSelectors.join(', ')).first().isVisible({ timeout: 500 }).catch(() => false);

  for (let attempt = 1; attempt <= 3; attempt++) {
    let clicked = false;
    for (const sel of sendSelectors) {
      const btn = page.locator(sel).last();
      if (!(await btn.isVisible({ timeout: 3000 }).catch(() => false))) continue;
      if (!(await btn.isEnabled({ timeout: 15000 }).catch(() => false))) continue;
      await btn.click().catch(() => {});
      clicked = true;
      break;
    }
    if (!clicked) {
      await page.locator(COMPOSER_SELECTOR).first().click().catch(() => {});
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(2500);
    if ((await hasStop()) || !(await sendVisible())) return;
    console.log(`   [composer] Prompt not accepted after send (attempt ${attempt}/3) — retrying...`);
  }
  throw new Error('Prompt was pasted but ChatGPT never accepted the send after 3 attempts.');
}
