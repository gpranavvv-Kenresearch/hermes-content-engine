import { describe, expect, it } from 'vitest';
import { checkClaims } from '../../src/evidence/index.js';
import { MemoryStore } from '../../src/store/store.js';
import { FakeLlmProvider, config, reply, sampleFact, wrapReply } from '../../tests/fixtures/validation/helpers.js';
import type { AgentDeps } from '../src/agents/deps.js';
import type { EvidenceOutput } from '../src/agents/evidence.js';
import { runLearningAgent } from '../src/agents/learning.js';
import { runStrategyAgent } from '../src/agents/strategy.js';
import { runValidatorAgent } from '../src/agents/validator.js';
import { RunLimits } from '../src/limits.js';

const item = { id: 'item-1', title: 'Examplestan Widget Market', reportUrl: 'https://www.kenresearch.com/industry-reports/examplestan-widget-market' };
const evidence: EvidenceOutput = { itemId: 'item-1', reportPageLoaded: true, facts: [sampleFact], notes: [], mode: 'figures', verifiedFigures: 1, sources: [item.reportUrl] };

function deps(writer: FakeLlmProvider): AgentDeps {
  return {
    config,
    store: new MemoryStore(),
    claimChecker: checkClaims,
    writer,
    sheets: { tab: 't', read: async () => [], writeCell: async () => {} },
    limits: new RunLimits(),
    now: () => new Date('2026-10-14T10:00:00Z'),
  };
}

describe('validator agent', () => {
  it('reports hard fails and needs_human when the draft cannot be repaired', async () => {
    const bad = 'Too short.';
    const d = deps(new FakeLlmProvider([reply(wrapReply(bad, ['F1']))]));
    const strategy = (await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'examplestan widget market', attempt: 0 }, d)).output;
    const report = await runValidatorAgent(
      { item, evidence, strategy, draft: { text: bad, factIds: ['F1'], promptVersion: 'v' }, platform: 'linkedin', keyword: 'examplestan widget market', minUsefulWords: 110, instructions: 'Do not reintroduce the unsupported country ranking.' },
      d,
    );
    expect(report.output.passed).toBe(false);
    expect(report.output.hardFails.length).toBeGreaterThan(0);
    expect(report.output.status).toBe('needs_human');
    expect(report.concerns.length).toBeGreaterThan(0);
    expect((await d.store.list('supervisor-hermes-drafts')).length).toBe(0);
    const requests = (d.writer as FakeLlmProvider).requests;
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.prompt).toContain('Do not reintroduce the unsupported country ranking.');
  });
});

describe('learning agent', () => {
  it('records a repair trace for the run', async () => {
    const d = deps(new FakeLlmProvider([]));
    const report = await runLearningAgent(
      {
        runId: 'run_1',
        platform: 'linkedin',
        keyword: 'k k',
        status: 'needs_human',
        reason: 'no',
        validator: { passed: false, status: 'needs_human', reason: 'no', text: '', markdown: '', hardFails: ['THIN_CONTENT'], reviewCodes: [], score: null, rewriteRounds: 0, attempts: [] },
      },
      d,
    );
    expect(report.output.newLessons).toEqual([]);
    expect((await d.store.list('social-repair-traces')).length).toBe(1);
  });
});
