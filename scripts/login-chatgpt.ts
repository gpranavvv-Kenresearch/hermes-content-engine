/**
 * One-time interactive login for the content-engine's DEDICATED ChatGPT profile.
 *
 *   npx tsx scripts/login-chatgpt.ts
 *
 * Opens a HEADED Chrome window on the profile in CE_CHATGPT_PROFILE_DIR
 * (default .sessions/chatgpt-engine). YOU log in by hand; this script never
 * sees or stores credentials. It only reports whether the composer is visible
 * so you know the session is saved. Press Enter in this terminal when done.
 *
 * Safety: refuses any profile inside the legacy x-posting-agent repo and any
 * profile another process has open (lock file). Always releases the lock.
 */
import { createInterface } from 'node:readline/promises';
import { createBrowserSession } from '../src/chatgpt/browser-session.js';
import { checkHealth } from '../src/chatgpt/session-health.js';

async function main(): Promise<void> {
  const session = await createBrowserSession({ headless: false });
  let exiting = false;
  const finish = async (code: number): Promise<never> => {
    if (!exiting) {
      exiting = true;
      await session.close().catch(() => undefined);
    }
    process.exit(code);
  };
  process.once('SIGINT', () => void finish(130));
  process.once('SIGTERM', () => void finish(143));

  try {
    console.log(`Profile directory: ${session.profileDir}`);
    const page = await session.getPage();
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });

    console.log('');
    console.log('A Chrome window is open on chatgpt.com.');
    console.log('  1. Log in to the ChatGPT account the engine should use (complete any verification yourself).');
    console.log('  2. Wait until you see the normal chat screen with the message box.');
    console.log('  3. Come back to this terminal and press Enter.');
    console.log('This script never reads or stores your password; the browser profile keeps the session.');
    console.log('');

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question('Press Enter once you are logged in... ');
    rl.close();

    const report = await checkHealth(page, { composerTimeoutMs: 10_000 });
    if (report.state === 'ready') {
      console.log(`OK: session looks ready (${report.evidence}). The login is saved in the profile.`);
    } else {
      console.log(`NOT READY: state=${report.state} (${report.evidence}).`);
      console.log('Re-run this script and finish logging in, or solve any challenge shown in the window.');
      await finish(2);
    }
  } finally {
    if (!exiting) {
      exiting = true;
      await session.close().catch(() => undefined);
    }
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
