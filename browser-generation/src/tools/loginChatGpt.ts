/**
 * loginChatGpt.ts — Standalone ChatGPT login + session saver
 *
 * Usage:
 *   npx tsx src/tools/loginChatGpt.ts                 (logs into the "default" account)
 *   npx tsx src/tools/loginChatGpt.ts account2          (logs into a named account for rotation)
 *
 * Opens a real Chrome window at chatgpt.com using the persistent session
 * folder for the given account (.sessions/chatgpt for "default", or
 * .sessions/chatgpt-accounts/<name> for any other name). If not already
 * logged in, log in by hand in the browser, then come back to this terminal
 * and press Enter to confirm. The session is then saved to disk — every
 * future run (this script or the generate scripts) reuses it without
 * logging in again.
 *
 * To set up multi-account rotation: log into each account you want in the
 * pool this way (e.g. "default", "account2", "account3"). The generate
 * scripts automatically rotate to the next saved account after
 * ROTATE_AFTER_FAILURES consecutive ChatGPT failures.
 */

import 'dotenv/config';
import { ensureChatGptPageInteractive, closeChatGptBrowser } from '../browser/chatgpt/login.js';

async function main(): Promise<void> {
  const accountName = process.argv[2] || 'default';
  console.log(`Opening ChatGPT (account: ${accountName})...`);
  await ensureChatGptPageInteractive(accountName);
  console.log('✅ Session saved. You can close this now — future runs will reuse it.');
  await closeChatGptBrowser();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
