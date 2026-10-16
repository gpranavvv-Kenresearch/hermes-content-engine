import { describe, expect, it } from 'vitest';
import { checkClaims } from '../../src/evidence/index.js';
import { REVIEW_QUEUE_COLLECTION, RUNS_COLLECTION, DRAFTS_COLLECTION, generateContent, type PipelineDeps } from '../../src/pipeline/index.js';
import { loadFlags } from '../../src/safety/flags.js';
import type { Draft } from '../../src/schemas/index.js';
import { MemoryStore } from '../../src/store/store.js';
import { buildCompetitorDetector } from '../../src/validation/competitors.js';
import { FakeLlmProvider, config, reply, sampleFact, utmLink, wrapReply } from '../fixtures/validation/helpers.js';

const item = {
  id: 'item-1',
  title: 'Examplestan Widget Market',
  reportUrl: 'https://www.kenresearch.com/industry-reports/examplestan-widget-market',
};
const NOW = new Date('2026-10-13T10:00:00Z');

const goodX = `Ken Research finds the Examplestan widget market reached USD 4.2 billion in 2025, with buyers shifting toward premium segments. Full outlook: ${utmLink('x')} #Widgets #Examplestan`;
const competitorX = `According to IMARC Group, the Examplestan widget market reached USD 4.2 billion in 2025. Full outlook: ${utmLink('x')} #Widgets #Examplestan`;
const unsupportedX = `Ken Research finds the Examplestan widget market reached USD 9.9 billion in 2025, with buyers shifting toward premium segments. Full outlook: ${utmLink('x')} #Widgets #Examplestan`;

function makeDeps(provider: FakeLlmProvider, env: Record<string, string> = {}): PipelineDeps & { store: MemoryStore } {
  return {
    config,
    provider,
    claimChecker: checkClaims,
    store: new MemoryStore(),
    flags: loadFlags(env),
    now: () => NOW,
    seed: 1,
  };
}

const input = { item, facts: [sampleFact], campaignId: 'authority-insights', platform: 'x' as const };

describe('generateContent', () => {
  it('approves a clean draft, stamps versions, records the run and publishes nothing', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(goodX, ['F1']))]);
    const deps = makeDeps(provider);
    const result = await generateContent(input, deps);

    expect(result.status).toBe('approved');
    expect(provider.requests).toHaveLength(1);
    expect(result.draft).toMatchObject({ status: 'approved', platform: 'x', itemId: 'item-1', factIds: ['F1'], configVersion: config.version, attempt: 1 });
    expect(result.draft?.text).toBe(goodX);

    const stored = await deps.store.get<Draft>(DRAFTS_COLLECTION, result.draft!.id);
    expect(stored?.text).toBe(goodX);
    const run = await deps.store.get<{ flags: { dryRun: boolean; shadowMode: boolean }; status: string }>(RUNS_COLLECTION, result.runId);
    expect(run).toMatchObject({ status: 'approved', flags: { dryRun: true, shadowMode: true } });
    expect(await deps.store.list('variants')).toHaveLength(1);
    expect(await deps.store.list(REVIEW_QUEUE_COLLECTION)).toHaveLength(0);
  });

  it('rewrites a draft that names a competitor and approves the fixed version', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(competitorX, ['F1'])), reply(wrapReply(goodX, ['F1']))]);
    const deps = makeDeps(provider);
    const result = await generateContent(input, deps);

    expect(result.status).toBe('approved');
    expect(provider.requests).toHaveLength(2);
    expect(result.draft?.text).toBe(goodX);
    expect(result.draft?.attempt).toBe(2);
    expect(result.rewrite?.attempts.some((a) => a.kind === 'rewrite' && a.adopted)).toBe(true);
    // the rewrite prompt carries the exact failure, not a blind "try again"
    expect(provider.requests[1]!.prompt).toContain('COMPETITOR_MENTION');
  });

  it('blocks an unsupported number and sends the run to review when rewrites are disabled', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(unsupportedX, ['F1']))]);
    const deps = makeDeps(provider, { CE_REWRITE_MAX_ROUNDS: '0' });
    const result = await generateContent(input, deps);

    expect(result.status).toBe('needs_human');
    expect(result.reason).toMatch(/rewrite rounds exhausted/);
    expect(result.rewrite?.finalReport?.issues.map((i) => i.code)).toContain('UNSUPPORTED_NUMERIC_CLAIM');
    expect(result.draft?.status).toBe('needs_human');
    expect(await deps.store.list(REVIEW_QUEUE_COLLECTION)).toHaveLength(1);
  });

  it('fixes an unsupported number through a rewrite round', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(unsupportedX, ['F1'])), reply(wrapReply(goodX, ['F1']))]);
    const result = await generateContent(input, makeDeps(provider));
    expect(result.status).toBe('approved');
    expect(provider.requests[1]!.prompt).toContain('UNSUPPORTED_NUMERIC_CLAIM');
  });

  it('refuses to generate without verified facts, and never calls the model', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(goodX, ['F1']))]);
    const deps = makeDeps(provider);
    const result = await generateContent({ ...input, facts: [{ ...sampleFact, verificationStatus: 'unverified' }] }, deps);

    expect(result.status).toBe('needs_human');
    expect(result.reason).toMatch(/NO_VERIFIED_FACTS/);
    expect(provider.requests).toHaveLength(0);
    expect(await deps.store.list(REVIEW_QUEUE_COLLECTION)).toHaveLength(1);
  });

  it('does not use conflicting facts', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(goodX, ['F1']))]);
    const conflicting = [sampleFact, { ...sampleFact, id: 'F2', value: 5.1 }];
    const result = await generateContent({ ...input, facts: conflicting }, makeDeps(provider));
    expect(result.status).toBe('needs_human');
    expect(provider.requests).toHaveLength(0);
  });

  it('ends the run as needs_human on an incomplete (cut-off) reply instead of using it', async () => {
    const provider = new FakeLlmProvider([reply('<<<CE_OUTPUT>>> half a rep', false)]);
    const result = await generateContent(input, makeDeps(provider));
    expect(result.status).toBe('needs_human');
    expect(result.reason).toMatch(/incomplete reply/);
    expect(result.draft).toBeNull();
  });

  it('ends the run as needs_human on an unparseable reply', async () => {
    const provider = new FakeLlmProvider([reply('Sure! here is a tweet without the markers')]);
    const result = await generateContent(input, makeDeps(provider));
    expect(result.status).toBe('needs_human');
    expect(result.reason).toMatch(/unparseable/);
  });

  it('rejects a campaign that does not publish to the platform, and an unknown campaign', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(goodX, ['F1']))]);
    const bad = await generateContent({ ...input, campaignId: 'evergreen-pillars' }, makeDeps(provider));
    expect(bad.status).toBe('needs_human');
    expect(bad.reason).toMatch(/does not publish/);
    const unknown = await generateContent({ ...input, campaignId: 'nope' }, makeDeps(provider));
    expect(unknown.reason).toMatch(/unknown or inactive campaign/);
    expect(provider.requests).toHaveLength(0);
  });

  it('never sends a competitor name, or an unsupplied fact, to the model', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(goodX, ['F1']))]);
    await generateContent(input, makeDeps(provider));
    const detector = buildCompetitorDetector(config.competitors);
    for (const req of provider.requests) {
      expect(detector.find(req.prompt)).toEqual([]);
      expect(req.prompt).toContain('F1');
      expect(req.prompt).toContain('4.2');
    }
  });

  it('drops fact ids the model cites that were never supplied', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(goodX, ['F1', 'GHOST']))]);
    const result = await generateContent(input, makeDeps(provider));
    expect(result.draft?.factIds).toEqual(['F1']);
  });

  it('runs research -> outline -> draft for a blog', async () => {
    const blogText = `# Examplestan widget market in 2025\n\nKen Research finds the Examplestan widget market reached USD 4.2 billion in 2025. Read the full report: ${utmLink('blog')}`;
    const provider = new FakeLlmProvider([
      reply(wrapReply('Research notes about the strongest finding.', ['F1'])),
      reply(wrapReply('Outline: intro, segments, outlook.', ['F1'])),
      reply(wrapReply(blogText, ['F1'])),
    ]);
    const result = await generateContent(
      { ...input, platform: 'blog' },
      { ...makeDeps(provider), allowBlogGeneration: true },
    );
    expect(provider.requests.slice(0, 3).map((r) => r.purpose)).toEqual(['research-brief', 'outline', 'draft']);
    expect(result.stages.map((s) => s.stage)).toEqual(['research-brief', 'outline', 'draft']);
    // the draft prompt carries the earlier stages' notes
    expect(provider.requests[2]!.prompt).toContain('Research notes about the strongest finding.');
    expect(provider.requests[2]!.prompt).toContain('Outline: intro, segments, outlook.');
  });

  it('does not re-sample the same variant combination for the same item', async () => {
    const store = new MemoryStore();
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const provider = new FakeLlmProvider([reply(wrapReply(goodX, ['F1']))]);
      const result = await generateContent(input, { ...makeDeps(provider), store, seed: undefined as never });
      const v = result.variant!;
      seen.add(`${v.tone}|${v.opener}|${v.structure}`);
    }
    expect(seen.size).toBe(4);
  });
});
