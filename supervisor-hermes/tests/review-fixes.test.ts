import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Fetcher } from '../../src/contracts.js';
import { MemoryStore } from '../../src/store/store.js';
import { FakeLlmProvider, config, reply, sampleFact, wrapReply } from '../../tests/fixtures/validation/helpers.js';
import type { AgentDeps } from '../src/agents/deps.js';
import { runEvidenceAgent, usableFacts, type EvidenceOutput } from '../src/agents/evidence.js';
import { runStrategyAgent } from '../src/agents/strategy.js';
import { OWN_DRAFTS_COLLECTION, recentTexts, runValidatorAgent } from '../src/agents/validator.js';
import { excludeSkippedRows, runBatch } from '../src/batch.js';
import { RunLimits } from '../src/limits.js';
import type { RowResult } from '../src/types.js';

const item = { id: 'item-1', title: 'Examplestan Widget Market', reportUrl: 'https://www.kenresearch.com/industry-reports/examplestan-widget-market' };

function deps(writer = new FakeLlmProvider([]), fetcher?: Fetcher): AgentDeps {
  return {
    config,
    store: new MemoryStore(),
    claimChecker: () => ({ issues: [], mappings: [] }),
    writer,
    sheets: { tab: 't', read: async () => [], writeCell: async () => {} },
    ...(fetcher ? { fetcher } : {}),
    limits: new RunLimits(),
    now: () => new Date('2026-10-14T10:00:00Z'),
  };
}

describe('usableFacts (same filter as the main engine)', () => {
  const old = { ...sampleFact, id: 'F0', period: '2023', value: 3.1 };
  const cagrA = { ...sampleFact, id: 'C1', metric: 'cagr', unit: '%', value: 9.5 };
  const cagrB = { ...sampleFact, id: 'C2', metric: 'cagr', unit: '%', value: 11.2 };
  const evidence = (facts: EvidenceOutput['facts']): EvidenceOutput => ({ itemId: 'i', reportPageLoaded: true, facts, notes: [], mode: 'figures', verifiedFigures: 1, sources: [] });

  it('drops figures from before 2024', () => {
    expect(usableFacts(evidence([old, sampleFact])).map((f) => f.id)).toEqual(['F1']);
  });
  it('drops metrics whose values disagree', () => {
    expect(usableFacts(evidence([sampleFact, cagrA, cagrB])).map((f) => f.id)).toEqual(['F1']);
  });
  it('the strategy agent builds the brief from the same filter', async () => {
    const d = deps();
    const report = await runStrategyAgent({ item, evidence: evidence([old, sampleFact]), platform: 'linkedin', keyword: 'examplestan widget market', attempt: 0 }, d);
    expect(report.output.brief.factIds).toEqual(['F1']);
  });
});

describe('evidence agent: a report URL that redirects to another page', () => {
  const html = readFileSync(new URL('../../tests/fixtures/evidence/report-landing.html', import.meta.url), 'utf8');
  const URL_OK = 'https://www.kenresearch.com/report/examplestan-widget-market';
  const redirectTo = (finalUrl: string): Fetcher => async (url) => ({ requestedUrl: url, finalUrl, status: 200, html });

  it('is treated as not loaded when it ends on a different page (for example the homepage)', async () => {
    const report = await runEvidenceAgent({ url: URL_OK, title: 'Examplestan Widget Market', supplementary: 'ken-gov' }, deps(undefined, redirectTo('https://www.kenresearch.com/')));
    expect(report.output.reportPageLoaded).toBe(false);
    expect(report.output.error).toContain('different page');
  });
  it('still loads when only the path prefix or trailing slash changes', async () => {
    const report = await runEvidenceAgent(
      { url: URL_OK, title: 'Examplestan Widget Market', supplementary: 'ken-gov' },
      deps(undefined, redirectTo('https://www.kenresearch.com/industry-reports/examplestan-widget-market/')),
    );
    expect(report.output.reportPageLoaded).toBe(true);
  });
});

describe('recent texts and similarity', () => {
  it('keeps the newest drafts from both sources, not the alphabetically last ones', async () => {
    const d = deps();
    for (let i = 0; i < 60; i++) {
      await d.store.put(OWN_DRAFTS_COLLECTION, `own_${String(i).padStart(3, '0')}`, { text: `own ${i}`, platform: 'linkedin', itemId: 'x', createdAt: new Date(2026, 0, 1, 0, i).toISOString() });
    }
    await d.store.put('drafts', 'a_legacy', { text: 'legacy newest', status: 'approved', itemId: 'y', createdAt: new Date(2026, 5, 1).toISOString() });
    const texts = await recentTexts(d);
    expect(texts).toHaveLength(50);
    expect(texts).toContain('legacy newest');
    expect(texts).toContain('own 59');
    expect(texts).not.toContain('own 0');
  });
  it('flags a draft that is a near copy of an earlier post for the same report, and does not save drafts itself', async () => {
    const text = 'Examplestan widget makers are shifting toward premium segments as buyers demand longer warranties and better service across regional distribution networks this year.';
    const d = deps(new FakeLlmProvider([reply(wrapReply(text, ['F1']))]));
    await d.store.put(OWN_DRAFTS_COLLECTION, 'earlier', { text, platform: 'linkedin', itemId: item.id, createdAt: '2026-10-01T00:00:00.000Z' });
    const evidence: EvidenceOutput = { itemId: item.id, reportPageLoaded: true, facts: [sampleFact], notes: [], mode: 'figures', verifiedFigures: 1, sources: [] };
    const strategy = (await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'examplestan widget market', attempt: 0 }, d)).output;
    const report = await runValidatorAgent({ item, evidence, strategy, draft: { text, factIds: ['F1'], promptVersion: 'v' }, platform: 'linkedin', keyword: 'examplestan widget market', minUsefulWords: 5 }, d);
    expect(report.concerns.join(' ')).toMatch(/similar/i);
    expect((await d.store.list(OWN_DRAFTS_COLLECTION)).length).toBe(1);
  });
});

const result = (status: RowResult['status'], extra: Partial<RowResult> = {}): RowResult => ({
  rowIndex: 1, url: 'u', title: 't', keyword: 'k', platform: 'linkedin', status, reason: 'r', text: null, score: null, regenerations: 0, retries: 0, decisions: [], written: null, noEvidence: false, ...extra,
});

describe('runBatch', () => {
  const picker = (n: number) => {
    let i = 0;
    return () => (i < n ? { rowIndex: ++i } : null);
  };
  it('stops after three failed rows in a row', async () => {
    const processed: number[] = [];
    const s = await runBatch({ count: 5, maxFailures: 3, maxSkips: 10, next: picker(10), process: async (p) => { processed.push(p.rowIndex); return result('needs_human'); } });
    expect(processed).toEqual([1, 2, 3]);
    expect(s).toMatchObject({ approved: 0, failures: 3, skipped: 0 });
  });
  it('a success resets the failure streak', async () => {
    const outcomes: RowResult['status'][] = ['needs_human', 'needs_human', 'approved', 'needs_human', 'needs_human', 'approved'];
    let i = 0;
    const s = await runBatch({ count: 2, maxFailures: 3, maxSkips: 10, next: picker(10), process: async () => result(outcomes[i++]!) });
    expect(s.approved).toBe(2);
  });
  it('rows with no usable evidence are skipped, recorded, and not counted as failures', async () => {
    const skipped: number[] = [];
    const s = await runBatch({
      count: 1, maxFailures: 1, maxSkips: 10, next: picker(10),
      process: async (p) => (p.rowIndex < 3 ? result('needs_human', { noEvidence: true }) : result('approved')),
      onSkip: async (p) => { skipped.push(p.rowIndex); },
    });
    expect(s).toMatchObject({ approved: 1, skipped: 2, failures: 0 });
    expect(skipped).toEqual([1, 2]);
  });
  it('gives up after too many skips and reports that rows ran out', async () => {
    const s = await runBatch({ count: 1, maxFailures: 1, maxSkips: 2, next: picker(10), process: async () => result('needs_human', { noEvidence: true }) });
    expect(s).toMatchObject({ approved: 0, skipped: 2 });
    const none = await runBatch({ count: 1, maxFailures: 1, maxSkips: 2, next: () => null, process: async () => result('approved') });
    expect(none.exhausted).toBe(true);
  });
  it('processes only one row for a fixed --row', async () => {
    const processed: number[] = [];
    await runBatch({ count: 1, maxFailures: 1, maxSkips: 10, next: picker(10), fixedRow: true, process: async (p) => { processed.push(p.rowIndex); return result('needs_human'); } });
    expect(processed).toEqual([1]);
  });
});

describe('excludeSkippedRows', () => {
  it('excludes rows whose cells hold a previously skipped URL (trailing slash and case ignored)', () => {
    const rows = [['targetUrl', 'title'], ['https://www.kenresearch.com/A/', 't1'], ['https://www.kenresearch.com/b', 't2']];
    expect([...excludeSkippedRows(rows, ['https://www.kenresearch.com/a'])]).toEqual([2]);
  });
});
