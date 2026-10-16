import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import {
  LOCK_FILE_NAME,
  ProfileLockedError,
  UnsafeProfileDirError,
  acquireProfileLock,
  assertSafeProfileDir,
  createBrowserSession,
  resolveProfileDir,
} from '../../src/chatgpt/browser-session.js';
import type { ContextLike, PageLike } from '../../src/chatgpt/page-like.js';
import { SELECTORS, SelectorNotFoundError, waitForFirst } from '../../src/chatgpt/selectors.js';
import { FakeChatGptServer, timeoutError } from '../fixtures/chatgpt/fake-page.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-session-test-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('structural typing against real Playwright', () => {
  it('real Page and BrowserContext satisfy PageLike / ContextLike', () => {
    // Compile-time check only (tsc --noEmit). Nothing is launched.
    const p: PageLike = {} as Page;
    const c: ContextLike = {} as BrowserContext;
    expect(p).toBeDefined();
    expect(c).toBeDefined();
  });
});

describe('selectors', () => {
  it('every group is a non-empty ordered list with unique names', () => {
    for (const [group, list] of Object.entries(SELECTORS)) {
      expect(list.length, group).toBeGreaterThan(0);
      expect(new Set(list.map((s) => s.name)).size, group).toBe(list.length);
    }
  });

  it('falls back to the next selector and reports needs_human once all are exhausted', async () => {
    const onlySecond = {
      waitForSelector: async (css: string) => {
        if (css === SELECTORS.composer[1].css) return {};
        throw timeoutError();
      },
    } as unknown as PageLike;
    const hit = await waitForFirst(onlySecond, 'composer', { timeoutMs: 5, fallbackTimeoutMs: 5 });
    expect(hit.name).toBe('prosemirror');

    const none = {
      waitForSelector: async () => {
        throw timeoutError();
      },
    } as unknown as PageLike;
    const err = await waitForFirst(none, 'composer', { timeoutMs: 5, fallbackTimeoutMs: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SelectorNotFoundError);
    expect((err as SelectorNotFoundError).category).toBe('needs_human');
    expect((err as SelectorNotFoundError).detail?.tried).toEqual(SELECTORS.composer.map((s) => s.name));
  });

  it('does not swallow non-timeout errors (closed target must reach recovery)', async () => {
    const closed = {
      waitForSelector: async () => {
        throw Object.assign(new Error('Target closed'), { name: 'TargetClosedError' });
      },
    } as unknown as PageLike;
    await expect(waitForFirst(closed, 'composer')).rejects.toThrow(/Target closed/);
  });
});

describe('profile dir guard', () => {
  it('rejects paths inside the legacy x-posting-agent repo, any case or separator', () => {
    expect(() => assertSafeProfileDir('C:\\work\\x-posting-agent\\.sessions\\chatgpt')).toThrow(UnsafeProfileDirError);
    expect(() => assertSafeProfileDir('C:/work/X-Posting-Agent')).toThrow(UnsafeProfileDirError);
    expect(() => assertSafeProfileDir(path.join(path.parse(process.cwd()).root, 'somewhere', 'x-posting-agent', 'p'))).toThrow(UnsafeProfileDirError);
    expect(() => assertSafeProfileDir('')).toThrow(UnsafeProfileDirError);
  });

  it('accepts an engine-owned directory and resolves it', () => {
    expect(assertSafeProfileDir(path.join(tmp, 'profile'))).toBe(path.resolve(tmp, 'profile'));
  });

  it('resolveProfileDir honours CE_CHATGPT_PROFILE_DIR and defaults inside the engine, never the legacy repo', () => {
    expect(resolveProfileDir({ CE_CHATGPT_PROFILE_DIR: tmp })).toBe(path.resolve(tmp));
    const def = resolveProfileDir({});
    expect(def.replace(/\\/g, '/')).toMatch(/\.sessions\/chatgpt-engine$/);
    expect(def.replace(/\\/g, '/').toLowerCase()).toContain('/hermes content engine/.sessions/');
    // The standalone engine owns its profile; the legacy posting-agent profiles remain off limits.
    expect(() => assertSafeProfileDir(def)).not.toThrow();
    const legacy = path.join(process.cwd(), '..', 'Read Me', 'reponse', 'x-posting-agent');
    expect(() => assertSafeProfileDir(path.join(legacy, 'li-sessions', 'x'))).toThrow(UnsafeProfileDirError);
    expect(() => assertSafeProfileDir(path.join(legacy, '.sessions', 'chatgpt'))).toThrow(UnsafeProfileDirError);
  });

  it('createBrowserSession refuses a legacy path before launching anything', async () => {
    let launched = 0;
    await expect(
      createBrowserSession({
        profileDir: 'C:\\somewhere\\x-posting-agent\\.sessions\\chatgpt',
        launch: async () => {
          launched++;
          return {} as ContextLike;
        },
      }),
    ).rejects.toBeInstanceOf(UnsafeProfileDirError);
    expect(launched).toBe(0);
  });
});

describe('profile lock', () => {
  const alive = () => true;
  const dead = () => false;

  it('prevents opening the same profile twice and is released by release()', () => {
    const dir = path.join(tmp, 'p1');
    const a = acquireProfileLock(dir, { isPidAlive: alive });
    expect(() => acquireProfileLock(dir, { isPidAlive: alive })).toThrow(ProfileLockedError);
    a.release();
    const b = acquireProfileLock(dir, { isPidAlive: alive });
    b.release();
    expect(fs.existsSync(path.join(dir, LOCK_FILE_NAME))).toBe(false);
  });

  it('recovers from a stale lock whose pid is dead', () => {
    const dir = path.join(tmp, 'p2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LOCK_FILE_NAME), JSON.stringify({ pid: 424242, token: 'old', startedAt: 'x' }));
    const lock = acquireProfileLock(dir, { isPidAlive: dead });
    const body = JSON.parse(fs.readFileSync(lock.lockPath, 'utf8')) as { pid: number; token: string };
    expect(body.token).not.toBe('old');
    lock.release();
  });

  it('treats a corrupt lock file as stale', () => {
    const dir = path.join(tmp, 'p3');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LOCK_FILE_NAME), 'not json');
    acquireProfileLock(dir, { isPidAlive: alive }).release();
  });

  it('a live holder is never taken over, and release never deletes a lock it no longer owns', () => {
    const dir = path.join(tmp, 'p4');
    const first = acquireProfileLock(dir, { isPidAlive: alive });
    fs.writeFileSync(first.lockPath, JSON.stringify({ pid: 1, token: 'someone-else', startedAt: 'x' }));
    first.release();
    expect(fs.existsSync(first.lockPath)).toBe(true);
  });

  it('a real session holds the lock until close(), keeps it across relaunch, and releases it if launch fails', async () => {
    const dir = path.join(tmp, 'p5');
    let launches = 0;
    const launch = async (): Promise<ContextLike> => {
      launches++;
      return {
        pages: () => [],
        newPage: async () => new FakeChatGptServer().newPage(),
        close: async () => undefined,
      };
    };
    const s = await createBrowserSession({ profileDir: dir, launch, isPidAlive: alive });
    await expect(createBrowserSession({ profileDir: dir, launch, isPidAlive: alive })).rejects.toBeInstanceOf(ProfileLockedError);
    expect(launches).toBe(1);

    await s.relaunch();
    expect(launches).toBe(2);
    await expect(createBrowserSession({ profileDir: dir, launch, isPidAlive: alive })).rejects.toBeInstanceOf(ProfileLockedError);

    await s.close();
    await s.close(); // idempotent
    const again = await createBrowserSession({ profileDir: dir, launch, isPidAlive: alive });
    await again.close();

    const failing = createBrowserSession({
      profileDir: dir,
      isPidAlive: alive,
      launch: async () => {
        throw new Error('chrome missing');
      },
    });
    await expect(failing).rejects.toThrow('chrome missing');
    const afterFail = await createBrowserSession({ profileDir: dir, launch, isPidAlive: alive });
    await afterFail.close();
  });
});
