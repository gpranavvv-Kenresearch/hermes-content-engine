import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, BudgetExceededError, ShutdownError, TimeoutError } from '../../src/errors.js';
import { Budget } from '../../src/safety/budget.js';
import { assertCanPublish, canPublish, loadFlags } from '../../src/safety/flags.js';
import { decideGenerationRetry, decidePublicationRetry, publicationKey } from '../../src/safety/reconcile.js';
import { ShutdownController } from '../../src/safety/shutdown.js';
import { withTimeout } from '../../src/safety/timeouts.js';

afterEach(() => vi.useRealTimers());

describe('flags (fail closed)', () => {
  it('defaults to dry_run + shadow_mode ON and no platforms enabled', () => {
    const flags = loadFlags({});
    expect(flags.dryRun).toBe(true);
    expect(flags.shadowMode).toBe(true);
    expect(flags.enabledPlatforms.size).toBe(0);
    expect(canPublish(flags, 'x')).toBe(false);
  });

  it('rejects garbage values instead of treating them as "off"', () => {
    expect(() => loadFlags({ CE_DRY_RUN: 'maybe' })).toThrow(ConfigError);
    expect(() => loadFlags({ CE_PLATFORMS_ENABLED: 'x,myspace' })).toThrow(/unknown platform/);
    expect(() => loadFlags({ CE_MAX_CHATGPT_CALLS: '-3' })).toThrow(ConfigError);
  });

  it('only allows publishing when dryRun and shadowMode are off AND the platform is enabled', () => {
    const live = loadFlags({ CE_DRY_RUN: 'false', CE_SHADOW_MODE: 'false', CE_PLATFORMS_ENABLED: 'x' });
    expect(canPublish(live, 'x')).toBe(true);
    expect(canPublish(live, 'facebook')).toBe(false);
    expect(() => assertCanPublish(live, 'facebook')).toThrow(ConfigError);

    for (const env of [
      { CE_DRY_RUN: 'true', CE_SHADOW_MODE: 'false', CE_PLATFORMS_ENABLED: 'x' },
      { CE_DRY_RUN: 'false', CE_SHADOW_MODE: 'true', CE_PLATFORMS_ENABLED: 'x' },
    ]) {
      expect(canPublish(loadFlags(env), 'x')).toBe(false);
    }
  });
});

describe('budget', () => {
  it('allows work up to the limit and then throws', () => {
    const b = new Budget('chatgpt-calls', 2);
    b.consume();
    b.consume();
    expect(b.remaining).toBe(0);
    expect(() => b.consume()).toThrow(BudgetExceededError);
    expect(b.spent).toBe(2);
  });
});

describe('withTimeout', () => {
  it('returns the result when work finishes in time', async () => {
    await expect(withTimeout('fast', 1000, async () => 42)).resolves.toBe(42);
  });

  it('throws a retryable TimeoutError and aborts the signal when work is too slow', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const p = withTimeout('slow', 100, (signal) => {
      signal.addEventListener('abort', () => (aborted = true));
      return new Promise<never>(() => {});
    });
    const assertion = expect(p).rejects.toMatchObject({ code: 'TIMEOUT', category: 'retryable' });
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    expect(aborted).toBe(true);
    await expect(p).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('ShutdownController', () => {
  it('refuses new work after shutdown starts, and waits for in-flight work', async () => {
    const sc = new ShutdownController();
    let finished = false;
    const running = sc.track(async () => {
      await new Promise((r) => setTimeout(r, 20));
      finished = true;
    });
    const shutdown = sc.shutdown(1000);
    await expect(sc.track(async () => 1)).rejects.toBeInstanceOf(ShutdownError);
    expect(await shutdown).toBe(true);
    await running;
    expect(finished).toBe(true);
  });

  it('gives up waiting after the timeout and still runs cleanup hooks', async () => {
    const sc = new ShutdownController();
    const cleanup = vi.fn();
    sc.register(cleanup);
    void sc.track(() => new Promise<void>(() => {})).catch(() => {});
    const drained = await sc.shutdown(30);
    expect(drained).toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('assertRunning throws once shutdown has begun', async () => {
    const sc = new ShutdownController();
    sc.assertRunning();
    await sc.shutdown(10);
    expect(() => sc.assertRunning()).toThrow(ShutdownError);
  });

  it('installs and removes signal handlers', () => {
    const sc = new ShutdownController();
    const on = vi.fn();
    const off = vi.fn();
    const remove = sc.installSignalHandlers({ on, off } as never);
    expect(on).toHaveBeenCalledTimes(2);
    remove();
    expect(off).toHaveBeenCalledTimes(2);
  });
});

describe('publication retry rules', () => {
  it('reconciles before retrying an unknown or in-flight outcome', () => {
    expect(decidePublicationRetry('unknown')).toBe('reconcile_first');
    expect(decidePublicationRetry('in_flight')).toBe('reconcile_first');
  });

  it('never re-publishes something already published', () => {
    expect(decidePublicationRetry('published')).toBe('skip');
  });

  it('allows retry only for not_attempted/failed, and generation is always retryable', () => {
    expect(decidePublicationRetry('not_attempted')).toBe('retry');
    expect(decidePublicationRetry('failed')).toBe('retry');
    expect(decideGenerationRetry()).toBe('retry');
  });

  it('produces a deterministic idempotency key', () => {
    expect(publicationKey('item1', 'x', 'v1')).toBe(publicationKey('item1', 'x', 'v1'));
    expect(publicationKey('item1', 'x', 'v1')).not.toBe(publicationKey('item1', 'x', 'v2'));
    expect(publicationKey('item1', 'x', 'v1')).not.toBe(publicationKey('item1', 'facebook', 'v1'));
  });
});
