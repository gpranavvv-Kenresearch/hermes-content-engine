import type { BrowserContext } from 'playwright';
import { killChromeForProfile } from './killChrome.js';

/**
 * Playwright's context.close() can hang forever on Windows when the
 * underlying chrome.exe doesn't exit cleanly on a launchPersistentContext
 * profile. Every platform's login.ts awaited close() with only a .catch()
 * (which only handles rejection, not a promise that never settles), so one
 * stuck close() left that batch's promise pending forever — no error, no
 * crash, just silence — while the leaked Chrome process piled up until the
 * event loop stalled or Node ran out of memory. This races close() against a
 * timeout and force-kills the profile's Chrome process if it doesn't return.
 */
export async function safeCloseContext(
  context: BrowserContext | null,
  opts: { label: string; sessionDir?: string | null; timeoutMs?: number },
): Promise<void> {
  if (!context) return;
  const { label, sessionDir, timeoutMs = 10_000 } = opts;
  let settled = false;
  await Promise.race([
    context.close().catch(() => {}).then(() => { settled = true; }),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  if (!settled) {
    console.warn(`   ⚠️ ${label} browser close() did not return within ${timeoutMs}ms — force-killing Chrome process`);
    if (sessionDir) await killChromeForProfile(sessionDir).catch(() => {});
  } else {
    console.log(`   ${label} browser closed.`);
  }
}
