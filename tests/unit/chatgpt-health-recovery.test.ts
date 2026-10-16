import { describe, expect, it } from 'vitest';
import { EngineError } from '../../src/errors.js';
import { FakeChatGptServer, type FakeMode } from '../fixtures/chatgpt/fake-page.js';
import {
  RecoveryPolicy,
  classifyBrowserError,
  createRecoveryPolicy,
  needsRelaunch,
  parseRetryAfterMs,
} from '../../src/chatgpt/recovery-policy.js';
import { SelectorNotFoundError } from '../../src/chatgpt/selectors.js';
import { checkHealth, healthToError, type DiagnosticArtifact } from '../../src/chatgpt/session-health.js';

async function pageIn(mode: FakeMode, url = 'https://chatgpt.com/?model=x') {
  const server = new FakeChatGptServer();
  server.mode = mode;
  const page = server.newPage();
  await page.goto(url);
  return page;
}

describe('checkHealth', () => {
  it.each([
    ['ready', 'ready'],
    ['login', 'login_required'],
    ['challenge', 'challenge'],
    ['rate_limit', 'rate_limited'],
    ['ui_changed', 'unknown_ui'],
  ] as const)('mode %s -> %s', async (mode, expected) => {
    const report = await checkHealth(await pageIn(mode), { composerTimeoutMs: 5 });
    expect(report.state).toBe(expected);
    expect(report.evidence.length).toBeGreaterThan(0);
  });

  it('parses retry-after from the rate-limit text', async () => {
    const report = await checkHealth(await pageIn('rate_limit'), { composerTimeoutMs: 5 });
    expect(report.retryAfterMs).toBe(120_000);
    const err = healthToError(report)!;
    expect(err.category).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(120_000);
  });

  it('a logged-out page still shows a composer, but is login_required, not ready', async () => {
    const page = await pageIn('login');
    expect(await page.waitForSelector('#prompt-textarea')).toBeDefined();
    expect((await checkHealth(page, { composerTimeoutMs: 5 })).state).toBe('login_required');
  });

  it('writes a diagnostic (screenshot + metadata, no query string) only when not ready', async () => {
    const written: DiagnosticArtifact[] = [];
    const writer = async (a: DiagnosticArtifact) => {
      written.push(a);
    };
    await checkHealth(await pageIn('ready'), { writer, composerTimeoutMs: 5 });
    expect(written).toHaveLength(0);

    await checkHealth(await pageIn('login'), { writer, composerTimeoutMs: 5, now: () => new Date('2026-01-02T03:04:05Z') });
    expect(written).toHaveLength(1);
    const a = written[0]!;
    expect(a.state).toBe('login_required');
    expect(a.url).toBe('https://chatgpt.com/');
    expect(a.screenshot).toBeInstanceOf(Uint8Array);
    expect(a.capturedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(a.title).toBe('ChatGPT');
  });

  it('a failing diagnostic writer never masks the health result', async () => {
    const report = await checkHealth(await pageIn('challenge'), {
      composerTimeoutMs: 5,
      writer: async () => {
        throw new Error('disk full');
      },
    });
    expect(report.state).toBe('challenge');
  });

  it('propagates a closed page so recovery can relaunch', async () => {
    const page = await pageIn('ready');
    page.crash();
    await expect(checkHealth(page)).rejects.toThrow(/closed/);
  });
});

describe('classifyBrowserError', () => {
  const named = (name: string, message: string) => Object.assign(new Error(message), { name });

  it('closed target / page -> retryable + needs relaunch', () => {
    for (const e of [
      named('TargetClosedError', 'x'),
      new Error('Target page, context or browser has been closed'),
      new Error('page.click: Target closed'),
      new Error('Browser has been closed'),
    ]) {
      const c = classifyBrowserError(e);
      expect(c.category).toBe('retryable');
      expect(needsRelaunch(c)).toBe(true);
    }
  });

  it('Playwright TimeoutError -> retryable without relaunch', () => {
    const c = classifyBrowserError(named('TimeoutError', 'page.waitForSelector: Timeout 15000ms exceeded.'));
    expect(c.category).toBe('retryable');
    expect(needsRelaunch(c)).toBe(false);
  });

  it('selector-not-found stays needs_human', () => {
    const e = new SelectorNotFoundError('composer', ['a', 'b']);
    expect(classifyBrowserError(e)).toBe(e);
    expect(e.category).toBe('needs_human');
  });

  it('login wall -> auth_required; captcha -> needs_human; rate-limit -> rate_limited with retryAfterMs', () => {
    expect(classifyBrowserError(new Error('Login required to continue')).category).toBe('auth_required');
    expect(classifyBrowserError(new Error('Please complete the CAPTCHA')).category).toBe('needs_human');
    const rl = classifyBrowserError(new Error('Too many requests. Try again in 15 minutes.'));
    expect(rl.category).toBe('rate_limited');
    expect(rl.retryAfterMs).toBe(15 * 60_000);
    expect(classifyBrowserError(new Error('rate limit hit')).retryAfterMs).toBeUndefined();
  });

  it('unknown errors stay unknown (never retried)', () => {
    expect(classifyBrowserError(new Error('boom')).category).toBe('unknown');
  });

  it('parseRetryAfterMs handles units', () => {
    expect(parseRetryAfterMs('try again in 30 seconds')).toBe(30_000);
    expect(parseRetryAfterMs('after about 2 hours')).toBe(7_200_000);
    expect(parseRetryAfterMs('nothing here')).toBeUndefined();
  });
});

const fast = { initialDelayMs: 1, maxDelayMs: 2, rateLimitDefaultWaitMs: 2, rateLimitMaxWaitMs: 50, breakerThreshold: 100 };
const boom = (category: ConstructorParameters<typeof EngineError>[1]) => new EngineError('x', category, 'X');

describe('RecoveryPolicy', () => {
  it('retries retryable errors with a bounded attempt count', async () => {
    const p = createRecoveryPolicy({ ...fast, maxAttempts: 3 });
    let calls = 0;
    const out = await p.execute(async ({ attempt }) => {
      calls++;
      if (attempt < 3) throw boom('retryable');
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(3);

    let exhausted = 0;
    await expect(
      p.execute(async () => {
        exhausted++;
        throw boom('retryable');
      }),
    ).rejects.toMatchObject({ category: 'retryable' });
    expect(exhausted).toBe(3);
  });

  it.each(['auth_required', 'needs_human', 'fatal', 'unknown'] as const)('NEVER retries %s', async (category) => {
    const p = createRecoveryPolicy({ ...fast, maxAttempts: 5 });
    let calls = 0;
    await expect(
      p.execute(async () => {
        calls++;
        throw boom(category);
      }),
    ).rejects.toMatchObject({ category });
    expect(calls).toBe(1);
  });

  it('rate_limited waits and allows at most ONE retry', async () => {
    const p = createRecoveryPolicy({ ...fast, maxAttempts: 5 });
    let calls = 0;
    const started = Date.now();
    await expect(
      p.execute(async () => {
        calls++;
        throw new EngineError('slow down', 'rate_limited', 'RATE_LIMITED', { retryAfterMs: 20 });
      }),
    ).rejects.toMatchObject({ category: 'rate_limited' });
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);

    let ok = 0;
    const result = await p.execute(async ({ attempt }) => {
      ok++;
      if (attempt === 1) throw new EngineError('slow down', 'rate_limited', 'RATE_LIMITED', { retryAfterMs: 1 });
      return 'fine';
    });
    expect(result).toBe('fine');
    expect(ok).toBe(2);
  });

  it('does not wait out a rate limit longer than the cap; it surfaces it with retryAfterMs', async () => {
    const p = createRecoveryPolicy({ ...fast, maxAttempts: 5 });
    let calls = 0;
    const err = await p
      .execute(async () => {
        calls++;
        throw new EngineError('daily cap', 'rate_limited', 'RATE_LIMITED', { retryAfterMs: 3_600_000 });
      })
      .catch((e: unknown) => e as EngineError);
    expect(calls).toBe(1);
    expect(err.retryAfterMs).toBe(3_600_000);
  });

  it('classifies raw thrown errors', async () => {
    const p = createRecoveryPolicy({ ...fast, maxAttempts: 2 });
    let calls = 0;
    const out = await p.execute(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('Target closed'), { name: 'TargetClosedError' });
      return 7;
    });
    expect(out).toBe(7);
  });

  it('circuit breaker opens after N consecutive failures, fails fast, and exposes the state', async () => {
    const p = new RecoveryPolicy({ ...fast, maxAttempts: 1, breakerThreshold: 3, breakerHalfOpenAfterMs: 60_000 });
    expect(p.breakerState).toBe('closed');
    let calls = 0;
    const fail = () =>
      p.execute(async () => {
        calls++;
        throw boom('retryable');
      });
    for (let i = 0; i < 3; i++) await expect(fail()).rejects.toMatchObject({ code: 'X' });
    expect(p.breakerState).toBe('open');
    expect(p.isPaused).toBe(true);

    const before = calls;
    await expect(fail()).rejects.toMatchObject({ code: 'ACCOUNT_PAUSED', category: 'needs_human' });
    expect(calls).toBe(before); // fn not even invoked
  });

  it('a success resets the consecutive-failure count', async () => {
    const p = new RecoveryPolicy({ ...fast, maxAttempts: 1, breakerThreshold: 3 });
    const fail = () => p.execute(async () => Promise.reject(boom('retryable')));
    await expect(fail()).rejects.toBeDefined();
    await expect(fail()).rejects.toBeDefined();
    await p.execute(async () => 'ok');
    await expect(fail()).rejects.toBeDefined();
    await expect(fail()).rejects.toBeDefined();
    expect(p.breakerState).toBe('closed');
  });
});
