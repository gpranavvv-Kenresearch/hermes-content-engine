// The shared ensureChatGptPage() force-kills any Chrome already using the
// ChatGPT profile before launching. That is fine for the daemon, but from
// these test scripts it can kill the daemon's live blog-generation Chrome
// mid-session (cookies unflushed -> logged out). So: look first, and refuse
// to launch if another Chrome is holding this profile.
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execAsync = promisify(exec);

export async function assertProfileFree(accountName: string): Promise<void> {
  const profileDir = path.resolve('.sessions', 'chatgpt-accounts', accountName);
  const script = `
    $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue
    @($procs | Where-Object { $_.CommandLine -and $_.CommandLine -like '*chatgpt-accounts*${accountName}*' -and $_.CommandLine -notlike '*--type=*' }).Count
  `;
  let count = 0;
  try {
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${script.replace(/\n\s*/g, ' ')}"`, { timeout: 8000 });
    count = parseInt(stdout.trim(), 10) || 0;
  } catch {
    return; // can't check -> don't block
  }
  if (count > 0) {
    throw new Error(
      `ChatGPT profile "${accountName}" (${profileDir}) is in use by another Chrome (likely the npm run dev daemon). ` +
      `Refusing to launch, because that would force-kill it and can log the account out. ` +
      `Use a different --account, or wait until the daemon is idle.`
    );
  }
}
