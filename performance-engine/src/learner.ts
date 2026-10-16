import { Finding, stableId, thresholds, type Post, type Snapshot, type Thresholds } from './contracts.js';

interface Datum { post: Post; snapshot: Snapshot; rate: number; signature: string; }
type Axis = Finding['axis'];
const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
export function interactionRate(s: Snapshot, minImpressions = 100): { rate: number; signature: string } | null {
  const m = s.metrics;
  const reaction = m.reactions ?? m.likes;
  if (m.impressions === null || m.impressions < minImpressions || reaction === null || m.comments === null || m.shares === null) return null;
  const value = reaction + m.comments + m.shares;
  return { rate: value / m.impressions, signature: `${s.source}|${s.scope}|${m.reactions === null ? 'likes' : 'reactions'}+comments+shares/impressions` };
}
function ratioUpper(a: number[], b: number[], seed: string): number {
  let state = parseInt(stableId(seed).slice(0, 8), 16) || 1;
  const rng = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const ratios: number[] = [];
  for (let round = 0; round < 1000; round++) {
    let x = 0, y = 0;
    for (let i = 0; i < a.length; i++) x += a[Math.floor(rng() * a.length)]!;
    for (let i = 0; i < b.length; i++) y += b[Math.floor(rng() * b.length)]!;
    const baseline = y / b.length;
    ratios.push(baseline > 0 ? (x / a.length) / baseline : Number.MAX_VALUE);
  }
  ratios.sort((x, y) => x - y);
  return ratios[Math.floor(ratios.length * 0.975)]!;
}
export function evaluate(posts: Post[], snapshots: Snapshot[], previous: Finding[], at = new Date(), config: Thresholds = thresholds.parse({})): Finding[] {
  const byId = new Map(posts.map(p => [p.id, p]));
  const latest = new Map<string, Snapshot>();
  for (const s of snapshots) {
    if (s.window !== 14 || !['ok', 'partial'].includes(s.status) || s.ageHours < 336 || s.ageHours > 336 + config.graceHours || Date.parse(s.observedAt) > at.getTime()) continue;
    const old = latest.get(s.postId); if (!old || s.observedAt > old.observedAt) latest.set(s.postId, s);
  }
  const data: Datum[] = [];
  for (const s of latest.values()) {
    const p = byId.get(s.postId); const r = interactionRate(s, config.minImpressions);
    if (!p || !p.publishedAt || Math.abs((Date.parse(s.observedAt) - Date.parse(p.publishedAt)) / 3600000 - s.ageHours) > 0.01 || !p.accountId || p.accountId !== s.accountId || p.contentType === 'unknown' || p.distribution === 'unknown' || !r) continue;
    data.push({ post: p, snapshot: s, ...r });
  }
  const axes = ['layout', 'angle', 'hook', 'opener', 'tone', 'topic', 'closing'] as const;
  const keys = new Map<string, { platform: Post['platform']; accountId: string; axis: typeof axes[number]; pattern: string; cohort: string }>();
  for (const d of data) for (const axis of axes) {
    const pattern = d.post.strategy[axis]; if (!pattern) continue;
    const cohort = JSON.stringify([d.post.platform, d.post.accountId, d.post.contentType, d.post.distribution, d.signature]);
    keys.set(JSON.stringify([cohort, axis, pattern]), { platform: d.post.platform, accountId: d.post.accountId!, axis, pattern, cohort });
  }
  const results: Finding[] = [];
  for (const [key, group] of keys) {
    const cohort = data.filter(d => JSON.stringify([d.post.platform, d.post.accountId, d.post.contentType, d.post.distribution, d.signature]) === group.cohort);
    const a = cohort.filter(d => d.post.strategy[group.axis] === group.pattern);
    const b = cohort.filter(d => d.post.strategy[group.axis] && d.post.strategy[group.axis] !== group.pattern);
    const ids = [...a, ...b].map(d => d.snapshot.id).sort();
    const id = stableId(key, JSON.stringify(ids), JSON.stringify(config));
    const exact = previous.find(p => p.id === id); if (exact) { results.push(exact); continue; }
    const prior = previous.filter(f => f.platform === group.platform && f.accountId === group.accountId && f.axis === group.axis && f.pattern === group.pattern && f.metric === group.cohort && Date.parse(f.at) < at.getTime()).sort((x, y) => y.at.localeCompare(x.at))[0];
    const enough = a.length >= config.minPatternPosts && b.length >= config.minBaselinePosts;
    const ar = a.length ? mean(a.map(d => d.rate)) : null; const br = b.length ? mean(b.map(d => d.rate)) : null;
    const ratio = ar !== null && br !== null && br > 0 ? ar / br : null;
    const intervalHigh = enough && ratio !== null ? ratioUpper(a.map(d => d.rate), b.map(d => d.rate), id) : null;
    const weak = enough && ratio !== null && ratio <= config.weakRatio && intervalHigh !== null && intervalHigh < 1;
    const isFresh = (d: Datum) => prior && !prior.snapshotIds.includes(d.snapshot.id) && Date.parse(d.snapshot.observedAt) > Date.parse(prior.at);
    const newSamples = prior ? [...a, ...b].filter(isFresh).length : 0;
    const freshReview = prior ? at.getTime() - Date.parse(prior.at) >= 7 * 86400000 && newSamples >= 3 && a.some(isFresh) : false;
    let status: Finding['status'] = !enough || ratio === null ? 'insufficient_data' : 'observe';
    if (weak) status = prior && freshReview ? prior.status === 'watch' ? 'reduce' : ['reduce', 'paused'].includes(prior.status) ? 'paused' : 'watch' : prior && ['watch', 'reduce', 'paused'].includes(prior.status) ? prior.status : 'watch';
    else if (enough && prior && ['paused', 'reduce'].includes(prior.status)) status = 'retest';
    const reason = !enough ? `Not enough comparable mature posts: need ${config.minPatternPosts} pattern and ${config.minBaselinePosts} baseline; have ${a.length}/${b.length}.` : ratio === null ? 'Baseline interaction rate is zero or unavailable; no relative underperformance claim.' : `${(ratio * 100).toFixed(1)}% of comparable baseline; bootstrap upper ratio ${intervalHigh?.toFixed(3) ?? 'unknown'}. ${weak ? 'Repeated underperformance candidate' : 'No evidence-qualified weak-pattern pause'}. ${prior ? `${newSamples} newly matured observations; ${freshReview ? 'fresh' : 'not a fresh'} weekly review.` : 'First evaluation.'} Association, not proof of causation.`;
    results.push(Finding.parse({ id, at: at.toISOString(), ...group, metric: group.cohort, patternCount: a.length, baselineCount: b.length, patternRate: ar, baselineRate: br, ratio, intervalHigh: intervalHigh === Number.MAX_VALUE ? null : intervalHigh, snapshotIds: ids, reason, previousId: prior?.id ?? null, status, proposedWeight: status === 'paused' ? 0 : status === 'reduce' ? 0.5 : 1, applied: false }));
  }
  return results;
}

export function diagnosticPatterns(post: Post): Partial<Record<Axis, string>> {
  const text = post.text.trim();
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const first = lines[0] ?? '';
  const contentLines = lines.filter(line => !/^https?:\/\//i.test(line) && !/^(?:#[\p{L}\p{N}_-]+\s*)+$/u.test(line));
  const last = contentLines.at(-1) ?? '';
  const numbered = lines.some(line => /^\d+[.)]\s+/.test(line));
  const bulleted = lines.some(line => /^[-*•▪]\s+/.test(line));
  const inferred: Partial<Record<Axis, string>> = {
    layout: numbered ? 'numbered-list' : bulleted ? 'bullet-list' : 'paragraph-led',
    opener: first.includes('?') ? 'question-led' : /(?:\bUSD\b|[$€£₹]|\d|%)/i.test(first) ? 'stat-led' : 'statement-led',
    hook: first.length <= 180 ? 'concise-hook' : 'extended-hook',
    closing: last.endsWith('?') ? 'discussion-question' : /\b(?:read|explore|report|download|contact)\b/i.test(last) ? 'report-cta' : 'statement-close',
  };
  for (const axis of ['layout', 'angle', 'hook', 'opener', 'tone', 'topic', 'closing'] as const) if (post.strategy[axis]) inferred[axis] = post.strategy[axis];
  return inferred;
}

export function publicVisibleScore(snapshot: Snapshot): { score: number; signature: string } | null {
  const metrics = snapshot.metrics;
  const fields: Array<[string, number]> = [];
  const reaction = metrics.reactions ?? metrics.likes;
  // LinkedIn may expose the same counter as LikeAction JSON-LD or a visible Reactions label.
  // Normalize the name so equivalent public counters remain comparable without summing both.
  if (reaction !== null) fields.push(['interactions', reaction]);
  for (const name of ['comments', 'shares', 'quotes'] as const) if (metrics[name] !== null) fields.push([name, metrics[name]!]);
  if (!fields.length) return null;
  return { score: fields.reduce((sum, [, value]) => sum + value, 0), signature: fields.map(([name]) => name).join('+') };
}

/** Immediate public-data diagnostic used only by the explicit CLI test mode. */
export function evaluateTestRun(posts: Post[], snapshots: Snapshot[], previous: Finding[], at = new Date()): Finding[] {
  const byId = new Map(posts.map(post => [post.id, post]));
  const latest = new Map<string, Snapshot>();
  for (const snapshot of snapshots) {
    if (!['ok', 'partial'].includes(snapshot.status) || Date.parse(snapshot.observedAt) > at.getTime()) continue;
    const old = latest.get(snapshot.postId);
    if (!old || old.observedAt < snapshot.observedAt) latest.set(snapshot.postId, snapshot);
  }
  const data = [...latest.values()].flatMap(snapshot => {
    const post = byId.get(snapshot.postId); const visible = publicVisibleScore(snapshot);
    return post && visible ? [{ post, snapshot, ...visible, patterns: diagnosticPatterns(post), accountId: post.accountId ?? `public-${post.platform}` }] : [];
  });
  const results: Finding[] = [];
  for (const axis of ['layout', 'angle', 'hook', 'opener', 'tone', 'topic', 'closing'] as const) {
    const groups = new Map<string, typeof data>();
    for (const datum of data) {
      const pattern = datum.patterns[axis]; if (!pattern) continue;
      const key = JSON.stringify([datum.post.platform, datum.accountId, datum.signature, pattern]);
      groups.set(key, [...(groups.get(key) ?? []), datum]);
    }
    for (const [key, patternData] of groups) {
      const seed = patternData[0]!; const pattern = seed.patterns[axis]!;
      const baseline = data.filter(datum => datum.post.platform === seed.post.platform && datum.accountId === seed.accountId && datum.signature === seed.signature && datum.patterns[axis] && datum.patterns[axis] !== pattern);
      if (!baseline.length) continue;
      const patternMean = mean(patternData.map(datum => datum.score));
      const baselineMean = mean(baseline.map(datum => datum.score));
      const ratio = baselineMean > 0 ? patternMean / baselineMean : null;
      const enoughForWatch = patternData.length >= 2 && baseline.length >= 2;
      const status: Finding['status'] = enoughForWatch && ratio !== null && ratio <= 0.8 ? 'watch' : 'observe';
      const snapshotIds = [...patternData, ...baseline].map(datum => datum.snapshot.id).sort();
      const id = stableId('test-run', key, JSON.stringify(snapshotIds));
      const exact = previous.find(finding => finding.id === id);
      if (exact) { results.push(exact); continue; }
      results.push(Finding.parse({
        id, at: at.toISOString(), platform: seed.post.platform, accountId: seed.accountId, axis, pattern, status,
        metric: `test-public-visible:${seed.signature}`, patternCount: patternData.length, baselineCount: baseline.length,
        patternRate: patternMean, baselineRate: baselineMean, ratio, intervalHigh: null, snapshotIds,
        reason: `Immediate test diagnostic using comparable ${seed.signature} fields. Pattern mean ${patternMean.toFixed(2)} visible interactions versus ${baselineMean.toFixed(2)} for other ${axis} patterns. Counts are not normalized by reach; this test result cannot prove content quality.`,
        previousId: null, proposedWeight: 1, applied: false,
      }));
    }
  }
  return results;
}
