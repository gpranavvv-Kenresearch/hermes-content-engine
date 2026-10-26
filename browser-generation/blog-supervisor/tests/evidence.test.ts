import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/index.js';
import { gatherBlogEvidence, isTransientFetchError } from '../src/evidence.js';

const html = readFileSync(new URL('../../../tests/fixtures/evidence/report-landing.html', import.meta.url), 'utf8');
const URL_OK = 'https://www.kenresearch.com/report/examplestan-widget-market';
const config = loadConfig();
const fetcherTo = (finalUrl: string) => async (url: string) => ({ requestedUrl: url, finalUrl, status: 200, html });

describe('temporary fetch failures', () => {
  it('recognises timeouts, dropped connections, 5xx and 429, but not a 404', () => {
    for (const m of ['Timed out after 20000ms: fetch https://x', 'read ECONNRESET', 'fetch failed', 'Fetching "u" returned HTTP 503', 'Fetching "u" returned HTTP 429']) expect(isTransientFetchError(m)).toBe(true);
    expect(isTransientFetchError('Fetching "u" returned HTTP 404')).toBe(false);
  });

  it('retries a timeout and still loads the report when a later attempt works', async () => {
    let calls = 0;
    const flaky = async (url: string) => {
      calls++;
      if (calls < 3) throw new Error('Timed out after 20000ms: fetch ' + url);
      return { requestedUrl: url, finalUrl: url, status: 200, html };
    };
    const ev = await gatherBlogEvidence({ url: URL_OK, title: 'x' }, { config, fetcher: flaky, retryDelayMs: 0 });
    expect(ev.pageLoaded).toBe(true);
    expect(calls).toBe(3);
  });

  it('marks a page that keeps timing out as transient, so the row is retried soon instead of parked', async () => {
    let calls = 0;
    const ev = await gatherBlogEvidence({ url: URL_OK, title: 'x' }, { config, fetcher: async (url) => { calls++; throw new Error('Timed out after 20000ms: fetch ' + url); }, retryDelayMs: 0 });
    expect(ev.pageLoaded).toBe(false);
    expect(ev.transient).toBe(true);
    expect(calls).toBe(3);
  });

  it('does not retry or mark transient a real 404', async () => {
    let calls = 0;
    const ev = await gatherBlogEvidence({ url: URL_OK, title: 'x' }, { config, fetcher: async (url) => { calls++; return { requestedUrl: url, finalUrl: url, status: 404, html: '' }; }, retryDelayMs: 0 });
    expect(ev.pageLoaded).toBe(false);
    expect(ev.transient).toBe(false);
    expect(calls).toBe(1);
  });
});

describe('gatherBlogEvidence', () => {
  it('keeps the report page text so the supervisor can read the data ChatGPT saw', async () => {
    const ev = await gatherBlogEvidence({ url: URL_OK, title: 'Examplestan Widget Market' }, { config, fetcher: fetcherTo(URL_OK) });
    expect(ev.pageLoaded).toBe(true);
    expect(ev.pageText.length).toBeGreaterThan(200);
    expect(ev.evidenceText).toContain(ev.pageText.slice(0, 80));
  });

  it('follows a redirect to another report and reports the final URL', async () => {
    const final = 'https://www.kenresearch.com/industry-reports/examplestan-widgets-and-fittings-market';
    const ev = await gatherBlogEvidence({ url: URL_OK, title: 'x' }, { config, fetcher: fetcherTo(final) });
    expect(ev.pageLoaded).toBe(true);
    expect(ev.redirected).toBe(true);
    expect(ev.finalUrl).toBe(final);
  });

  it('treats a redirect to the site root as not a report', async () => {
    const ev = await gatherBlogEvidence({ url: URL_OK, title: 'x' }, { config, fetcher: fetcherTo('https://www.kenresearch.com/') });
    expect(ev.pageLoaded).toBe(false);
    expect(ev.pageText).toBe('');
  });

  it('reports a page that failed to load', async () => {
    const ev = await gatherBlogEvidence({ url: URL_OK, title: 'x' }, { config, fetcher: async (url) => ({ requestedUrl: url, finalUrl: url, status: 404, html: '' }) });
    expect(ev.pageLoaded).toBe(false);
    expect(ev.summary).toContain('did not load');
  });
});
