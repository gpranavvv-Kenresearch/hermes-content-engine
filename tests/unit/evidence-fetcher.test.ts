import { describe, expect, it, vi } from 'vitest';
import { sourcePolicy } from '../../src/config/source-policy.config.js';
import { EngineError } from '../../src/errors.js';
import { createSafeFetcher, SourceBlockedError, USER_AGENT } from '../../src/evidence/fetcher.js';

const KEN = 'https://www.kenresearch.com/report/a';
const html = (body = '<html><body>hi</body></html>', type = 'text/html; charset=utf-8', status = 200) =>
  new Response(body, { status, headers: { 'content-type': type } });
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

function make(handlers: Record<string, () => Response>, purpose: 'fact' | 'planning' = 'fact', extra = {}) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => {
    calls.push(url);
    const h = handlers[url];
    if (!h) throw new Error(`unexpected fetch ${url}`);
    return h();
  });
  const fetcher = createSafeFetcher({ fetchImpl, policy: sourcePolicy, purpose, ...extra });
  return { fetcher, calls, fetchImpl };
}

describe('createSafeFetcher', () => {
  it('fetches html and sends an honest user agent with manual redirects', async () => {
    const { fetcher, fetchImpl } = make({ [KEN]: () => html() });
    const r = await fetcher(KEN);
    expect(r).toMatchObject({ requestedUrl: KEN, finalUrl: KEN, status: 200 });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>)['user-agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toContain('kenresearch.com');
  });

  it('follows allowed redirects, resolving relative locations', async () => {
    const { fetcher, calls } = make({
      [KEN]: () => redirect('/report/b'),
      'https://www.kenresearch.com/report/b': () => html(),
    });
    const r = await fetcher(KEN);
    expect(r.finalUrl).toBe('https://www.kenresearch.com/report/b');
    expect(calls).toHaveLength(2);
  });

  it('never contacts a blocked competitor host reached by redirect', async () => {
    const { fetcher, calls } = make({ [KEN]: () => redirect('https://www.imarcgroup.com/x') });
    await expect(fetcher(KEN)).rejects.toBeInstanceOf(SourceBlockedError);
    expect(calls).toEqual([KEN]);
  });

  it('never contacts a non-allowed host for fact purpose', async () => {
    const { fetcher, calls } = make({ [KEN]: () => redirect('https://evil.com/x') });
    await expect(fetcher(KEN)).rejects.toMatchObject({ code: 'SOURCE_BLOCKED', category: 'fatal' });
    expect(calls).toEqual([KEN]);
  });

  it('refuses a blocked initial url without any request, even for planning', async () => {
    const { fetcher, fetchImpl } = make({}, 'planning');
    await expect(fetcher('https://technavio.com/x')).rejects.toBeInstanceOf(SourceBlockedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('planning may fetch other hosts', async () => {
    const { fetcher } = make({ 'https://example.org/p': () => html() }, 'planning');
    expect((await fetcher('https://example.org/p')).status).toBe(200);
  });

  it('stops after 5 redirect hops', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => redirect(`https://www.kenresearch.com/r${++n}`));
    const fetcher = createSafeFetcher({ fetchImpl, policy: sourcePolicy, purpose: 'fact' });
    await expect(fetcher(KEN)).rejects.toMatchObject({ code: 'TOO_MANY_REDIRECTS' });
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('rejects redirect without Location', async () => {
    const { fetcher } = make({ [KEN]: () => new Response(null, { status: 301 }) });
    await expect(fetcher(KEN)).rejects.toMatchObject({ code: 'BAD_REDIRECT' });
  });

  it('rejects non-html content types', async () => {
    const { fetcher } = make({ [KEN]: () => html('%PDF', 'application/pdf') });
    await expect(fetcher(KEN)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT_TYPE' });
  });

  it('accepts xhtml', async () => {
    const { fetcher } = make({ [KEN]: () => html('<html/>', 'application/xhtml+xml') });
    expect((await fetcher(KEN)).html).toBe('<html/>');
  });

  it('enforces the body cap via content-length and via streaming', async () => {
    const big = 'x'.repeat(2000);
    const a = make({ [KEN]: () => html(big) }, 'fact', { maxBodyBytes: 1000 });
    await expect(a.fetcher(KEN)).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    const stream = () =>
      new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } }), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    const b = make({ [KEN]: stream }, 'fact', { maxBodyBytes: 1000 });
    await expect(b.fetcher(KEN)).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
  });

  it('maps 429 to rate_limited, 5xx to retryable, 404 to fatal', async () => {
    const r429 = make({ [KEN]: () => new Response('', { status: 429, headers: { 'retry-after': '7' } }) });
    await expect(r429.fetcher(KEN)).rejects.toMatchObject({ category: 'rate_limited', retryAfterMs: 7000 });
    const r503 = make({ [KEN]: () => html('', 'text/html', 503) });
    await expect(r503.fetcher(KEN)).rejects.toMatchObject({ category: 'retryable' });
    const r404 = make({ [KEN]: () => html('', 'text/html', 404) });
    await expect(r404.fetcher(KEN)).rejects.toMatchObject({ category: 'fatal', code: 'HTTP_ERROR' });
  });

  it('wraps network errors as retryable EngineErrors', async () => {
    const fetcher = createSafeFetcher({
      fetchImpl: async () => { throw new Error('ECONNRESET'); },
      policy: sourcePolicy,
      purpose: 'fact',
    });
    const err = await fetcher(KEN).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.category).toBe('retryable');
  });

  it('times out with a retryable TimeoutError', async () => {
    const fetchImpl = (_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))));
    const fetcher = createSafeFetcher({ fetchImpl, policy: sourcePolicy, purpose: 'fact', timeoutMs: 20 });
    await expect(fetcher(KEN)).rejects.toMatchObject({ code: 'TIMEOUT', category: 'retryable' });
  });
});
