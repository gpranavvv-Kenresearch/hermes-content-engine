import { describe, expect, it } from 'vitest';
import { parsePostUrl } from '../src/urls.js';
import { discover, exactDate } from '../src/discovery.js';
import { emptyMetrics, Finding, Metrics, Post, thresholds } from '../src/contracts.js';
import { dueWindows } from '../src/tracker.js';
import { evaluate, evaluateTestRun, interactionRate } from '../src/learner.js';
import { parseCsv } from '../src/imports.js';
import { createReport } from '../src/reporter.js';
import { postDiagnosticRecords } from '../src/sheets.js';
import { post, snapshot } from './helpers.js';

describe('published post identity', () => {
  it.each([
    ['https://x.com/ken/status/1844674407370955161?x=1', 'x', '1844674407370955161'],
    ['https://twitter.com/ken/status/123', 'x', '123'],
    ['https://x.com/i/web/status/123', 'x', '123'],
    ['https://www.linkedin.com/feed/update/urn:li:ugcPost:1234567890123456789/', 'linkedin', '1234567890123456789'],
    ['https://www.linkedin.com/posts/someone_topic-activity-1234567890123456789-x/', 'linkedin', '1234567890123456789'],
    ['https://lnkd.in/p/gWhXGsVQ', 'linkedin', 'short:gWhXGsVQ'],
    ['https://www.facebook.com/ken/posts/pfbidABC123', 'facebook', 'pfbidABC123'],
    ['https://www.facebook.com/permalink.php?story_fbid=123&id=456', 'facebook', '123'],
    ['https://www.facebook.com/share/p/18iW9RKF1m/', 'facebook', 'share:18iW9RKF1m'],
    ['https://ken.tumblr.com/post/123/title', 'tumblr', '123'],
    ['https://www.tumblr.com/ken/123/title', 'tumblr', '123'],
  ])('parses %s', (url, platform, id) => { const parsed = parsePostUrl(url); expect(parsed.platform).toBe(platform); expect(parsed.postId).toBe(id); });
  it.each(['http://x.com/ken/status/123', 'https://x.com.evil.test/ken/status/123', 'https://user:pass@x.com/ken/status/123', 'https://localhost/post/123', 'https://www.tumblr.com/', 'https://linkedin.com/in/someone'])('rejects unsupported %s', u => expect(() => parsePostUrl(u)).toThrow());
  it('rejects platform mismatch', () => expect(() => parsePostUrl('https://x.com/ken/status/123', 'linkedin')).toThrow());
  it('preserves the LinkedIn URN type in the canonical URL', () => expect(parsePostUrl('https://www.linkedin.com/feed/update/urn:li:ugcPost:1234567890123456789/').canonicalUrl).toContain('urn:li:ugcPost:'));
  it('accepts only exact publication timestamps, not locale guesses', () => { expect(exactDate('16/10/2026 11:00')).toBeNull(); expect(exactDate('2026-10-16')).toBeNull(); expect(exactDate('2026-10-16T11:00:00+05:30')).toBe('2026-10-16T05:30:00.000Z'); });
  it('discovers URLs, ignores unpublished text, keeps distinct posts for one report', () => {
    const rows = [['X Post URL', 'X Post', 'targetUrl'], ['https://x.com/ken/status/123', 'a', 'report'], ['', 'generated only', 'report'], ['https://x.com/ken/status/124', 'b', 'report'], ['https://x.com/ken/status/123', 'a', 'report']];
    const r = discover(rows, []); expect(r.posts).toHaveLength(2); expect(r.skipped).toHaveLength(1); expect(r.posts[0]!.accountId).toBeNull();
  });
  it('does not assume one configured LinkedIn account owns every URL', () => {
    const r = discover([['LinkedIn Post URL'], ['https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/']], [{ id: 'li', platform: 'linkedin', kind: 'member', handles: [], matchUnknown: false, facebookInsights: {} }]);
    expect(r.posts[0]!.accountId).toBeNull(); expect(r.posts[0]!.publishedAt).toBeNull();
  });
});
describe('metrics and due dates', () => {
  it('keeps unavailable null distinct from zero', () => { expect(emptyMetrics().likes).toBeNull(); expect(Metrics.parse({ likes: 0 }).likes).toBe(0); });
  it.each([-1, NaN, Infinity, '12', 2.5])('rejects invalid metric %s', value => expect(() => Metrics.parse({ likes: value })).toThrow());
  it('has no due window before 7 days', () => expect(dueWindows(post(), new Date('2026-09-07T23:59:59Z'))).toEqual([]));
  it('opens exactly at 7 days', () => expect(dueWindows(post(), new Date('2026-09-08T00:00:00Z'))).toEqual([{ window: 7, dueAt: '2026-09-08T00:00:00.000Z', missed: false }]));
  it('marks old windows missed, not observed', () => expect(dueWindows(post(), new Date('2026-09-22T00:00:00Z')).every(w => w.missed)).toBe(true));
  it('requires known timestamp', () => expect(dueWindows(post({ publishedAt: null }), new Date())).toEqual([]));
  it('does not add likes to reactions or notes', () => { const s = snapshot({ metrics: { ...emptyMetrics(), impressions: 1000, likes: 90, reactions: 10, comments: 1, shares: 1, notes: 50 } }); expect(interactionRate(s)?.rate).toBe(0.012); });
});
function cohort(n = 10, baseline = 30) {
  const posts: Post[] = []; const snapshots = [];
  for (let i = 0; i < n + baseline; i++) { const p = post({ id: `p${i}`, strategy: { layout: i < n ? 'weak' : 'strong' } }); posts.push(p); snapshots.push(snapshot({ id: `s${i}`, postId: p.id, metrics: { ...emptyMetrics(), impressions: 1000, likes: i < n ? 1 : 98, comments: 1, shares: 1 } })); }
  return { posts, snapshots };
}
describe('evidence-qualified learning', () => {
  const at = new Date('2026-09-16T00:00:00Z');
  it('flags a weak pattern for observation without immediately pausing', () => { const d = cohort(); const f = evaluate(d.posts, d.snapshots, [], at); expect(f.find(x => x.pattern === 'weak')?.status).toBe('watch'); });
  it('does not retire from a single post', () => { const d = cohort(1); const f = evaluate(d.posts, d.snapshots, [], at); expect(f.find(x => x.pattern === 'weak')?.status).toBe('insufficient_data'); });
  it('does not count repeated review of the same observations as new evidence', () => { const d = cohort(); const first = evaluate(d.posts, d.snapshots, [], at); const second = evaluate(d.posts, d.snapshots, first, new Date('2026-09-25T00:00:00Z')); expect(second.find(x => x.pattern === 'weak')?.status).toBe('watch'); expect(second.find(x => x.pattern === 'weak')?.id).toBe(first.find(x => x.pattern === 'weak')?.id); });
  it.each(['blocked', 'missed', 'retry', 'unavailable'] as const)('excludes %s observations', status => { const d = cohort(); expect(evaluate(d.posts, d.snapshots.map(s => ({ ...s, status })), [], at)).toEqual([]); });
  it('excludes missing impression counts', () => { const d = cohort(); expect(evaluate(d.posts, d.snapshots.map(s => ({ ...s, metrics: { ...s.metrics, impressions: null } })), [], at)).toEqual([]); });
  it('does not compare paid and organic content', () => { const d = cohort(); d.posts.forEach((p, i) => p.distribution = i < 10 ? 'paid' : 'organic'); expect(evaluate(d.posts, d.snapshots, [], at).every(f => f.status === 'insufficient_data')).toBe(true); });
  it('does not compare metric sources or unknown content types', () => { const d = cohort(); d.posts.forEach(p => p.contentType = 'unknown'); expect(evaluate(d.posts, d.snapshots, [], at)).toEqual([]); });
  it('never reports missing analytics as poor content', () => { const r = createReport([post({ publishedAt: null, accountId: null })], [], [], at); expect(r.content).toContain('No evidence-qualified weak patterns'); expect(r.content).toContain('Missing publication time: 1'); });
  it('reports only metrics that were actually collected in coverage output', () => { const r = createReport([post()], [snapshot({ metrics: { ...emptyMetrics(), likes: 2 } })], [], at); expect(r.content).toContain('fields available by snapshot: likes=1'); expect(r.content).not.toContain('observations with impressions'); });
  it('runs an immediate public diagnostic without impressions or a configured account', () => {
    const posts = [
      post({ id: 'a', accountId: null, text: 'Is this market changing?\n\nEvidence.\n\nWhat would you prioritize?' }),
      post({ id: 'b', accountId: null, text: 'Market outlook for 2030\n\nEvidence.\n\nRead the report.' }),
    ];
    const snapshots = [
      snapshot({ id: 'sa', postId: 'a', window: 'late', accountId: null, metrics: { ...emptyMetrics(), reactions: 2, comments: 0 } }),
      snapshot({ id: 'sb', postId: 'b', window: 'late', accountId: null, metrics: { ...emptyMetrics(), reactions: 8, comments: 1 } }),
    ];
    const findings = evaluateTestRun(posts, snapshots, [], at);
    expect(findings.some(f => f.axis === 'opener' && f.pattern === 'question-led')).toBe(true);
    expect(findings.every(f => f.metric.startsWith('test-public-visible:'))).toBe(true);
    const diagnostics = postDiagnosticRecords(posts, snapshots, findings, at);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]!.content).toContain('DETECTED POST TYPE');
    expect(diagnostics[0]!.content).toContain('WHAT TO TEST NEXT');
    expect(diagnostics[0]!.fields['PE Post URL']).toBe(posts[0]!.url);
    const report = createReport(posts, snapshots, findings, at, 'test-run:linkedin:all', [], { testRun: true });
    expect(report.content).toContain('Day 7/Day 14 waiting was bypassed');
    expect(report.status).toBe('test_diagnostic');
  });
  it('does not repeat weak or below-baseline findings as stronger patterns', () => {
    const weak = Finding.parse({ id: 'weak', at: at.toISOString(), platform: 'linkedin', accountId: 'public-linkedin', axis: 'hook', pattern: 'short', status: 'watch', metric: 'test-public-visible:interactions', patternCount: 2, baselineCount: 3, patternRate: 1, baselineRate: 2, ratio: 0.5, intervalHigh: null, snapshotIds: ['s1'], reason: 'test', previousId: null, proposedWeight: 1, applied: false });
    const below = Finding.parse({ ...weak, id: 'below', axis: 'opener', pattern: 'statement', status: 'observe', ratio: 0.9 });
    const strong = Finding.parse({ ...weak, id: 'strong', axis: 'layout', pattern: 'paragraph', status: 'observe', ratio: 1.5 });
    const report = createReport([], [], [weak, below, strong], at, 'test-run:linkedin:all', [], { testRun: true });
    const stronger = report.content.split('STRONGER OBSERVED PATTERNS')[1]!;
    expect(stronger).toContain('layout=paragraph');
    expect(stronger).not.toContain('hook=short');
    expect(stronger).not.toContain('opener=statement');
  });
});
describe('CSV exports', () => {
  it('handles quoted commas and embedded newlines', () => expect(parseCsv('a,b\r\n"hello, friend","two\nlines"\r\n')).toEqual([['a', 'b'], ['hello, friend', 'two\nlines']]));
  it('handles escaped quotes', () => expect(parseCsv('a\n"He said ""yes"""')).toEqual([['a'], ['He said "yes"']]));
  it('rejects unterminated quote', () => expect(() => parseCsv('a\n"oops')).toThrow());
});
