// Reliable text input for ChatGPT's Lexical/ProseMirror composer.
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
// doesn't take. Aborts hard if neither approach gets the full prompt in.

// Confirmed live 2026-09-24 via HTML dump: chatgpt.com/images (this
// script's page) uses a completely different editor than the main chat
// page — a ProseMirror contenteditable div with an aria-label along the
// lines of "Describe an image", not the Lexical #prompt-textarea. Kept
// both, comma-separated, in case either page variant is ever hit through
// this helper.
//
// The exact aria-label wording is NOT stable — confirmed live 2026-09-28
// ChatGPT silently changed it from "Describe an image" to "Describe a new
// image", which made the old exact-match selector match nothing and time
// out even though the composer was plainly visible on screen. Match on
// aria-label *containing* "Describe" (case-insensitive) instead of the
// full string, and also fall back to the generic ProseMirror class (same
// fallback the main chat composer selector in src/browser/chatgpt/login.ts
// uses) so a future wording change doesn't break this again.
const COMPOSER_SELECTOR = 'div[contenteditable="true"][aria-label*="Describe" i], div[contenteditable="true"].ProseMirror, #prompt-textarea';

// Same fix as src/utils/chatgptComposer.ts's waitForComposerWithReload: the
// composer sometimes never appears within a flat wait because chatgpt.com's
// own SPA render got stuck (e.g. right after a session was re-logged-in,
// or a stale tab) — a hard refresh clears that far more reliably than
// waiting longer on the same broken page.
async function waitForComposerWithReload(page, composer) {
  const visible = await composer.waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  if (visible) return;

  console.log('  [composer] Composer not visible — hard refreshing...');
  await page.waitForTimeout(5000);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(5000);

  const gotIt = page.getByRole('button', { name: 'Got it', exact: true }).first();
  if (await gotIt.isVisible({ timeout: 500 }).catch(() => false)) {
    await gotIt.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  await composer.waitFor({ state: 'visible', timeout: 15000 });
}

export async function pasteIntoChatGPTComposer(page, text, opts = {}) {
  const { minFillRatio = 0.5 } = opts;
  const expectedLen = text.length;

  // Remove any overlay modal that blocks interaction (e.g. conversation-history rate-limit)
  await page.evaluate(() => {
    const modal = document.querySelector(
      '#modal-conversation-history-rate-limit, [data-testid="modal-conversation-history-rate-limit"]'
    );
    if (modal) { modal.remove(); console.log('[composer] Removed blocking modal from DOM'); }
  });
  await page.waitForTimeout(300);

  // Page-wide fallback: ChatGPT's "Too many requests" rate-limit popup
  // doesn't always carry the named modal's id/data-testid above, so it can
  // survive the removal step. Click its "Got it" button wherever it is.
  const gotIt = page.getByRole('button', { name: 'Got it', exact: true }).first();
  if (await gotIt.isVisible({ timeout: 500 }).catch(() => false)) {
    await gotIt.click().catch(() => {});
    console.log('[composer] Dismissed "Got it" popup');
    await page.waitForTimeout(300);
  }

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
  // Playwright pierces shadow DOM to find #prompt-textarea; raw
  // document.querySelector inside page.evaluate does not — so use the
  // locator handle directly.
  // Lexical's paste handler reads clipboardData.getData('text/plain') and
  // preserves newlines, unlike .fill() which truncates to the first text node.
  await composer.evaluate((target, textToInsert) => {
    target.focus();
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
  console.log(`  Composer length after paste: ${actualLen}/${expectedLen} chars`);

  // In ChatGPT's new "Extended" mode, long pastes are auto-converted into a
  // text-file ATTACHMENT instead of landing in the composer text. Detect that
  // case and accept it as a valid prompt delivery.
  if (actualLen < expectedLen * minFillRatio) {
    const attachmentPresent = await detectPastedAttachment(page, text);
    if (attachmentPresent) {
      console.log('  Composer empty but prompt landed as ATTACHMENT (Extended mode). Accepting.');
      return;
    }
    console.log('  Paste event undersized. Falling back to keyboard.insertText...');
    await composer.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
    await page.keyboard.insertText(text);
    await page.waitForTimeout(1500);
    actualLen = await readComposerLength(composer);
    console.log(`  Composer length after insertText: ${actualLen}/${expectedLen} chars`);
  }

  if (actualLen < expectedLen * minFillRatio) {
    // Final attachment check — insertText may have triggered the same Extended-mode conversion.
    const attachmentPresent = await detectPastedAttachment(page, text);
    if (attachmentPresent) {
      console.log('  Composer empty but prompt landed as ATTACHMENT (Extended mode). Accepting.');
      return;
    }
    throw new Error(
      `Prompt did not land in ChatGPT composer. Got ${actualLen} chars, expected ~${expectedLen}. ` +
      `No attachment chip detected either. The Lexical composer rejected paste-event and keyboard.insertText. ` +
      `Inspect the composer manually — selector or behavior may have changed.`
    );
  }
}

// Look for the "Extended-mode" attachment chip that ChatGPT creates when a
// long paste is auto-converted into a text file. Match on the leading 12-20
// characters of the prompt — that's what ChatGPT shows on the chip preview.
async function detectPastedAttachment(page, text) {
  const preview = text.slice(0, 12).trim();
  if (!preview) return false;
  return await page.evaluate((needle) => {
    // 1. Search for any element whose text begins with the prompt's first chars
    //    (the chip preview), inside the composer area / above the text input.
    const all = Array.from(document.querySelectorAll('div, span, button, a'));
    return all.some(el => {
      const t = (el.textContent || '').trim();
      if (!t) return false;
      // Chip text is typically a short truncation like "Act as a pre.."
      // Match if first 10 chars line up
      return t.length < 100 && t.startsWith(needle.slice(0, 10));
    });
  }, preview);
}

async function readComposerLength(composer) {
  return await composer.evaluate(el => (el.textContent || el.innerText || '').length);
}
