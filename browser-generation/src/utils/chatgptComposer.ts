// Reliable long-text input for ChatGPT's Lexical/ProseMirror composer.
//
// ChatGPT's #prompt-textarea is a contenteditable <div> backed by Lexical.
// Playwright's locator.fill() only delivers the first line; everything after
// the first \n\n is silently dropped because Lexical re-renders from its own
// internal state. Symptom: GPT replies "the message only includes the
// opening line, please share the full brief."
//
// This helper bypasses fill() by dispatching a synthetic paste event with a
// DataTransfer payload — which Lexical handles natively and preserves
// newlines correctly. Falls back to keyboard.insertText if the paste event
// doesn't take, and recognizes ChatGPT's "Extended mode" behavior where a
// very long paste (the multi-thousand-word blog/image prompts) gets silently
// converted into a text-file attachment instead of landing in the composer.

import { Page } from 'playwright';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { COMPOSER_SELECTOR } from '../browser/chatgpt/login.js';

/**
 * Remove ChatGPT's blocking overlay modals/dialogs from the DOM. This is a
 * live React app — a modal can re-render itself seconds after being removed
 * if the underlying condition (rate limit, session nudge, upgrade prompt,
 * etc.) is still true, so call this again right before EVERY click that
 * could be intercepted, not just once up front. Returns true if anything was
 * found and dismissed.
 *
 * Covers two shapes:
 *  1. The one named modal ChatGPT is known to render for the conversation-
 *     history rate limit — removed directly from the DOM.
 *  2. Any OTHER generic ARIA dialog/alertdialog (session nudges, upgrade
 *     offers, "stay signed in", etc. — the exact markup varies and isn't all
 *     known) — try a close/dismiss button first, then Escape, then Enter as
 *     a last resort for keyboard-confirm-only dialogs.
 * Confirmed live 2026-09-16: only handling shape (1) left other popups to
 * accumulate for up to a minute (the caller's own poll interval) or require
 * a manual click during ~12-15 min blog generation.
 */
export async function dismissBlockingModals(page: Page): Promise<boolean> {
  const removedNamed = await page.evaluate(() => {
    const modal = document.querySelector(
      '#modal-conversation-history-rate-limit, [data-testid="modal-conversation-history-rate-limit"]'
    );
    if (modal) { modal.remove(); return true; }
    return false;
  });
  if (removedNamed) {
    console.log('   [composer] Removed blocking modal from DOM');
    await page.waitForTimeout(300);
  }

  let removedGeneric = false;
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').first();
  if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
    const dismissButton = dialog.locator(
      'button[aria-label="Close"], button:has-text("Close"), button:has-text("Got it"), button:has-text("OK"), button:has-text("Not now"), button:has-text("Skip"), button:has-text("Dismiss")'
    ).first();
    if (await dismissButton.isVisible({ timeout: 500 }).catch(() => false)) {
      await dismissButton.click().catch(() => {});
    } else {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
      if (await dialog.isVisible({ timeout: 300 }).catch(() => false)) {
        await page.keyboard.press('Enter').catch(() => {});
      }
    }
    removedGeneric = true;
    await page.waitForTimeout(300);
    console.log('   [composer] Dismissed a generic dialog/overlay popup');
  }

  // Page-wide fallback, not scoped to [role="dialog"]/[role="alertdialog"]:
  // confirmed live 2026-09-16 that ChatGPT's "Too many requests" rate-limit
  // popup (title "Too many requests", body "You're making requests too
  // quickly...", a "Got it" button) needed a manual click — so its container
  // may not carry either role. Click any visible "Got it" button directly,
  // wherever it is in the DOM.
  let removedGotIt = false;
  const gotItButton = page.getByRole('button', { name: 'Got it', exact: true }).first();
  if (await gotItButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await gotItButton.click().catch(() => {});
    removedGotIt = true;
    await page.waitForTimeout(300);
    console.log('   [composer] Dismissed "Got it" popup (e.g. ChatGPT rate-limit notice)');
  }

  return removedNamed || removedGeneric || removedGotIt;
}

// Confirmed live 2026-09-24: the composer sometimes never appears at all —
// the page loaded but chatgpt.com's own SPA render never finished — and
// this used to just throw once after one flat 15s wait. A hard refresh
// fixes a stuck SPA render far more reliably than waiting longer on the
// same broken page: wait 5s, hard refresh, wait 5s, then check once more.
// Same pattern applied in li-carousel-storyline/scripts/generateStoryline.ts
// and generateImages.ts (their own separate, standalone copy of this file).
async function waitForComposerWithReload(page: Page, composer: import('playwright').Locator): Promise<void> {
  const visible = await composer.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (visible) return;

  console.log('   [composer] Composer not visible — hard refreshing...');
  await page.waitForTimeout(5000);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await dismissBlockingModals(page);

  await composer.waitFor({ state: 'visible', timeout: 15000 });
}

export async function pasteIntoChatGptComposer(
  page: Page,
  text: string,
  opts: { minFillRatio?: number } = {},
): Promise<void> {
  const { minFillRatio = 0.5 } = opts;
  const expectedLen = text.length;

  await dismissBlockingModals(page);

  const composer = page.locator(COMPOSER_SELECTOR).first();
  await waitForComposerWithReload(page, composer);
  await composer.click();
  await page.waitForTimeout(300);

  // Clear any leftover content
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);

  // Primary: synthetic paste event with DataTransfer, dispatched on the
  // resolved DOM element (composer.evaluate passes the matched element in).
  // Lexical's paste handler reads clipboardData.getData('text/plain') and
  // preserves newlines, unlike .fill() which truncates to the first text node.
  await composer.evaluate((target: Element, textToInsert: string) => {
    (target as HTMLElement).focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', textToInsert);
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    target.dispatchEvent(pasteEvent);
  }, text);

  await page.waitForTimeout(1500);

  let actualLen = await readComposerLength(composer);
  console.log(`   [composer] Composer length after paste: ${actualLen}/${expectedLen} chars`);

  // In ChatGPT's "Extended" mode, long pastes are auto-converted into a
  // text-file ATTACHMENT instead of landing in the composer text. Detect that
  // case and accept it as a valid prompt delivery.
  if (actualLen < expectedLen * minFillRatio) {
    const attachmentPresent = await detectPastedAttachment(page, text);
    if (attachmentPresent) {
      console.log('   [composer] Composer empty but prompt landed as ATTACHMENT (Extended mode). Accepting.');
      return;
    }
    console.log('   [composer] Paste event undersized. Falling back to keyboard.insertText...');
    await composer.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
    await page.keyboard.insertText(text);
    await page.waitForTimeout(1500);
    actualLen = await readComposerLength(composer);
    console.log(`   [composer] Composer length after insertText: ${actualLen}/${expectedLen} chars`);
  }

  if (actualLen < expectedLen * minFillRatio) {
    // Final attachment check — insertText may have triggered the same Extended-mode conversion.
    const attachmentPresent = await detectPastedAttachment(page, text);
    if (attachmentPresent) {
      console.log('   [composer] Composer empty but prompt landed as ATTACHMENT (Extended mode). Accepting.');
      return;
    }
    throw new Error(
      `Prompt did not land in ChatGPT composer. Got ${actualLen} chars, expected ~${expectedLen}. ` +
      `No attachment chip detected either. Inspect the composer manually — selector or behavior may have changed.`
    );
  }
}

// Look for the "Extended-mode" attachment chip that ChatGPT creates when a
// long paste is auto-converted into a text file. Match on the leading
// characters of the prompt — that's what ChatGPT shows on the chip preview.
async function detectPastedAttachment(page: Page, text: string): Promise<boolean> {
  const preview = text.slice(0, 12).trim();
  if (!preview) return false;
  return await page.evaluate((needle: string) => {
    const all = Array.from(document.querySelectorAll('div, span, button, a'));
    return all.some(el => {
      const t = (el.textContent || '').trim();
      if (!t) return false;
      return t.length < 100 && t.startsWith(needle.slice(0, 10));
    });
  }, preview);
}

async function readComposerLength(composer: ReturnType<Page['locator']>): Promise<number> {
  return await composer.evaluate((el: Element) => ((el as HTMLElement).textContent || (el as HTMLElement).innerText || '').length);
}

/**
 * Deterministic alternative to pasteIntoChatGptComposer() for the huge
 * (40k+ character) blog/image master prompts. Instead of pasting the text
 * and hoping ChatGPT's own "Extended mode" auto-converts an oversized paste
 * into a file attachment — confirmed live to be inconsistent (a paste can
 * land as 0/12220 chars, fall back to keyboard.insertText, and only THEN get
 * detected as an attachment after the fact) — this writes the prompt to a
 * real local .txt file and attaches it directly via ChatGPT's own (visually
 * hidden but always-present) file input, the same pattern already used for
 * file uploads elsewhere in this repo (see src/browser/pdfhost/poster.ts,
 * src/browser/scribd/poster.ts). Falls back to pasteIntoChatGptComposer()
 * if no file input is found, so this can never become a hard blocker.
 */
export async function attachPromptAsTextFile(
  page: Page,
  text: string,
  opts: { filename?: string; instruction?: string } = {},
): Promise<void> {
  const filename = opts.filename || 'prompt.txt';
  const tmpPath = path.join(os.tmpdir(), `chatgpt-prompt-${Date.now()}-${filename}`);
  fs.writeFileSync(tmpPath, text, 'utf-8');

  try {
    await dismissBlockingModals(page);
    const composer = page.locator(COMPOSER_SELECTOR).first();
    await waitForComposerWithReload(page, composer);

    const fileInput = page.locator('input[type="file"]').first();
    const inputExists = await fileInput.count().then((n) => n > 0).catch(() => false);
    if (!inputExists) {
      console.log('   [composer] No file input found for direct attach — falling back to clipboard paste.');
      await pasteIntoChatGptComposer(page, text);
      return;
    }

    await fileInput.setInputFiles(tmpPath);
    await page.waitForTimeout(2500);

    const chipVisible = await page.getByText(filename, { exact: false }).first().isVisible({ timeout: 8000 }).catch(() => false);
    console.log(chipVisible
      ? '   [composer] Prompt file attached — confirmed chip visible.'
      : '   [composer] Prompt file attached — chip not confirmed visible, proceeding anyway.');

    if (opts.instruction) {
      await composer.click();
      await page.keyboard.insertText(opts.instruction);
      await page.waitForTimeout(300);
    }

    // Give the attachment a moment to finish uploading/processing before the
    // caller tries to hit Send — confirmed live 2026-09-28: sending too soon
    // after attach can silently no-op.
    await page.waitForTimeout(5000);
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}
