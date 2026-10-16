import { describe, expect, it } from 'vitest';
import { checkClaims } from '../../src/evidence/index.js';
import { PLAN, RunManifest, formatManifest, runContentPlan } from '../../src/pipeline/index.js';
import { loadFlags } from '../../src/safety/flags.js';
import { MemoryStore } from '../../src/store/store.js';
import { FakeLlmProvider, config, reply, sampleFact, utmLink, wrapReply } from '../fixtures/validation/helpers.js';

const item = { id: 'item-1', title: 'Examplestan Widget Market', reportUrl: 'https://www.kenresearch.com/industry-reports/examplestan-widget-market' };
const goodX = `Ken Research finds the Examplestan widget market reached USD 4.2 billion in 2025, with buyers shifting toward premium segments. Full outlook: ${utmLink('x')} #Widgets #Examplestan`;
const NO_STYLE = '/definitely/not/a/folder';

const deps = (provider: FakeLlmProvider) => ({
  config,
  provider,
  claimChecker: checkClaims,
  store: new MemoryStore(),
  flags: loadFlags({}),
  now: () => new Date('2026-10-13T10:00:00Z'),
  seed: 1,
});
const input = { item, facts: [sampleFact], campaignId: 'authority-insights', platform: 'x' as const };
const replies = (n: number, text: string = goodX) => Array.from({ length: n }, () => reply(wrapReply(text, text === goodX ? ['F1'] : [])));

describe('run manifest', () => {
  it('reports every planned step exactly once, in plan order, even when nothing ran', () => {
    const steps = new RunManifest('x').steps();
    expect(steps.map((s) => s.id)).toEqual(PLAN.map((s) => s.id));
    expect(steps.every((s) => s.status === 'skipped' && s.reason === 'not executed')).toBe(true);
    expect(formatManifest(steps).split('\n')).toHaveLength(PLAN.length);
  });

  it('treats by-design skips as no problem and optional steps as a problem only in strict mode', () => {
    const m = new RunManifest('x');
    for (const s of PLAN) m.ran(s.id);
    m.skip('outline', 'short post', { byDesign: true });
    m.skip('fresh-data', 'no keys');
    expect(m.problems(false)).toEqual([]);
    expect(m.problems(true).map((p) => p.id)).toEqual(['fresh-data']);
  });
});

describe('runContentPlan', () => {
  it('runs every stage, records each step and states why optional ones were skipped', async () => {
    const provider = new FakeLlmProvider(replies(3)); // research-brief, draft, editorial
    const result = await runContentPlan(input, deps(provider), { styleDir: NO_STYLE });
    expect(result.status).toBe('approved');
    expect(result.steps).toHaveLength(PLAN.length);
    const by = Object.fromEntries(result.steps.map((s) => [s.id, s]));
    for (const id of ['preflight', 'evidence', 'persona-angle-variant', 'research-brief', 'draft', 'editorial', 'validate-rewrite', 'variant-check', 'scoring', 'finalize'] as const) {
      expect(by[id]!.status, id).toBe('ran');
    }
    expect(by['outline']).toMatchObject({ status: 'skipped', byDesign: true });
    expect(by['style-library']!.reason).toMatch(/no usable/);
    expect(by['planning-signals']!.reason).toMatch(/CE_RSS_FEEDS/);
    expect(by['fresh-data']!.reason).toMatch(/search provider/);
    expect(result.score).toBeDefined();
  });

  it('strict mode refuses to approve when an optional step was skipped', async () => {
    const result = await runContentPlan(input, deps(new FakeLlmProvider(replies(3))), { styleDir: NO_STYLE, strict: true });
    expect(result.status).toBe('needs_human');
    expect(result.reason).toMatch(/plan incomplete.*fresh-data/);
  });

  it('minimal mode runs a single draft call and records the rest as skipped', async () => {
    const provider = new FakeLlmProvider(replies(1));
    const result = await runContentPlan(input, deps(provider), { minimal: true });
    expect(provider.requests).toHaveLength(1);
    const by = Object.fromEntries(result.steps.map((s) => [s.id, s]));
    expect(by['research-brief']!.status).toBe('skipped');
    expect(by['editorial']!.status).toBe('skipped');
  });

  it('records a failed evidence step when there are neither facts nor a url', async () => {
    const result = await runContentPlan({ ...input, facts: [] }, deps(new FakeLlmProvider([])), { styleDir: NO_STYLE });
    expect(result.status).toBe('needs_human');
    expect(result.steps.find((s) => s.id === 'evidence')).toMatchObject({ status: 'failed' });
    expect(result.steps).toHaveLength(PLAN.length);
  });
});

describe('no verified figure: a post without numbers from Ken Research notes', () => {
  const notes = [
    { id: 'N1', sourceUrl: item.reportUrl, text: 'Buyers weigh service coverage above price when they choose a widget supplier.' },
    { id: 'N2', sourceUrl: item.reportUrl, text: 'Premium widget segments are growing faster than entry level products in the region.' },
    { id: 'N3', sourceUrl: item.reportUrl, text: 'Distribution partnerships determine which suppliers reach smaller regional buyers.' },
  ];
  const noNumbers = `Ken Research notes that buyers weigh service coverage above price when choosing a widget supplier. Full outlook: ${utmLink('x')} #Widgets #Examplestan`;
  const factless = { ...input, facts: [] as never[], notes };

  it('writes a post from the notes, states no figure, and says so in the plan', async () => {
    const result = await runContentPlan(factless, deps(new FakeLlmProvider(replies(3, noNumbers))), { styleDir: NO_STYLE });
    expect(result.status).toBe('approved');
    expect(result.draft?.text).not.toMatch(/\d/);
    expect(result.draft?.factIds).toEqual([]);
    expect(JSON.stringify(result.steps.find((s) => s.id === 'evidence')?.detail)).toMatch(/WITHOUT numbers, written from 3 Ken Research source notes/);
  });

  it('a figure in such a post is rejected: only verified facts may carry numbers', async () => {
    const withFigure = noNumbers.replace('buyers weigh', 'buyers (12% of them) weigh');
    const result = await runContentPlan(factless, deps(new FakeLlmProvider(replies(8, withFigure))), { styleDir: NO_STYLE });
    expect(result.status).toBe('needs_human');
  });

  it('stops at NO_VERIFIED_FACTS when the fallback is off or there are too few notes', async () => {
    const off = await runContentPlan(factless, deps(new FakeLlmProvider([])), { styleDir: NO_STYLE, qualitativeFallback: false });
    expect(off.reason).toMatch(/^NO_VERIFIED_FACTS/);
    const few = await runContentPlan({ ...factless, notes: notes.slice(0, 2) }, deps(new FakeLlmProvider([])), { styleDir: NO_STYLE });
    expect(few.reason).toMatch(/^NO_VERIFIED_FACTS/);
  });
});
