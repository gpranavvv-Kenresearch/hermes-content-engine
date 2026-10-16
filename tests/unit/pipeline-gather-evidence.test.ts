import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Fetcher } from '../../src/contracts.js';
import { gatherEvidence } from '../../src/pipeline/index.js';
import { config } from '../fixtures/validation/helpers.js';

const html = readFileSync(new URL('../fixtures/evidence/report-landing.html', import.meta.url), 'utf8');
const URL_OK = 'https://www.kenresearch.com/report/examplestan-widget-market';
const NOW = new Date('2026-10-13T10:00:00Z');

function fetcherReturning(overrides: Partial<{ finalUrl: string; status: number; html: string }> = {}): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    return { requestedUrl: url, finalUrl: overrides.finalUrl ?? url, status: overrides.status ?? 200, html: overrides.html ?? html };
  };
  return { fetcher, calls };
}

describe('gatherEvidence', () => {
  it('turns an allowlisted report page into verified, claim-level facts', async () => {
    const { fetcher } = fetcherReturning();
    const { factSet, source } = await gatherEvidence({ url: URL_OK, config, fetcher, now: () => NOW });

    expect(source).toMatchObject({ purpose: 'fact', sourceType: 'ken_research', allowlistStatus: 'allowed' });
    expect(factSet.reportUrl).toBe(URL_OK);
    expect(factSet.itemId).toMatch(/^item_[0-9a-f]{12}$/);

    const size = factSet.facts.find((f) => f.metric === 'market_size' && f.value === 4.2);
    expect(size).toMatchObject({ unit: expect.stringContaining('billion'), period: '2025', verificationStatus: 'verified' });
    const cagr = factSet.facts.find((f) => f.metric === 'cagr');
    expect(cagr).toMatchObject({ value: 10.1, verificationStatus: 'verified' });
    for (const f of factSet.facts) {
      expect(f.sourceUrl).toBe(URL_OK);
      expect(f.sourceQuote).toBeTruthy();
    }
  });

  it('refuses to fetch a competitor page, and never calls the fetcher', async () => {
    const { fetcher, calls } = fetcherReturning();
    await expect(
      gatherEvidence({ url: 'https://www.imarcgroup.com/examplestan-widget-market', config, fetcher }),
    ).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' });
    expect(calls).toEqual([]);
  });

  it('refuses a non-allowlisted host for facts (planning-only hosts are not fact sources)', async () => {
    const { fetcher, calls } = fetcherReturning();
    await expect(gatherEvidence({ url: 'https://news.example.com/widgets', config, fetcher })).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' });
    expect(calls).toEqual([]);
  });

  it('rejects a page whose redirect ended on a disallowed host', async () => {
    const { fetcher } = fetcherReturning({ finalUrl: 'https://www.imarcgroup.com/copy' });
    await expect(gatherEvidence({ url: URL_OK, config, fetcher })).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' });
  });

  it('rejects a page whose canonical tag points at a disallowed host', async () => {
    const hijacked = html.replace('href="/report/examplestan-widget-market"', 'href="https://www.statista.com/x"');
    const { fetcher } = fetcherReturning({ html: hijacked });
    await expect(gatherEvidence({ url: URL_OK, config, fetcher })).rejects.toMatchObject({ code: 'SOURCE_BLOCKED' });
  });

  it('classifies HTTP errors (5xx retryable, 404 fatal)', async () => {
    await expect(gatherEvidence({ url: URL_OK, config, fetcher: fetcherReturning({ status: 503 }).fetcher })).rejects.toMatchObject({ category: 'retryable' });
    await expect(gatherEvidence({ url: URL_OK, config, fetcher: fetcherReturning({ status: 404 }).fetcher })).rejects.toMatchObject({ category: 'fatal' });
  });
});
