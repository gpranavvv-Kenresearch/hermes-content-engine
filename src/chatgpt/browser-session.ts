import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineError } from '../errors.js';
import type { BrowserSessionLike, ContextLike, PageLike } from './page-like.js';

/** Standalone engine root (src/chatgpt/ -> ../../). */
const ENGINE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Any resolved profile path containing this fragment belongs to the live legacy repo. */
const LEGACY_REPO_FRAGMENT = 'x-posting-agent';

export const PROFILE_ENV_VAR = 'CE_CHATGPT_PROFILE_DIR';
export const LOCK_FILE_NAME = '.ce-profile.lock';

export class UnsafeProfileDirError extends EngineError {
  constructor(dir: string, why: string) {
    super(`Refusing ChatGPT profile dir "${dir}": ${why}`, 'fatal', 'PROFILE_DIR_UNSAFE', { detail: { dir } });
  }
}

export class ProfileLockedError extends EngineError {
  constructor(lockPath: string, holderPid: number | undefined) {
    super(
      `ChatGPT profile is already in use (lock ${lockPath}, pid ${holderPid ?? 'unknown'}). A profile must never be opened by two processes.`,
      'fatal',
      'PROFILE_LOCKED',
      { detail: { lockPath, holderPid } },
    );
  }
}

/** Resolves the profile dir from env (default .sessions/chatgpt-engine under the engine root). */
export function resolveProfileDir(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[PROFILE_ENV_VAR]?.trim();
  return path.resolve(fromEnv ? fromEnv : path.join(ENGINE_ROOT, '.sessions', 'chatgpt-engine'));
}

function isInside(child: string, parent: string): boolean {
  const norm = (p: string): string => path.resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(`${p}/`);
}

function realpathOfNearestAncestor(p: string): string {
  let current = p;
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return path.join(real, path.relative(current, p));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p;
      current = parent;
    }
  }
}

/**
 * Throws unless `dir` is safe to use as the engine's own profile. Refuses
 * anything inside (or equal to) the legacy x-posting-agent repo, checking both
 * the literal resolved path and the real path (symlink / junction targets).
 */
export function assertSafeProfileDir(dir: string): string {
  if (!dir || !dir.trim()) throw new UnsafeProfileDirError(dir, 'empty path');
  const resolved = path.resolve(dir);
  const candidates: Array<{ path: string; engineRoot: string }> = [
    { path: resolved, engineRoot: ENGINE_ROOT },
    { path: realpathOfNearestAncestor(resolved), engineRoot: realpathOfNearestAncestor(ENGINE_ROOT) },
  ];
  for (const c of candidates) {
    // The standalone engine's own profile is allowed; legacy posting-agent profiles stay refused.
    if (isInside(c.path, c.engineRoot)) continue;
    if (c.path.replace(/\\/g, '/').toLowerCase().includes(LEGACY_REPO_FRAGMENT)) {
      throw new UnsafeProfileDirError(dir, `path is inside the legacy "${LEGACY_REPO_FRAGMENT}" repo, which is shared with a live production daemon`);
    }
  }
  return resolved;
}

// --- Profile lock ------------------------------------------------------------

interface LockInfo {
  pid: number;
  token: string;
  startedAt: string;
}

export type PidAliveFn = (pid: number) => boolean;

export const defaultIsPidAlive: PidAliveFn = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

function readLock(lockPath: string): LockInfo | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid === 'number' && typeof parsed.token === 'string') {
      return { pid: parsed.pid, token: parsed.token, startedAt: String(parsed.startedAt ?? '') };
    }
  } catch {
    // unreadable or corrupt: treated as stale by the caller
  }
  return undefined;
}

export interface ProfileLock {
  readonly lockPath: string;
  release(): void;
}

/**
 * Exclusive lock for one profile dir: a file created with the 'wx' flag holding
 * pid + token. A lock whose pid is dead (or whose file is corrupt) is stale and
 * is taken over. Our own pid counts as live, so double-opening within one
 * process is refused too.
 * Known narrow race: two processes taking over the SAME stale lock at the same
 * instant. The 'wx' create after the unlink arbitrates, so at most one wins;
 * the loser gets ProfileLockedError.
 */
export function acquireProfileLock(
  profileDir: string,
  options: { isPidAlive?: PidAliveFn; pid?: number } = {},
): ProfileLock {
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const pid = options.pid ?? process.pid;
  fs.mkdirSync(profileDir, { recursive: true });
  const lockPath = path.join(profileDir, LOCK_FILE_NAME);
  const token = randomUUID();
  const body = JSON.stringify({ pid, token, startedAt: new Date().toISOString() } satisfies LockInfo);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, body, { flag: 'wx' });
      let released = false;
      return {
        lockPath,
        release() {
          if (released) return;
          released = true;
          const current = readLock(lockPath);
          if (current && current.token !== token) return; // someone else owns it now; never delete theirs
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // already gone
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const holder = readLock(lockPath);
      if (holder && isPidAlive(holder.pid)) throw new ProfileLockedError(lockPath, holder.pid);
      // stale (dead pid or corrupt file): remove and retry the exclusive create once
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // lost the takeover race; the retry will report it
      }
    }
  }
  throw new ProfileLockedError(lockPath, readLock(lockPath)?.pid);
}

// --- Session -----------------------------------------------------------------

export interface LaunchOptions {
  profileDir: string;
  headless: boolean;
  args: string[];
}

export type LaunchFn = (options: LaunchOptions) => Promise<ContextLike>;

/**
 * Default launcher: plain Playwright, persistent real Chrome profile
 * (channel 'chrome'), no Stagehand. The playwright import is lazy so merely
 * importing this module never loads a browser stack.
 */
export const defaultLaunch: LaunchFn = async ({ profileDir, headless, args }) => {
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless,
    viewport: null,
    args,
  });
  return context as unknown as ContextLike;
};

export interface BrowserSessionOptions {
  profileDir?: string;
  headless?: boolean;
  launch?: LaunchFn;
  env?: Record<string, string | undefined>;
  isPidAlive?: PidAliveFn;
}

export class BrowserSession implements BrowserSessionLike {
  private context: ContextLike | undefined;
  private lock: ProfileLock | undefined;
  private closed = false;

  private constructor(
    readonly profileDir: string,
    private readonly headless: boolean,
    private readonly launch: LaunchFn,
  ) {}

  static async create(options: BrowserSessionOptions = {}): Promise<BrowserSession> {
    const profileDir = assertSafeProfileDir(options.profileDir ?? resolveProfileDir(options.env));
    const session = new BrowserSession(profileDir, options.headless ?? false, options.launch ?? defaultLaunch);
    session.lock = acquireProfileLock(profileDir, options.isPidAlive ? { isPidAlive: options.isPidAlive } : {});
    try {
      await session.open();
    } catch (e) {
      session.lock.release();
      session.lock = undefined;
      throw e;
    }
    return session;
  }

  private async open(): Promise<void> {
    this.context = await this.launch({
      profileDir: this.profileDir,
      headless: this.headless,
      args: ['--no-first-run', '--no-default-browser-check'],
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.context !== undefined;
  }

  async getPage(): Promise<PageLike> {
    if (this.closed || !this.context) throw new Error('Browser session is closed');
    const live = this.context.pages().filter((p) => !p.isClosed());
    const last = live[live.length - 1];
    return last ?? (await this.context.newPage());
  }

  async relaunch(): Promise<void> {
    if (this.closed) throw new Error('Browser session is closed');
    const old = this.context;
    this.context = undefined;
    if (old) await old.close().catch(() => undefined);
    await this.open(); // lock is kept the whole time: the profile is never "free" in between
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const ctx = this.context;
    this.context = undefined;
    try {
      if (ctx) await ctx.close().catch(() => undefined);
    } finally {
      this.lock?.release();
      this.lock = undefined;
    }
  }
}

export function createBrowserSession(options: BrowserSessionOptions = {}): Promise<BrowserSession> {
  return BrowserSession.create(options);
}
