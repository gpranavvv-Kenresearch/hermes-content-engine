import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import type { LlmProvider, LlmRequest, LlmResult } from '../../src/contracts.js';
import { BudgetExceededError, ConfigError, EngineError, ShutdownError } from '../../src/errors.js';
import { ChainProvider } from '../../src/llm/chain-provider.js';
import { loadEnvFiles } from '../../src/llm/env.js';
import { createTextProvider } from '../../src/llm/text-providers.js';

const config = loadConfig();

function stub(id: string, behaviour: () => LlmResult | Error): LlmProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    async generate(_r: LlmRequest): Promise<LlmResult> {
      p.calls++;
      const v = behaviour();
      if (v instanceof Error) throw v;
      return v;
    },
  };
  return p;
}
const ok = (provider: string, text = 'fine', complete = true): LlmResult => ({ text, complete, provider, elapsedMs: 1 });
const fail = (code: string, category: 'retryable' | 'rate_limited' = 'retryable') => new EngineError(code, category, code);

describe('ChainProvider', () => {
  it('returns the first provider that answers and skips ones that fail', async () => {
    const a = stub('a', () => fail('A_DOWN'));
    const b = stub('b', () => ok('b:model'));
    const c = stub('c', () => ok('c:model'));
    const r = await new ChainProvider({ providers: [a, b, c] }).generate({ prompt: 'x', purpose: 't' });
    expect(r.provider).toBe('b:model');
    expect(c.calls).toBe(0);
  });

  it('moves on from an incomplete reply, and returns the last incomplete one if nobody completes', async () => {
    const a = stub('a', () => ok('a', 'cut', false));
    const b = stub('b', () => ok('b', 'also cut', false));
    const r = await new ChainProvider({ providers: [a, b] }).generate({ prompt: 'x', purpose: 't' });
    expect(r).toMatchObject({ text: 'also cut', complete: false });
    const good = stub('g', () => ok('g'));
    expect((await new ChainProvider({ providers: [a, good] }).generate({ prompt: 'x', purpose: 't' })).provider).toBe('g');
  });

  it('stops the whole chain on shutdown or budget errors', async () => {
    const a = stub('a', () => new ShutdownError());
    const b = stub('b', () => ok('b'));
    await expect(new ChainProvider({ providers: [a, b] }).generate({ prompt: 'x', purpose: 't' })).rejects.toBeInstanceOf(ShutdownError);
    expect(b.calls).toBe(0);
    const c = stub('c', () => new BudgetExceededError('calls', 1));
    await expect(new ChainProvider({ providers: [c, b] }).generate({ prompt: 'x', purpose: 't' })).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('lists every failure when all providers fail, and reports rate_limited only if all were', async () => {
    const a = stub('a', () => fail('A_DOWN'));
    const b = stub('b', () => fail('B_LIMIT', 'rate_limited'));
    const err = await new ChainProvider({ providers: [a, b] }).generate({ prompt: 'x', purpose: 't' }).catch((e: EngineError) => e);
    expect(err).toMatchObject({ code: 'ALL_PROVIDERS_FAILED', category: 'retryable' });
    expect((err as EngineError).message).toContain('a=A_DOWN');
    expect((err as EngineError).message).toContain('b=B_LIMIT');
    const allLimited = await new ChainProvider({ providers: [stub('x', () => fail('L', 'rate_limited'))] }).generate({ prompt: 'x', purpose: 't' }).catch((e: EngineError) => e);
    expect(allLimited).toMatchObject({ category: 'rate_limited' });
  });

  it('needs at least one provider', () => {
    expect(() => new ChainProvider({ providers: [] })).toThrow(RangeError);
  });
});

describe('loadEnvFiles', () => {
  it('fills only unset variables from CE_ENV_FILE and never touches existing ones', () => {
    const env: Record<string, string | undefined> = { CE_ENV_FILE: '/x/.env', GROQ_API_KEY_1: 'already-set', EMPTY: '' };
    const res = loadEnvFiles(env, () => 'GROQ_API_KEY_1=from-file\nGROQ_API_KEY_2=second\nEMPTY=filled\n');
    expect(res.loaded).toEqual(['/x/.env']);
    expect(env.GROQ_API_KEY_1).toBe('already-set');
    expect(env.GROQ_API_KEY_2).toBe('second');
    expect(env.EMPTY).toBe('filled');
  });

  it('reports an unreadable file and does nothing when CE_ENV_FILE is unset', () => {
    expect(loadEnvFiles({ CE_ENV_FILE: '/nope' }, () => { throw new Error('ENOENT'); })).toEqual({ loaded: [], missing: ['/nope'] });
    expect(loadEnvFiles({}, () => 'A=1')).toEqual({ loaded: [], missing: [] });
  });
});

describe('createTextProvider', () => {
  const keysEnv = {
    GROQ_API_KEY_1: 'g1',
    GROQ_API_KEY_2: 'g2',
    OPENROUTER_API_KEY_1: 'o1',
    NVIDIA_API_KEY: 'n1',
    NVIDIA_API_KEY_2: 'n2',
  };

  it('builds the default chain ollama > groq > openrouter from the environment, skipping NVIDIA until a model is verified', () => {
    const s = createTextProvider(keysEnv, { config });
    expect(s.order).toEqual(['ollama', 'groq', 'openrouter']);
    expect(s.skipped).toHaveLength(1);
    expect(s.skipped[0]).toMatchObject({ name: 'nvidia' });
    expect(s.skipped[0]!.reason).toContain('CE_NVIDIA_MODELS');
    expect(s.models.groq!.length).toBeGreaterThan(0);
  });

  it('includes NVIDIA once a model is configured', () => {
    const s = createTextProvider({ ...keysEnv, CE_NVIDIA_MODELS: 'some/model' }, { config });
    expect(s.order).toEqual(['ollama', 'groq', 'nvidia', 'openrouter']);
    expect(s.models.nvidia).toEqual(['some/model']);
  });

  it('skips API providers without keys, honours CE_TEXT_PROVIDERS order and model overrides', () => {
    const s = createTextProvider({ GROQ_API_KEY_1: 'g1', CE_TEXT_PROVIDERS: 'groq,openrouter', CE_GROQ_MODELS: 'my-model, other' }, { config });
    expect(s.order).toEqual(['groq']);
    expect(s.skipped).toEqual([{ name: 'openrouter', reason: 'no OPENROUTER_API_KEY keys found' }]);
    expect(s.models.groq).toEqual(['my-model', 'other']);
  });

  it('rejects unknown providers and an empty chain', () => {
    expect(() => createTextProvider({ CE_TEXT_PROVIDERS: 'groq,myspace' }, { config })).toThrow(ConfigError);
    expect(() => createTextProvider({ CE_TEXT_PROVIDERS: 'groq' }, { config })).toThrow(/no text provider is available/);
  });

  it('falls through from Ollama (short of RAM) to a keyed API provider, end to end', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = new URL(String(url));
      seen.push(u.host + u.pathname);
      const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.pathname === '/api/tags') return json({ models: [{ name: 'qwen3:4b' }] });
      if (u.pathname === '/api/ps') return json({ models: [] });
      if (u.host === 'api.groq.com') return json({ choices: [{ message: { content: 'Groq wrote this post about the market.' }, finish_reason: 'stop' }] });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const s = createTextProvider({ GROQ_API_KEY_1: 'g1' }, { config, fetchImpl, freeMemoryMB: () => 500 });
    const r = await s.provider.generate({ prompt: 'write', purpose: 'draft' });
    expect(r.text).toBe('Groq wrote this post about the market.');
    expect(r.provider.startsWith('groq:')).toBe(true);
    expect(seen).not.toContain('127.0.0.1:11434/api/chat');
  });

  it('rejects junk from a provider at the source (refusal text rotates instead of being returned)', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      const content = n === 1 ? 'I cannot help with that request.' : 'Ken Research notes a shift toward premium segments in the widget market this year.';
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const s = createTextProvider({ GROQ_API_KEY_1: 'g1', GROQ_API_KEY_2: 'g2', CE_TEXT_PROVIDERS: 'groq' }, { config, fetchImpl });
    const r = await s.provider.generate({ prompt: 'x', purpose: 't' });
    expect(r.text).toContain('premium segments');
    expect(n).toBe(2);
  });
});
