import { describe, expect, it } from 'vitest';
import { createLearningAdvice } from '../src/advisor.js';
import { adviceRecords, postReviewRecords } from '../src/sheets.js';
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

const review = (n: string) => ({
  seoAssessment: `${n}: the opening names APAC but omits the complete airport operations keyword phrase.`,
  b2bAssessment: `${n}: the post asks a broad question without a specific buyer decision.`,
  contentProblem: `${n}: search context and decision value are weaker than the comparison post.`,
  recommendedTest: `${n}: use a stat-led opening followed by one supplier-selection implication.`,
});
const aggregate = {
  executiveSummary: 'LinkedIn posts show a measurable opening-style difference, but public reach is unavailable and the result remains diagnostic.',
  platformLearning: [{ signal: 'Opening clarity', evidencePostIds: ['p1', 'unknown'], interpretation: 'The stat-led example has more visible interactions in this small sample.', nextTest: 'Test stat-led versus question-led openings while holding layout and topic constant.' }],
  promptRecommendations: [{ target: 'writer', priority: 'high', problem: 'The opening is broad.', evidencePostIds: ['p1'], proposedInstruction: 'Test one evidence-led opening that includes the market entity and a buyer decision.', expectedEffect: 'Improves search context and B2B relevance.', guardrail: 'Suggestion only; preserve report evidence and the approved format.' }],
};
/** Answers per purpose, like the real engine: one review per post, then one platform summary. */
function scriptedAsk(calls: string[] = []) {
  return async (prompt: string, purpose: string) => {
    calls.push(purpose);
    if (purpose === 'performance-post-review') return JSON.stringify(review(/"postId":"(\w+)"/.exec(prompt)?.[1] ?? '?'));
    return JSON.stringify(aggregate);
  };
}

describe('deep learning advisory', () => {
  it('reviews each post on its own, then summarises the platform, without applying anything', async () => {
    const data = fixture();
    const calls: string[] = [];
    const advice = await createLearningAdvice({ ...data, sources: [], platform: 'linkedin', at, ask: scriptedAsk(calls) });
    expect(calls).toEqual(['performance-post-review', 'performance-post-review', 'performance-deep-learning-advice']);
    expect(advice.modelStatus).toBe('hermes');
    expect(advice.mode).toBe('suggestions_only');
    expect(advice.platformLearning[0]!.evidencePostIds).toEqual(['p1']);
    expect(advice.postInsights).toHaveLength(2);
    expect(advice.postInsights[0]!.seoAssessment).toContain('p1:');
    expect(advice.postInsights[1]!.seoAssessment).toContain('p2:');
    expect(advice.promptRecommendations).toHaveLength(1);
    const records = adviceRecords(advice);
    expect(records).toHaveLength(4);
    expect(records.every(record => record.fields['PE Action'] === 'suggestion_only' || record.fields['PE Action'] === 'prompt_change_proposed')).toBe(true);
    expect(records.some(record => record.content.includes('Prompt files were not modified'))).toBe(true);
  });

  it('writes one Algo Reports row per post with a stable id, so a rerun updates the same row', async () => {
    const data = fixture();
    const advice = await createLearningAdvice({ ...data, sources: [], platform: 'linkedin', at, ask: scriptedAsk() });
    const rows = postReviewRecords(advice);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.fields['PE Post ID'])).toEqual(['p1', 'p2']);
    expect(rows.every(r => r.fields.Platform === 'LinkedIn' && r.fields['Rows Read'] === 1 && r.fields['PE Action'] === 'post_review')).toBe(true);
    expect(rows[0]!.fields['Content Analysis']).toContain('SEO');
    const again = postReviewRecords(await createLearningAdvice({ ...data, sources: [], platform: 'linkedin', at: new Date('2026-10-27T12:00:00Z'), ask: scriptedAsk() }));
    expect(again.map(r => r.id)).toEqual(rows.map(r => r.id));
  });

  it('reuses saved post reviews on a rerun and only asks Hermes for what is missing', async () => {
    const data = fixture();
    const saved = new Map<string, unknown>();
    const cache = { get: async (key: string) => (saved.get(key) as never) ?? null, put: async (key: string, value: never) => { saved.set(key, value); } };
    const first: string[] = [];
    await createLearningAdvice({ ...data, sources: [], platform: 'linkedin', at, ask: scriptedAsk(first), cache });
    expect(first.filter(p => p === 'performance-post-review')).toHaveLength(2);
    expect(saved.size).toBe(2);
    const second: string[] = [];
    const progress: string[] = [];
    await createLearningAdvice({ ...data, sources: [], platform: 'linkedin', at, ask: scriptedAsk(second), cache, onProgress: p => progress.push(p.source) });
    expect(second).toEqual(['performance-deep-learning-advice']);
    expect(progress).toEqual(['cached', 'cached']);
  });

  it('trims over-long lists and text from Hermes instead of discarding the answer', async () => {
    const data = fixture();
    const big = {
      ...aggregate,
      executiveSummary: 'S'.repeat(5000),
      platformLearning: Array.from({ length: 25 }, (_, i) => ({ signal: `Signal ${i}`, evidencePostIds: Array.from({ length: 40 }, () => 'p1'), interpretation: 'I'.repeat(900), nextTest: 'Test one alternative while holding the rest constant.' })),
    };
    const ask = async (_prompt: string, purpose: string) => JSON.stringify(purpose === 'performance-post-review' ? review('x') : big);
    const advice = await createLearningAdvice({ ...data, sources: [], platform: 'linkedin', at, ask });
    expect(advice.modelStatus).toBe('hermes');
    expect(advice.platformLearning).toHaveLength(20);
    expect(advice.executiveSummary.length).toBeLessThanOrEqual(3000);
  });

  it('keeps a readable deterministic advisory when Hermes is unavailable for a short run', async () => {
    const data = fixture();
    const advice = await createLearningAdvice({ ...data, sources: [], platform: 'linkedin', at, ask: async () => { throw new Error('offline'); } });
    expect(advice.modelStatus).toBe('deterministic_fallback');
    expect(advice.modelError).toContain('offline');
    expect(advice.postInsights).toHaveLength(2);
  });

  it('stops after three failed posts in a row and keeps what was already reviewed', async () => {
    const base = fixture();
    const extra = (id: string, n: number) => ({ ...base.posts[0]!, id, postId: `${n}234567890123456789`, url: `https://www.linkedin.com/feed/update/urn:li:activity:${n}234567890123456789/` });
    const posts = [...base.posts, extra('p3', 3), extra('p4', 4), extra('p5', 5)];
    const snapshots = [...base.snapshots, ...['p3', 'p4', 'p5'].map((id, i) => snapshot({ id: `s${i + 3}`, postId: id, platform: 'linkedin', accountId: null, window: 'late', metrics: { ...emptyMetrics(), reactions: i + 1, comments: 0 } }))];
    const saved = new Map<string, unknown>();
    const cache = { get: async (key: string) => (saved.get(key) as never) ?? null, put: async (key: string, value: never) => { saved.set(key, value); } };
    let n = 0;
    const ask = async () => { n++; if (n <= 2) return JSON.stringify(review('ok')); throw new Error('Codex provider quota exhausted (429)'); };
    await expect(createLearningAdvice({ posts, snapshots, findings: evaluateTestRun(posts, snapshots, [], at), sources: [], platform: 'linkedin', at, ask, cache })).rejects.toThrow(/3 posts in a row/);
    expect(saved.size).toBe(2);
  });
});
