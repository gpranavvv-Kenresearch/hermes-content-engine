import { describe, expect, it } from 'vitest';
import { createLearningAdvice } from '../src/advisor.js';
import { adviceRecords } from '../src/sheets.js';
import { evaluateTestRun } from '../src/learner.js';
import { emptyMetrics } from '../src/contracts.js';
import { post, snapshot } from './helpers.js';

const at = new Date('2026-10-16T12:00:00Z');
function fixture() {
  const posts = [
    post({ id: 'p1', platform: 'linkedin', accountId: null, url: 'https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/', postId: '1234567890123456789', reportUrl: 'https://www.kenresearch.com/industry-reports/apac-airport-operations-market', text: 'Is APAC ready?\n\nUSD 100 million evidence.\n\nWhat should buyers prioritise?\n\n#APAC #AirportOperations' }),
    post({ id: 'p2', platform: 'linkedin', accountId: null, url: 'https://www.linkedin.com/feed/update/urn:li:activity:2234567890123456789/', postId: '2234567890123456789', reportUrl: 'https://www.kenresearch.com/industry-reports/apac-airport-operations-market', text: 'APAC airport operations reached USD 100 million.\n\nThe decision implication is supplier capability.\n\nWhich priority matters?\n\n#APAC #AirportOperations' }),
  ];
  const snapshots = [
    snapshot({ id: 's1', postId: 'p1', platform: 'linkedin', accountId: null, window: 'late', metrics: { ...emptyMetrics(), reactions: 1, comments: 0 } }),
    snapshot({ id: 's2', postId: 'p2', platform: 'linkedin', accountId: null, window: 'late', metrics: { ...emptyMetrics(), reactions: 8, comments: 1 } }),
  ];
  return { posts, snapshots, findings: evaluateTestRun(posts, snapshots, [], at) };
}

describe('deep learning advisory', () => {
  it('creates Hermes-backed post reviews and prompt proposals without applying them', async () => {
    const data = fixture();
    const ask = async () => JSON.stringify({
      executiveSummary: 'LinkedIn posts show a measurable opening-style difference, but public reach is unavailable and the result remains diagnostic.',
      platformLearning: [{ signal: 'Opening clarity', evidencePostIds: ['p1', 'unknown'], interpretation: 'The stat-led example has more visible interactions in this small sample.', nextTest: 'Test stat-led versus question-led openings while holding layout and topic constant.' }],
      postInsights: [{ postId: 'p1', seoAssessment: 'The opening names APAC but omits the complete airport operations keyword phrase.', b2bAssessment: 'The post asks a broad question without a specific buyer decision.', contentProblem: 'Search context and decision value are weaker than the comparison post.', recommendedTest: 'Use a stat-led opening followed by one supplier-selection implication.' }],
      promptRecommendations: [{ target: 'writer', priority: 'high', problem: 'The opening is broad.', evidencePostIds: ['p1'], proposedInstruction: 'Test one evidence-led opening that includes the market entity and a buyer decision.', expectedEffect: 'Improves search context and B2B relevance.', guardrail: 'Suggestion only; preserve report evidence and the approved format.' }],
    });
    const advice = await createLearningAdvice({ ...data, sources: [], platform: 'linkedin', at, ask });
    expect(advice.modelStatus).toBe('hermes');
    expect(advice.mode).toBe('suggestions_only');
    expect(advice.platformLearning[0]!.evidencePostIds).toEqual(['p1']);
    expect(advice.postInsights).toHaveLength(2);
    expect(advice.promptRecommendations).toHaveLength(1);
    const records = adviceRecords(advice);
    expect(records).toHaveLength(4);
    expect(records.every(record => record.fields['PE Action'] === 'suggestion_only' || record.fields['PE Action'] === 'prompt_change_proposed')).toBe(true);
    expect(records.some(record => record.content.includes('Prompt files were not modified'))).toBe(true);
  });

  it('keeps a readable deterministic advisory when Hermes is unavailable', async () => {
    const data = fixture();
    const advice = await createLearningAdvice({ ...data, sources: [], platform: 'linkedin', at, ask: async () => { throw new Error('offline'); } });
    expect(advice.modelStatus).toBe('deterministic_fallback');
    expect(advice.modelError).toContain('offline');
    expect(advice.postInsights).toHaveLength(2);
  });
});
