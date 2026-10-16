import { describe, expect, it } from 'vitest';
import { BudgetExceededError } from '../../src/errors.js';
import { RunLimits, countedProvider } from '../src/limits.js';

describe('RunLimits', () => {
  it('counts regenerations and retries against their limits', () => {
    const l = new RunLimits({ maxRegenerations: 1, maxRetries: 2 });
    expect(l.canRegenerate()).toBe(true);
    expect(l.regenerationsLeft).toBe(1);
    l.useRegeneration();
    expect(l.canRegenerate()).toBe(false);
    l.useRetry();
    l.useRetry();
    expect(l.canRetry()).toBe(false);
    expect(l.retriesLeft).toBe(0);
    l.resetRetries();
    expect(l.canRetry()).toBe(true);
    expect(l.regenerations).toBe(1);
  });
  it('counted provider consumes one Hermes call per generate and throws when the budget is spent', async () => {
    const l = new RunLimits({ maxHermesCalls: 1 });
    const inner = { id: 'fake', generate: async () => ({ text: 'x', complete: true, provider: 'fake', elapsedMs: 1 }) };
    const p = countedProvider(inner, l);
    await p.generate({ prompt: 'a', purpose: 'draft' });
    await expect(p.generate({ prompt: 'b', purpose: 'draft' })).rejects.toBeInstanceOf(BudgetExceededError);
  });
});
