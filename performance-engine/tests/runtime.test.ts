import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CollectionError, Finding, Snapshot, Post, emptyMetrics, type Adapter } from '../src/contracts.js';
import { PerformanceStore } from '../src/store.js';
import { trackPosts, importObservation } from '../src/tracker.js';
import { buildPolicy, loadPolicy, savePolicy, policyFile } from '../src/policy.js';
import { seedSources, proposeExperiments } from '../src/research.js';
import { saveGenerationHandoff, attachHandoffs } from '../src/metadata.js';
import { MemoryStore } from '../../src/store/store.js';
import { post, snapshot, account } from './helpers.js';
let temp: string;
beforeEach(async () => { temp = await mkdtemp(path.join(os.tmpdir(), 'hermes-performance-test-')); });
afterEach(async () => { if (path.dirname(temp) !== path.resolve(os.tmpdir())) throw new Error('Unsafe temp cleanup'); await rm(temp, { recursive: true, force: true }); });
const success: Adapter = { async collect() { return { metrics: { ...emptyMetrics(), impressions: 1000, likes: 10, comments: 2, shares: 1 }, source: 'test-api', scope: 'all', raw: { value: 1 }, definitions: {} }; } };
describe('recoverable tracking', () => {
  it('persists evidence and skips a completed checkpoint after restart', async () => { const store = new PerformanceStore(temp); const at = () => new Date('2026-09-08T00:00:00Z'); const a = await trackPosts(store, [post()], [account()], success, { now: at }); const b = await trackPosts(new PerformanceStore(temp), [post()], [account()], success, { now: at }); expect(a.snapshots).toHaveLength(1); expect(a.snapshots[0]!.rawRef).not.toBeNull(); expect(b.calls).toBe(0); });
  it('records missed windows without API calls', async () => { const r = await trackPosts(new PerformanceStore(temp), [post()], [account()], success, { now: () => new Date('2026-10-01T00:00:00Z') }); expect(r.calls).toBe(0); expect(r.snapshots.map(s => s.status)).toEqual(['missed', 'missed']); });
  it('labels optional current observation late rather than faking history', async () => { const r = await trackPosts(new PerformanceStore(temp), [post()], [account()], success, { now: () => new Date('2026-10-01T00:00:00Z'), includeLate: true }); expect(r.calls).toBe(1); expect(r.snapshots.find(s => s.window === 'late')?.metrics.impressions).toBe(1000); });
  it('persists cooldown and does not immediately retry', async () => { const store = new PerformanceStore(temp); const bad: Adapter = { async collect() { throw new CollectionError('retry', 'HTTP 429', 600); } }; const now = () => new Date('2026-09-08T00:00:00Z'); const r = await trackPosts(store, [post()], [account()], bad, { now }); expect(r.snapshots[0]!.nextAttemptAt).toBe('2026-09-08T00:10:00.000Z'); const second = await trackPosts(store, [post()], [account()], bad, { now }); expect(second.calls).toBe(0); });
  it('continues after one account is blocked', async () => { const bad: Adapter = { async collect(p) { if (p.accountId === 'account') throw new CollectionError('blocked', 'No access'); return success.collect(p, account()); } }; const posts = [post(), post({ id: 'p2', accountId: 'second' })]; const accounts = [account(), { ...account(), id: 'second' }]; const r = await trackPosts(new PerformanceStore(temp), posts, accounts, bad, { now: () => new Date('2026-09-08T00:00:00Z') }); expect(r.snapshots.map(s => s.status)).toEqual(['blocked', 'ok']); });
  it('records unresolved dates separately without fabricating snapshots', async () => { const r = await trackPosts(new PerformanceStore(temp), [post({ publishedAt: null })], [], success); expect(r.metadataBlocked).toHaveLength(1); expect(r.snapshots).toHaveLength(0); });
  it('collects a public observation without an account mapping', async () => { const r = await trackPosts(new PerformanceStore(temp), [post({ accountId: null })], [], success, { now: () => new Date('2026-09-08T00:00:00Z') }); expect(r.snapshots[0]!.status).toBe('ok'); expect(r.snapshots[0]!.metrics.likes).toBe(10); });
  it('prevents concurrent local writers', async () => { const store = new PerformanceStore(temp); await store.lock(async () => { await expect(new PerformanceStore(temp).lock(async () => {})).rejects.toThrow('already running'); }); });
  it('recovers a dead writer lock', async () => { await mkdir(temp, { recursive: true }); await writeFile(path.join(temp, 'writer.lock'), JSON.stringify({ pid: 2147483647, token: 'old' })); await expect(new PerformanceStore(temp).lock(async () => 'ok')).resolves.toBe('ok'); });
});
describe('dated analytics imports', () => {
  it('accepts a dated observation and preserves its real age/window', async () => { const r = await importObservation(new PerformanceStore(temp), { postUrl: 'https://x.com/ken/status/123', accountId: 'account', publishedAt: '2026-09-01T00:00:00Z', observedAt: '2026-09-15T00:00:00Z', source: 'first-party.csv', metrics: emptyMetrics(), scope: 'all' }, [account()], new Date('2026-10-01T00:00:00Z')); expect(r.window).toBe(14); expect(r.ageHours).toBe(336); });
  it('rejects future metrics', async () => { await expect(importObservation(new PerformanceStore(temp), { postUrl: 'https://x.com/ken/status/123', accountId: 'account', publishedAt: '2026-09-01T00:00:00Z', observedAt: '2027-09-15T00:00:00Z', source: 'csv', metrics: emptyMetrics(), scope: 'all' }, [account()], new Date('2026-10-01T00:00:00Z'))).rejects.toThrow('future'); });
  it('requires configured ownership mapping', async () => { await expect(importObservation(new PerformanceStore(temp), { postUrl: 'https://x.com/ken/status/123', accountId: 'wrong', publishedAt: '2026-09-01T00:00:00Z', observedAt: '2026-09-15T00:00:00Z', source: 'csv', metrics: emptyMetrics(), scope: 'all' }, [account()])).rejects.toThrow('account/platform'); });
});
describe('bounded policy application', () => {
  const at = new Date('2026-10-01T00:00:00Z');
  const finding = () => Finding.parse({ id: 'f1', at: at.toISOString(), platform: 'linkedin', accountId: 'account', axis: 'layout', pattern: 'insight-brief', status: 'reduce', metric: 'cohort', patternCount: 10, baselineCount: 30, patternRate: 0.01, baselineRate: 0.1, ratio: 0.1, intervalHigh: 0.5, snapshotIds: ['s1'], reason: 'Measured weakness', previousId: 'f0', proposedWeight: 0.5, applied: false });
  it('requires evidence-qualified actions', () => expect(() => buildPolicy([{ ...finding(), status: 'watch' }], 'linkedin', 'account', at)).toThrow('No current evidence'));
  it('does not pause across conflicting qualified cohorts', () => expect(() => buildPolicy([finding(), { ...finding(), id: 'f2', metric: 'another-cohort', ratio: 1.5, status: 'observe' }], 'linkedin', 'account', at)).toThrow('No current evidence'));
  it('rejects adding an unapproved LI/FB layout', () => expect(() => buildPolicy([{ ...finding(), pattern: 'new-unapproved-format' }], 'linkedin', 'account', at)).toThrow('approved'));
  it('loads only exact account/platform policies', async () => { const p = buildPolicy([finding()], 'linkedin', 'account', at); await savePolicy(temp, p); expect(await loadPolicy(temp, 'linkedin', 'account', at)).not.toBeNull(); expect(await loadPolicy(temp, 'linkedin', 'other', at)).toBeNull(); expect(await loadPolicy(temp, 'facebook', 'account', at)).toBeNull(); });
  it('falls back for expiry or malformed files', async () => { const p = buildPolicy([finding()], 'linkedin', 'account', at); await savePolicy(temp, p); expect(await loadPolicy(temp, 'linkedin', 'account', new Date('2027-01-01T00:00:00Z'))).toBeNull(); await writeFile(policyFile(temp, 'linkedin', 'account'), '{bad'); expect(await loadPolicy(temp, 'linkedin', 'account', at)).toBeNull(); });
});
describe('source provenance and metadata', () => {
  it('does not turn analytics-library references into content experiments', async () => { const sources = await seedSources(); const experiments = proposeExperiments(sources, []); expect(experiments).toHaveLength(1); expect(experiments[0]!.status).toBe('proposed'); });
  it('requires sample approval for new structures', async () => { const sources = await seedSources(); const content = sources.find(s => s.purpose === 'content_idea')!; const e = proposeExperiments([{ ...content, newFormat: true }], []); expect(e[0]!.status).toBe('needs_format_approval'); });
  it('attaches only an exact text/report/platform handoff match', async () => { const store = new MemoryStore(); const p = post(); const v = { layout: 'insight-brief', angle: 'growth', hookStyle: 'question', opener: 'stat-first', tone: 'analytical', personaId: 'pe-vc' } as any; await saveGenerationHandoff(store, { runId: 'run_1', platform: 'x', reportUrl: p.reportUrl, text: p.text, variant: v, at: new Date() }); const result = await attachHandoffs([{ ...p, textHash: (await import('../src/contracts.js')).hash(p.text) }], store); expect(result[0]!.runId).toBe('run_1'); const changed = await attachHandoffs([p], store); expect(changed[0]!.runId).toBeUndefined(); });
});
