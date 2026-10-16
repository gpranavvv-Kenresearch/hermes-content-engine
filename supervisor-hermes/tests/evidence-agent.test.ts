import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Fetcher, SearchProvider } from '../../src/contracts.js';
import { MemoryStore } from '../../src/store/store.js';
import { config } from '../../tests/fixtures/validation/helpers.js';
import type { AgentDeps } from '../src/agents/deps.js';
import { runEvidenceAgent } from '../src/agents/evidence.js';
import { RunLimits } from '../src/limits.js';

const html = readFileSync(new URL('../../tests/fixtures/evidence/report-landing.html', import.meta.url), 'utf8');
const URL_OK = 'https://www.kenresearch.com/report/examplestan-widget-market';

function deps(fetcher: Fetcher, searchProvider?: SearchProvider): AgentDeps {
  return {
    config,
    store: new MemoryStore(),
    claimChecker: () => ({ issues: [], mappings: [] }),
    writer: { id: 'fake', generate: async () => ({ text: '', complete: true, provider: 'fake', elapsedMs: 0 }) },
    sheets: { tab: 't', read: async () => [], writeCell: async () => {} },
    fetcher,
    ...(searchProvider ? { searchProvider } : {}),
    limits: new RunLimits(),
    now: () => new Date('2026-10-14T10:00:00Z'),
  };
}
const ok: Fetcher = async (url) => ({ requestedUrl: url, finalUrl: url, status: 200, html });
const notFound: Fetcher = async (url) => ({ requestedUrl: url, finalUrl: url, status: 404, html: '' });

describe('runEvidenceAgent', () => {
  it('loads the report page and reports verified figures', async () => {
    const report = await runEvidenceAgent({ url: URL_OK, title: 'Examplestan Widget Market', supplementary: 'ken-gov' }, deps(ok));
    expect(report.output.reportPageLoaded).toBe(true);
    expect(report.output.verifiedFigures).toBeGreaterThan(0);
    expect(report.output.mode).toBe('figures');
  });
  it('does NOT search for substitute evidence when the report page failed to load', async () => {
    let searched = false;
    const search: SearchProvider = {
      id: 's',
      search: async () => {
        searched = true;
        return [];
      },
    };
    const report = await runEvidenceAgent({ url: URL_OK, title: 'Examplestan Widget Market', supplementary: 'all' }, deps(notFound, search));
    expect(searched).toBe(false);
    expect(report.output).toMatchObject({ reportPageLoaded: false, mode: 'none', facts: [], notes: [] });
    expect(report.output.error).toContain('404');
    expect(report.concerns.length).toBeGreaterThan(0);
  });
});
