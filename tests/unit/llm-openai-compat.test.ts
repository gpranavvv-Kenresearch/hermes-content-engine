import { describe, expect, it } from 'vitest';
import { stripThinking } from '../../src/llm/clean.js';
import { ModelHealth } from '../../src/llm/model-health.js';
import { OpenAiCompatProvider } from '../../src/llm/openai-compat-provider.js';

type Step = { status?: number; content?: unknown; finish?: string; network?: boolean; badJson?: boolean };

function makeFetch(steps: Step[]) {
  const calls: Array<{ url: string; key: string; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), key: headers.Authorization!.replace('Bearer ', ''), body });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step.network) throw new TypeError('fetch failed');
    if (step.badJson) return new Response('not json', { status: 200 });
    const status = step.status ?? 200;
    const payload = status === 200 ? { choices: [{ message: { content: step.content ?? '' }, finish_reason: step.finish ?? 'stop' }] } : { error: 'x' };
    return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const KEYS = ['sk-key-one', 'sk-key-two', 'sk-key-three'];
function provider(steps: Step[], extra: Partial<ConstructorParameters<typeof OpenAiCompatProvider>[0]> = {}) {
  const { fetchImpl, calls } = makeFetch(steps);
  const p = new OpenAiCompatProvider({
    id: 'groq',
    baseUrl: 'https://api.example.test/v1',
    keys: KEYS,
    models: ['model-a', 'model-b'],
    fetchImpl,
    ...extra,
  });
  return { p, calls };
}

describe('stripThinking', () => {
  it('removes complete think blocks, a stray closing tag, and rejects unclosed reasoning', () => {
    expect(stripThinking('<think>plan it</think>\nFinal text')).toBe('Final text');
    expect(stripThinking('reasoning here</think> Answer')).toBe('Answer');
    expect(stripThinking('<think>never finished and cut')).toBe('');
    expect(stripThinking('plain')).toBe('plain');
  });
});

describe('OpenAiCompatProvider', () => {
  it('returns the text with provider+model, and sends the key, model and token cap', async () => {
    const { p, calls } = provider([{ content: 'A finished post.' }]);
    const r = await p.generate({ prompt: 'write', purpose: 'draft', maxOutputTokens: 400 });
    expect(r).toMatchObject({ text: 'A finished post.', complete: true, provider: 'groq:model-a' });
    expect(calls[0]).toMatchObject({ url: 'https://api.example.test/v1/chat/completions', key: 'sk-key-one' });
    expect(calls[0]!.body).toMatchObject({ model: 'model-a', max_tokens: 400, messages: [{ role: 'user', content: 'write' }] });
  });

  it('rotates keys and models across calls', async () => {
    const { p, calls } = provider([{ content: 'ok' }]);
    await p.generate({ prompt: 'a', purpose: 't' });
    await p.generate({ prompt: 'b', purpose: 't' });
    expect(calls.map((c) => c.key)).toEqual(['sk-key-one', 'sk-key-two']);
    expect(calls.map((c) => c.body.model)).toEqual(['model-a', 'model-b']);
  });

  it('rotates to the next key on 429 and on 402 without blaming the model', async () => {
    const { p, calls } = provider([{ status: 429 }, { status: 402 }, { content: 'third key works' }]);
    const r = await p.generate({ prompt: 'x', purpose: 't' });
    expect(r.text).toBe('third key works');
    expect(calls.map((c) => c.key)).toEqual(['sk-key-one', 'sk-key-two', 'sk-key-three']);
  });

  it('retires a key that returns 401 for good', async () => {
    const { p, calls } = provider([{ status: 401 }, { content: 'ok' }]);
    await p.generate({ prompt: 'x', purpose: 't' });
    await p.generate({ prompt: 'y', purpose: 't' });
    await p.generate({ prompt: 'z', purpose: 't' });
    expect(calls.map((c) => c.key).filter((k) => k === 'sk-key-one')).toHaveLength(1);
  });

  it('strips <think> blocks, and rotates away from a reasoning-only reply', async () => {
    const { p, calls } = provider([{ content: '<think>hmm</think>' }, { content: '<think>plan</think>The post.' }]);
    const r = await p.generate({ prompt: 'x', purpose: 't' });
    expect(r.text).toBe('The post.');
    expect(calls).toHaveLength(2);
  });

  it('rotates away from output the quality hook rejects', async () => {
    const { p, calls } = provider([{ content: 'I cannot help with that.' }, { content: 'A real post.' }], {
      rejectOutput: (t) => (t.startsWith('I cannot') ? 'REFUSAL' : null),
    });
    const r = await p.generate({ prompt: 'x', purpose: 't' });
    expect(r.text).toBe('A real post.');
    expect(calls).toHaveLength(2);
  });

  it('flags a reply cut off by the token limit as incomplete', async () => {
    const { p } = provider([{ content: 'Half a sentence and', finish: 'length' }]);
    expect((await p.generate({ prompt: 'x', purpose: 't' })).complete).toBe(false);
  });

  it('throws rate_limited when every key is rate limited', async () => {
    const { p } = provider([{ status: 429 }]);
    await expect(p.generate({ prompt: 'x', purpose: 't' })).rejects.toMatchObject({ category: 'rate_limited', code: 'ALL_KEYS_RATE_LIMITED' });
  });

  it('throws retryable NETWORK when nothing is reachable, and never leaks a key', async () => {
    const warnings: string[] = [];
    const { p } = provider([{ network: true }], { logger: { info: (o) => warnings.push(JSON.stringify(o)), warn: (o) => warnings.push(JSON.stringify(o)) } });
    const err = await p.generate({ prompt: 'x', purpose: 't' }).catch((e: Error) => e);
    expect(err).toMatchObject({ category: 'retryable', code: 'NETWORK' });
    const everything = `${(err as Error).message} ${JSON.stringify((err as { detail?: unknown }).detail)} ${warnings.join(' ')}`;
    for (const key of KEYS) expect(everything).not.toContain(key);
    expect(everything).toContain('groq#1');
  });

  it('quarantines a model after repeated bad outcomes', async () => {
    const health = new ModelHealth();
    const { p } = provider([{ status: 500 }], { models: ['only-model'], health });
    await expect(p.generate({ prompt: 'x', purpose: 't' })).rejects.toMatchObject({ code: 'PROVIDER_EXHAUSTED' });
    await expect(p.generate({ prompt: 'x', purpose: 't' })).rejects.toMatchObject({ code: 'MODELS_QUARANTINED' });
  });

  it('treats unreadable JSON as a bad reply and rotates', async () => {
    const { p } = provider([{ badJson: true }, { content: 'fine' }]);
    expect((await p.generate({ prompt: 'x', purpose: 't' })).text).toBe('fine');
  });

  it('fails fast without keys, and honours an abort signal', async () => {
    const { p: none } = provider([{ content: 'x' }], { keys: [] });
    await expect(none.generate({ prompt: 'x', purpose: 't' })).rejects.toMatchObject({ code: 'NO_KEYS', category: 'fatal' });

    const { fetchImpl } = makeFetch([{ network: true }]);
    const p = new OpenAiCompatProvider({ id: 'groq', baseUrl: 'https://x.test', keys: KEYS, models: ['m'], fetchImpl });
    const ctl = new AbortController();
    ctl.abort();
    await expect(p.generate({ prompt: 'x', purpose: 't', signal: ctl.signal })).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

describe('ModelHealth', () => {
  it('quarantines after the threshold, expires, and a success resets the streak', () => {
    let t = 0;
    const h = new ModelHealth(() => t, 3, 1000);
    h.record('m', false);
    h.record('m', false);
    expect(h.isQuarantined('m')).toBe(false);
    h.record('m', true);
    h.record('m', false);
    h.record('m', false);
    expect(h.isQuarantined('m')).toBe(false);
    h.record('m', false);
    expect(h.isQuarantined('m')).toBe(true);
    t = 1001;
    expect(h.isQuarantined('m')).toBe(false);
  });
});
