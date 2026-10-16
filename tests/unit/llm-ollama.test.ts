import { describe, expect, it } from 'vitest';
import { OllamaProvider } from '../../src/llm/ollama-provider.js';

interface Server {
  models?: string[];
  loaded?: string[];
  chat?: { status?: number; content?: unknown; done_reason?: string; network?: boolean };
  tagsDown?: boolean;
}

function makeServer(s: Server = {}) {
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}) });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    if (path === '/api/tags') {
      if (s.tagsDown) throw new TypeError('fetch failed');
      return json({ models: (s.models ?? ['qwen3:4b']).map((name) => ({ name })) });
    }
    if (path === '/api/ps') return json({ models: (s.loaded ?? []).map((name) => ({ name })) });
    if (path === '/api/chat') {
      if (s.chat?.network) throw new TypeError('fetch failed');
      const status = s.chat?.status ?? 200;
      if (status !== 200) return json({ error: 'x' }, status);
      return json({ message: { content: s.chat?.content ?? 'A post.' }, done_reason: s.chat?.done_reason ?? 'stop' });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const plenty = () => 8000;
const scarce = () => 800;

describe('OllamaProvider', () => {
  it('uses the first installed model, switches reasoning off and caps tokens', async () => {
    const { fetchImpl, calls } = makeServer();
    const p = new OllamaProvider({ fetchImpl, freeMemoryMB: plenty });
    const r = await p.generate({ prompt: 'write', purpose: 'draft', maxOutputTokens: 400 });
    expect(r).toMatchObject({ text: 'A post.', complete: true, provider: 'ollama:qwen3:4b' });
    const chat = calls.find((c) => c.path === '/api/chat')!;
    expect(chat.body).toMatchObject({
      model: 'qwen3:4b',
      stream: false,
      think: false,
      messages: [{ role: 'user', content: 'write' }],
      options: { num_predict: 400 },
    });
  });

  it('skips model discovery when a model is configured', async () => {
    const { fetchImpl, calls } = makeServer();
    await new OllamaProvider({ fetchImpl, model: 'llama3', freeMemoryMB: plenty }).generate({ prompt: 'x', purpose: 't' });
    expect(calls.some((c) => c.path === '/api/tags')).toBe(false);
  });

  it('strips <think> blocks and flags a cut-off reply', async () => {
    const a = makeServer({ chat: { content: '<think>plan</think>Final.' } });
    expect((await new OllamaProvider({ fetchImpl: a.fetchImpl, freeMemoryMB: plenty }).generate({ prompt: 'x', purpose: 't' })).text).toBe('Final.');
    const b = makeServer({ chat: { content: 'Cut off mid', done_reason: 'length' } });
    expect((await new OllamaProvider({ fetchImpl: b.fetchImpl, freeMemoryMB: plenty }).generate({ prompt: 'x', purpose: 't' })).complete).toBe(false);
  });

  it('refuses to LOAD the model when RAM is short, but uses it if it is already loaded', async () => {
    const cold = makeServer();
    await expect(new OllamaProvider({ fetchImpl: cold.fetchImpl, freeMemoryMB: scarce }).generate({ prompt: 'x', purpose: 't' })).rejects.toMatchObject({
      code: 'LOW_MEMORY',
      category: 'retryable',
    });
    expect(cold.calls.some((c) => c.path === '/api/chat')).toBe(false);

    const warm = makeServer({ loaded: ['qwen3:4b'] });
    expect((await new OllamaProvider({ fetchImpl: warm.fetchImpl, freeMemoryMB: scarce }).generate({ prompt: 'x', purpose: 't' })).text).toBe('A post.');
  });

  it('classifies failures', async () => {
    await expect(new OllamaProvider({ fetchImpl: makeServer({ tagsDown: true }).fetchImpl }).generate({ prompt: 'x', purpose: 't' })).rejects.toMatchObject({ code: 'OLLAMA_UNREACHABLE', category: 'retryable' });
    await expect(new OllamaProvider({ fetchImpl: makeServer({ models: [] }).fetchImpl }).generate({ prompt: 'x', purpose: 't' })).rejects.toMatchObject({ code: 'OLLAMA_NO_MODEL', category: 'fatal' });
    await expect(new OllamaProvider({ fetchImpl: makeServer({ chat: { status: 404 } }).fetchImpl, freeMemoryMB: plenty }).generate({ prompt: 'x', purpose: 't' })).rejects.toMatchObject({ code: 'OLLAMA_MODEL_MISSING' });
    await expect(new OllamaProvider({ fetchImpl: makeServer({ chat: { status: 503 } }).fetchImpl, freeMemoryMB: plenty }).generate({ prompt: 'x', purpose: 't' })).rejects.toMatchObject({ code: 'OLLAMA_HTTP', category: 'retryable' });
    await expect(new OllamaProvider({ fetchImpl: makeServer({ chat: { content: '<think>only thoughts' } }).fetchImpl, freeMemoryMB: plenty }).generate({ prompt: 'x', purpose: 't' })).rejects.toMatchObject({ code: 'OLLAMA_EMPTY' });
    await expect(new OllamaProvider({ fetchImpl: makeServer({ chat: { network: true } }).fetchImpl, freeMemoryMB: plenty }).generate({ prompt: 'x', purpose: 't' })).rejects.toMatchObject({ code: 'OLLAMA_UNREACHABLE' });
  });

  it('rejects junk output through the quality hook', async () => {
    const s = makeServer({ chat: { content: 'I cannot do that' } });
    const p = new OllamaProvider({ fetchImpl: s.fetchImpl, freeMemoryMB: plenty, rejectOutput: (t) => (t.startsWith('I cannot') ? 'REFUSAL' : null) });
    await expect(p.generate({ prompt: 'x', purpose: 't' })).rejects.toMatchObject({ code: 'OLLAMA_BAD_OUTPUT' });
  });
});

describe('OllamaProvider context and keep-alive', () => {
  it('asks for a context window big enough for the engine prompts and keeps the model loaded between stages', async () => {
    const { fetchImpl, calls } = makeServer();
    await new OllamaProvider({ fetchImpl, freeMemoryMB: plenty }).generate({ prompt: 'x', purpose: 't' });
    expect(calls.find((c) => c.path === '/api/chat')!.body).toMatchObject({ keep_alive: '30m', options: { num_ctx: 8192 } });
  });

  it('honours an explicit context size and keep-alive', async () => {
    const { fetchImpl, calls } = makeServer();
    await new OllamaProvider({ fetchImpl, freeMemoryMB: plenty, numCtx: 6144, keepAlive: '5m' }).generate({ prompt: 'x', purpose: 't' });
    expect(calls.find((c) => c.path === '/api/chat')!.body).toMatchObject({ keep_alive: '5m', options: { num_ctx: 6144 } });
  });
});

describe('OllamaProvider on a slow reply (no 5-minute cut from the HTTP client)', () => {
  it('waits for a reply that starts late, unless a header timeout is asked for', async () => {
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.setHeader('Content-Type', 'application/json');
        return void res.end(JSON.stringify({ models: [{ name: 'qwen3:4b' }] }));
      }
      if (req.url === '/api/ps') return void res.end(JSON.stringify({ models: [{ name: 'qwen3:4b' }] }));
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message: { content: 'A slow post.' }, done_reason: 'stop' }));
      }, 1500);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const patient = new OllamaProvider({ baseUrl, freeMemoryMB: plenty });
      expect((await patient.generate({ prompt: 'x', purpose: 't' })).text).toBe('A slow post.');

      // proves the dispatcher is really used: a 300 ms header limit must trip on the 1.5 s reply
      const impatient = new OllamaProvider({ baseUrl, freeMemoryMB: plenty, headersTimeoutMs: 300 });
      await expect(impatient.generate({ prompt: 'x', purpose: 't' })).rejects.toMatchObject({ code: 'OLLAMA_TIMEOUT' });
    } finally {
      server.close();
    }
  });
});
