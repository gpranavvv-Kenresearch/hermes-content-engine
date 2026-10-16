import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import type { PlanResult } from '../../src/pipeline/run-plan.js';
import { HermesProvider, parseHermesStream } from '../../src/social/hermes-provider.js';
import { loadLessons, loadRecentRepairTraces, recordLearning } from '../../src/social/learning.js';
import { choosePrimaryKeyword } from '../../src/social/runner.js';
import { MemoryStore } from '../../src/store/store.js';
import { validateText } from '../../src/validation/validate-draft.js';

describe('social acceptance rules', () => {
  const config = loadConfig();
  const validate = (text: string, minUsefulWords?: number) => validateText({
    draftId: 'draft_social_test', platform: 'facebook', text, facts: [], recentTexts: [],
    claimChecker: () => ({ issues: [], mappings: [] }), requiredKeyword: 'India solar power market',
    ...(minUsefulWords !== undefined ? { minUsefulWords } : {}),
  }, config);

  it('requires the primary phrase in the visible body, not only in a hashtag or URL', () => {
    const missing = validate('Ken Research observes policy changes. #IndiaSolarPowerMarket https://kenresearch.com/india-solar-power-market');
    expect(missing.issues.map((issue) => issue.code)).toContain('REQUIRED_KEYWORD_MISSING');
    const present = validate('The India solar power market raises a planning question for investors. Ken Research provides the report.');
    expect(present.issues.map((issue) => issue.code)).not.toContain('REQUIRED_KEYWORD_MISSING');
  });

  it('blocks a shallow post even when the keyword appears', () => {
    const report = validate('India solar power market. Ken Research.', 95);
    expect(report.issues.map((issue) => issue.code)).toContain('THIN_CONTENT');
  });

  it('takes an explicit keyword over title inference', () => {
    expect(choosePrimaryKeyword('India Solar Power Market Size Report', 'solar power in India')).toBe('solar power in India');
    expect(choosePrimaryKeyword('India Solar Power Market Size Report')).toBe('India Solar Power');
  });
});

describe('Hermes protocol and repair learning', () => {
  it('uses the terminal result record rather than streamed text fragments', () => {
    const event = parseHermesStream('{"type":"text","text":"partial"}\n{"type":"result","exit_code":0,"text":"final","tokens":{"total":32}}\n');
    expect(event.text).toBe('final');
    expect(event.tokens?.total).toBe(32);
    expect(() => parseHermesStream('{"type":"text","text":"only partial"}\n')).toThrow('no terminal result');
  });

  it('keeps Hermes requests within a shared count', async () => {
    const provider = new HermesProvider({ maxCalls: 0 });
    await expect(provider.generate({ prompt: 'draft', purpose: 'draft' })).rejects.toThrow('budget exhausted');
  });

  it('records a failed step, keeps a scoped lesson, and activates after successful reuse', async () => {
    const store = new MemoryStore();
    const result = (runId: string): PlanResult => ({
      runId, status: 'approved', reason: 'passed validation',
      draft: { text: 'Final approved text', platform: 'facebook' },
      rewrite: { attempts: [
        { index: 0, kind: 'initial', round: 0, text: 'No keyword', report: { passed: false, issues: [{ code: 'REQUIRED_KEYWORD_MISSING', severity: 'hard_fail', message: 'missing' }] }, factIds: [], adopted: true },
        { index: 1, kind: 'rewrite', round: 1, text: 'With keyword', report: { passed: true, issues: [] }, factIds: [], adopted: true },
      ] },
    } as unknown as PlanResult);
    const first = await recordLearning(store, result('run_one'), 'facebook', 'India solar power', [], [], 2, 100);
    expect(first.trace.attempts[0]?.failedCodes).toEqual(['REQUIRED_KEYWORD_MISSING']);
    expect(first.newLessons[0]?.status).toBe('candidate');
    const lessonId = first.newLessons[0]!.id;
    await recordLearning(store, result('run_two'), 'facebook', 'India solar power', [], [lessonId], 2, 100);
    expect((await loadLessons(store, 'facebook'))[0]?.status).toBe('active');
    expect(await loadLessons(store, 'linkedin')).toEqual([]);
    expect((await loadRecentRepairTraces(store, 'facebook', 1))[0]?.runId).toBe('run_two');
    expect(await loadRecentRepairTraces(store, 'linkedin')).toEqual([]);
  });
});
