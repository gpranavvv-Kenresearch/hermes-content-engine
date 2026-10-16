import { metricNames, stableId, type Finding, type Post, type Snapshot, type Experiment } from './contracts.js';
import { interactionRate } from './learner.js';
import { istDate, type SheetRecord } from './sheets.js';

export function createReport(posts: Post[], snapshots: Snapshot[], findings: Finding[], at = new Date(), scope = 'all', experiments: Experiment[] = [], options: { testRun?: boolean } = {}): SheetRecord {
  const date = at.toISOString();
  const statusCounts: Record<string, number> = {};
  for (const s of snapshots) statusCounts[s.status] = (statusCounts[s.status] ?? 0) + 1;
  const registered = new Set(posts.map(p => p.id));
  const valid = snapshots.filter(s => registered.has(s.postId) && ['ok', 'partial'].includes(s.status));
  const tracked = new Set(valid.map(s => s.postId)).size;
  const missingDate = posts.filter(p => !p.publishedAt).length;
  const missingAccount = posts.filter(p => !p.accountId).length;
  const mature = snapshots.filter(s => s.window === 14 && ['ok', 'partial'].includes(s.status)).length;
  const latest = new Map<string, Finding>();
  for (const f of findings) { const k = JSON.stringify([f.platform, f.accountId, f.axis, f.pattern, f.metric]); const old = latest.get(k); if (!old || old.at < f.at) latest.set(k, f); }
  const current = [...latest.values()];
  const weak = current.filter(f => ['watch', 'reduce', 'paused'].includes(f.status)).sort((a, b) => (a.ratio ?? 1) - (b.ratio ?? 1));
  const insufficient = current.filter(f => f.status === 'insufficient_data').length;
  const best = current.filter(f => f.ratio !== null && f.ratio > 1 && !['insufficient_data', 'watch', 'reduce', 'paused'].includes(f.status)).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0)).slice(0, 5);
  const experimentLines = experiments.slice(0, 15).map(e => {
    if (options.testRun) return `${e.id}: ${e.status}; future controlled experiment proposal. The immediate public test did not validate or promote this hypothesis.`;
    const treatment = posts.filter(p => p.strategy.experimentId === e.id);
    const matureTreatment = snapshots.filter(s => treatment.some(p => p.id === s.postId) && s.window === 14 && ['ok', 'partial'].includes(s.status) && s.ageHours >= 336 && s.ageHours <= 360 && interactionRate(s));
    return `${e.id}: ${e.status}; ${treatment.length} attributed posts, ${new Set(matureTreatment.map(s => s.postId)).size} mature measurable treatment posts. Criterion: ${e.outcome} No automatic success claim or promotion.`;
  });
  const body = [
    `${options.testRun ? 'TEST-RUN DIAGNOSTIC' : 'Performance report'} | ${istDate(date)} IST | Scope: ${scope}`,
    options.testRun
      ? `Registered published posts: ${posts.length}; posts inspected immediately: ${tracked}. Day 7/Day 14 waiting was bypassed for this test.`
      : `Registered published posts: ${posts.length}; posts with collected metrics: ${tracked}; mature 14-day observations: ${mature}.`,
    `Missing publication time: ${missingDate}; posts using public mode without optional native account mapping: ${missingAccount}.`,
    `Observation states: ${Object.entries(statusCounts).map(([s, n]) => `${s}=${n}`).join(', ') || 'none collected'}.`,
    '', 'METRIC COVERAGE',
    ...(['x', 'facebook', 'linkedin', 'tumblr'] as const).map(platform => {
      const ss = valid.filter(s => s.platform === platform);
      const coverage = metricNames.map(metric => [metric, ss.filter(s => s.metrics[metric] !== null).length] as const).filter(([, count]) => count > 0).map(([metric, count]) => `${metric}=${count}`).join(', ');
      return `  - ${platform.toUpperCase()}: ${new Set(ss.map(s => s.postId)).size} tracked posts; fields available by snapshot: ${coverage || 'none'}.`;
    }),
    '', options.testRun ? 'DIAGNOSTIC WEAK PATTERNS (visible public interactions)' : 'WEAK PATTERNS (within comparable account/platform cohorts)',
    ...(weak.length ? weak.slice(0, 15).map(f => `  - ${f.platform}/${f.accountId} | ${f.axis}=${f.pattern}\n    Status: ${f.status}; sample: ${f.patternCount} pattern / ${f.baselineCount} baseline; performance ratio: ${f.ratio?.toFixed(3)}\n    Action: ${f.applied ? 'Applied' : 'Proposed only'}; evidence: ${f.id}`) : ['  - No evidence-qualified weak patterns identified.']),
    '', 'STRONGER OBSERVED PATTERNS',
    ...(best.length ? best.map(f => `  - ${f.platform}/${f.accountId} | ${f.axis}=${f.pattern}\n    Performance ratio: ${f.ratio?.toFixed(3)}; sample: ${f.patternCount}; association only.`) : ['  - Insufficient comparable performance data.']),
    '', `Insufficient-data pattern evaluations: ${insufficient}. Low engagement alone does not prove a topic is ineffective.`,
    '', 'REPLACEMENT EXPERIMENTS',
    ...(experimentLines.length ? experimentLines.map(line => `  - ${line}`) : ['  - No replacement experiments registered.']),
    options.testRun ? 'Test-run comparisons use matching visible metric fields and are diagnostic only. They do not change generation policy.' : 'Source/age/organic-paid differences are kept separate. Blocked, missed and late observations do not support mature pattern decisions.',
    'All tracking and learning records are stored separately in Algo Reports; this report summarizes the current local registry. Legacy indexing reports are a separate dataset.',
  ].join('\n');
  return { id: `report:${stableId(date.slice(0, 10), scope)}`, type: 'report', at: date, status: options.testRun ? 'test_diagnostic' : 'generated', content: body, recommendations: [missingDate ? 'Resolve missing publication timestamps.' : '', (statusCounts.blocked ?? 0) > 0 ? 'Some public pages were blocked or required login; retry later or use a dated first-party export for those posts.' : '', options.testRun ? 'Review this end-to-end test output; do not apply diagnostic findings as policy.' : 'Keep collecting 7/14-day observations; test replacement ideas before broad adoption.', weak.some(f => ['reduce', 'paused'].includes(f.status) && !f.applied) ? 'Review evidence-qualified policy candidates; changes have not been applied automatically.' : ''].filter(Boolean).join('\n'), fields: { 'PE Source': options.testRun ? 'immediate public test-run snapshots and diagnostic findings' : 'stored posts, snapshots and findings' }, payload: { generatedAt: date, testRun: Boolean(options.testRun), registeredPosts: posts.length, trackedPosts: tracked, missingDate, missingAccount, observationCounts: statusCounts, experiments: experiments.slice(0, 15).map(e => ({ id: e.id, status: e.status })), findingCounts: { current: current.length, weak: weak.length, insufficient }, findingIds: [...weak.slice(0, 15), ...best].map(f => f.id) } };
}
