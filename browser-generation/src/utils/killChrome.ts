import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Kill any Chrome processes that are using the given user-data-dir profile,
 * and remove stale singleton lock files. This prevents the "Opening in existing
 * browser session" error when Playwright tries to launch with that profile.
 *
 * Must stay async — this runs before every login across 45+ accounts, and a
 * synchronous PowerShell spawn here previously froze the Node event loop for
 * the shell's entire runtime, stalling the cron scheduler for extended periods.
 */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function killChromeForProfile(sessionDir: string): Promise<void> {
  const absDir = path.resolve(sessionDir);

  // Kill Chrome processes whose command line contains this user-data-dir
  let killedAny = false;
  try {
    // Get-CimInstance (WinRM/DCOM-free) is markedly faster than the legacy
    // Get-WmiObject — this runs before every login across 45+ accounts, so the
    // per-call cost matters.
    // Confirmed live 2026-09-24: doubling backslashes here was wrong for a
    // single-quoted PowerShell string — backslash isn't an escape character
    // there (or in -like's wildcard syntax), so the doubled pattern (e.g.
    // "C:\\Users\\...") could never match Chrome's real single-backslash
    // command line ("C:\Users\..."). This silently no-op'd the kill on every
    // call, every profile, leaving stale Chrome processes holding the
    // profile lock for the next launch to collide with ("Opening in
    // existing browser session" / "Target page ... has been closed"). Only
    // single quotes themselves need escaping in a PowerShell single-quoted
    // string, by doubling them.
    const script = `
      $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue
      $matched = @($procs | Where-Object { $_.CommandLine -and $_.CommandLine -like '*${absDir.replace(/'/g, "''")}*' })
      foreach ($p in $matched) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      }
      $matched.Count
    `;
    const { stdout } = await execAsync(`powershell -NoProfile -Command "${script.replace(/\n\s*/g, ' ')}"`, {
      timeout: 8000,
    });
    killedAny = parseInt(stdout.trim(), 10) > 0;
  } catch {
    // Non-fatal — best effort
  }

  // Stop-Process returns before Windows has necessarily released the
  // process's open file handles (the profile's lock files, LevelDB, etc).
  // Launching a new persistent context immediately after can race that
  // teardown and hit "Target page, context or browser has been closed" or
  // "Opening in existing browser session" even though the kill "succeeded".
  // A short wait gives the OS time to actually free the handles.
  if (killedAny) {
    await sleep(500);
  }

  // Remove stale lock files (both root-level singleton locks and Default/LOCK from LevelDB)
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) {
    const lockPath = path.join(absDir, lockFile);
    if (fs.existsSync(lockPath)) {
      try { fs.rmSync(lockPath); } catch {}
    }
  }
  // LevelDB LOCK in Default profile — can cause "Opening in existing browser session" if stale
  const defaultLock = path.join(absDir, 'Default', 'LOCK');
  if (fs.existsSync(defaultLock)) {
    try { fs.rmSync(defaultLock); } catch {}
  }
}
