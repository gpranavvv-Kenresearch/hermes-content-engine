import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../../src/store/store.js';
import { FakeLlmProvider, config, reply, sampleFact, utmLink, wrapReply } from '../../tests/fixtures/validation/helpers.js';
import type { AgentDeps } from '../src/agents/deps.js';
import type { EvidenceOutput } from '../src/agents/evidence.js';
import { runStrategyAgent } from '../src/agents/strategy.js';
import { runWriterAgent } from '../src/agents/writer.js';
import { RunLimits } from '../src/limits.js';
import { LearningAdvice } from '../../performance-engine/src/contracts.js';
import { buildPromptGuidance, replacePromptGuidance } from '../../performance-engine/src/guidance.js';

const item = { id: 'item-1', title: 'Examplestan Widget Market', reportUrl: 'https://www.kenresearch.com/industry-reports/examplestan-widget-market' };
const evidence: EvidenceOutput = { itemId: 'item-1', reportPageLoaded: true, facts: [sampleFact], notes: [], mode: 'figures', verifiedFigures: 1, sources: [item.reportUrl] };

function deps(writer: FakeLlmProvider): AgentDeps {
  return {
    config,
    store: new MemoryStore(),
    claimChecker: () => ({ issues: [], mappings: [] }),
    writer,
    sheets: { tab: 't', read: async () => [], writeCell: async () => {} },
    limits: new RunLimits(),
    now: () => new Date('2026-10-14T10:00:00Z'),
  };
}

describe('strategy agent', () => {
  it('chooses a persona, layout and variant and records the variant', async () => {
    const d = deps(new FakeLlmProvider([]));
    const report = await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'examplestan widget market', attempt: 0 }, d);
    expect(report.output.personaId).toBeTruthy();
    expect(report.output.brief.keywords[0]).toBe('examplestan widget market');
    expect(report.output.variant.layout).toBeTruthy();
    expect((await d.store.list('variants')).length).toBe(1);
  });
  it('samples a different variant for a later attempt', async () => {
    const d = deps(new FakeLlmProvider([]));
    const a = await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'k k', attempt: 0 }, d);
    const b = await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'k k', attempt: 1 }, d);
    expect(JSON.stringify(a.output.variant)).not.toBe(JSON.stringify(b.output.variant));
  });
  it('feeds the latest replacement guidance into the next writer prompt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-writer-guidance-'));
    const previous = process.env.PE_GUIDANCE_ROOT;
    process.env.PE_GUIDANCE_ROOT = root;
    try {
      const advice = LearningAdvice.parse({ id: 'advice-1', at: '2026-10-13T10:00:00.000Z', platform: 'linkedin', mode: 'suggestions_only', modelStatus: 'hermes', researchMode: 'curated_only', executiveSummary: 'Measured.', platformLearning: [], postInsights: [], promptRecommendations: [{ id: 'r1', target: 'writer', priority: 'high', problem: 'Broad opening.', evidencePostIds: ['p1'], proposedInstruction: 'Use the complete report topic in the first sentence.', expectedEffect: 'Clearer opening.', guardrail: 'Use supplied evidence.' }], findingIds: ['f1'], sourceIds: [], modelError: null });
      const guidance = buildPromptGuidance(advice, new Date('2026-10-13T10:00:00Z'));
      await replacePromptGuidance(root, guidance);
      const provider = new FakeLlmProvider([reply(wrapReply('Draft.', ['F1']))]);
      const d = deps(provider);
      const strategy = (await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'examplestan widget market', attempt: 0 }, d)).output;
      expect(strategy.performanceGuidanceVersion).toBe(guidance.version);
      expect(strategy.techniques.join('\n')).toContain('Use the complete report topic in the first sentence.');
      await runWriterAgent({ item, evidence, strategy, platform: 'linkedin' }, d);
      expect(provider.requests[0]!.prompt).toContain('Use the complete report topic in the first sentence.');
    } finally {
      if (previous === undefined) delete process.env.PE_GUIDANCE_ROOT; else process.env.PE_GUIDANCE_ROOT = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('writer agent', () => {
  it('prompts the writer with the supervisor instructions and parses the reply', async () => {
    const text = `Ken Research finds the Examplestan widget market reached USD 4.2 billion in 2025. Full outlook: ${utmLink('linkedin')} #Widgets`;
    const provider = new FakeLlmProvider([reply(wrapReply(text, ['F1']))]);
    const d = deps(provider);
    const strategy = (await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'examplestan widget market', attempt: 0 }, d)).output;
    const report = await runWriterAgent({ item, evidence, strategy, platform: 'linkedin', instructions: 'Avoid generic closing lines.' }, d);
    expect(report.output.text).toContain('USD 4.2 billion');
    expect(report.output.factIds).toEqual(['F1']);
    expect(provider.requests[0]!.prompt).toContain('Avoid generic closing lines.');
  });
  it('throws when the reply is unusable', async () => {
    const d = deps(new FakeLlmProvider([reply('no markers at all')]));
    const strategy = (await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'k k', attempt: 0 }, d)).output;
    await expect(runWriterAgent({ item, evidence, strategy, platform: 'linkedin' }, d)).rejects.toThrow(/unparseable/);
  });
  it('edits the current validated draft on retry instead of starting from scratch', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply('Edited draft.', ['F1']))]);
    const d = deps(provider);
    const strategy = (await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'k k', attempt: 0 }, d)).output;
    await runWriterAgent({ item, evidence, strategy, platform: 'linkedin', previousDraft: 'Keep this compliant paragraph.', instructions: 'Change only the engagement question.' }, d);
    expect(provider.requests[0]!.purpose).toBe('rewrite');
    expect(provider.requests[0]!.prompt).toContain('CURRENT DRAFT:\nKeep this compliant paragraph.');
    expect(provider.requests[0]!.prompt).toContain('Change only the engagement question.');
    expect(provider.requests[0]!.prompt).toContain('selected format and its question count');
  });
});
