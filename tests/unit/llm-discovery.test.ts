import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { OUTPUT_BEGIN, OUTPUT_END, TEXT_MARKER } from '../../src/contracts.js';
import { OpenAiCompatProvider } from '../../src/llm/openai-compat-provider.js';
import { createTextProvider } from '../../src/llm/text-providers.js';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (content: string) => json({ choices: [{ message: { content }, finish_reason: 'stop' }] });

describe('model discovery and per-model probing', () => {
  it('lists the models a provider serves, sorted, using the first key', async () => {
    let auth = '';
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      auth = (init?.headers as Record<string, string>).Authorization!;
      return json({ data: [{ id: 'b-model' }, { id: 'a-model' }, { nope: true }] });
    }) as typeof fetch;
    const p = new OpenAiCompatProvider({ id: 'groq', baseUrl: 'https://x.test/v1', keys: ['k1', 'k2'], models: ['m'], fetchImpl });
    expect(await p.listModels()).toEqual(['a-model', 'b-model']);
    expect(auth).toBe('Bearer k1');
  });

  it('reports a failure to list models without leaking the key', async () => {
    const p = new OpenAiCompatProvider({ id: 'groq', baseUrl: 'https://x.test/v1', keys: ['sk-secret'], models: ['m'], fetchImpl: (async () => json({}, 500)) as typeof fetch });
    const err = await p.listModels().catch((e: Error) => e);
    expect(err).toMatchObject({ code: 'LIST_MODELS_FAILED' });
    expect((err as Error).message).not.toContain('sk-secret');
  });

  it('probes every configured model once and shows which are dead, without changing rotation state', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      seen.push(model);
      if (model === 'gone') return json({}, 404);
      if (model === 'thinker') return ok('<think>only reasoning</think>');
      return ok('A normal answer from the model about market research.');
    }) as typeof fetch;
    const p = new OpenAiCompatProvider({ id: 'groq', baseUrl: 'https://x.test/v1', keys: ['k1'], models: ['good', 'gone', 'thinker'], fetchImpl });
    const results = await p.probeEachModel({ prompt: 'x', purpose: 'probe' });
    expect(seen).toEqual(['good', 'gone', 'thinker']);
    expect(results.map((r) => [r.model, r.outcome])).toEqual([
      ['good', 'ok'],
      ['gone', 'HTTP 404'],
      ['thinker', 'unusable: reasoning_only'],
    ]);
    expect(results[0]!.sample).toContain('normal answer');
    // probing must not quarantine anything: a real generate() still works for the good model
    expect((await p.generate({ prompt: 'x', purpose: 't' })).provider).toBe('groq:good');
  });
});

describe('provider output hook with the wrapped output format', () => {
  const config = loadConfig();

  it('accepts a correctly formatted reply (the format markers are not "prompt echo")', async () => {
    const wrapped = `${OUTPUT_BEGIN}\nFACT_IDS: F1\n${TEXT_MARKER}\nKen Research finds the widget market shifting toward premium segments in 2025.\n${OUTPUT_END}`;
    const s = createTextProvider({ GROQ_API_KEY_1: 'g1', CE_TEXT_PROVIDERS: 'groq' }, { config, fetchImpl: (async () => ok(wrapped)) as typeof fetch });
    const r = await s.provider.generate({ prompt: 'x', purpose: 'draft' });
    expect(r.text).toBe(wrapped);
  });

  it('still rejects real junk inside the wrapper (a refusal)', async () => {
    const wrapped = `${OUTPUT_BEGIN}\nFACT_IDS: none\n${TEXT_MARKER}\nI cannot help with that request.\n${OUTPUT_END}`;
    const s = createTextProvider({ GROQ_API_KEY_1: 'g1', CE_TEXT_PROVIDERS: 'groq' }, { config, fetchImpl: (async () => ok(wrapped)) as typeof fetch });
    await expect(s.provider.generate({ prompt: 'x', purpose: 'draft' })).rejects.toMatchObject({ code: 'ALL_PROVIDERS_FAILED' });
  });

  it('rejects a model that echoes the instructions back', async () => {
    const echo = 'You are a market insights writer for senior executives.\nSTEP 1: extract the market name.';
    const s = createTextProvider({ GROQ_API_KEY_1: 'g1', CE_TEXT_PROVIDERS: 'groq' }, { config, fetchImpl: (async () => ok(echo)) as typeof fetch });
    await expect(s.provider.generate({ prompt: 'x', purpose: 'draft' })).rejects.toMatchObject({ code: 'ALL_PROVIDERS_FAILED' });
  });
});
