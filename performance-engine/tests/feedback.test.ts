import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../../src/store/store.js';
import { VariationHistory, sampleVariant, mulberry32 } from '../../src/strategy/variation.js';
import { loadConfig } from '../../src/config/index.js';
import { PerformanceStore } from '../src/store.js';
import { changeExperiment, selectExperiment } from '../src/experiments.js';
import { seedSources, proposeExperiments } from '../src/research.js';
import { stableId, Finding, Post, Snapshot, emptyMetrics } from '../src/contracts.js';
import { evaluate } from '../src/learner.js';
import { redactEvidence } from '../src/tracker.js';
import { post, snapshot } from './helpers.js';
let temp: string;
beforeEach(async () => { temp = await mkdtemp(path.join(os.tmpdir(), 'hermes-performance-test-')); });
afterEach(async () => { if (path.dirname(temp) !== path.resolve(os.tmpdir())) throw new Error('Unsafe temp cleanup'); await rm(temp, { recursive: true, force: true }); });
describe('generator feedback', () => {
  it('pauses only an existing approved layout and leaves the rest available', async () => {
    const history = await new VariationHistory(new MemoryStore()).load(); const config = loadConfig();
    for (let i = 0; i < 40; i++) { const v = sampleVariant({ campaign: { id: 'authority-insights' }, itemId: `i${i}`, personaId: 'pe-vc', platform: 'linkedin', history, rng: mulberry32(i), config, layouts: ['insight-brief', 'short-narrative'], performanceWeights: { layout: { 'insight-brief': 0 } } }); expect(v.layout).toBe('short-narrative'); await history.record(v, 'linkedin'); }
  });
  it('reduces measured-weak layout frequency across distinct items', async () => {
    const history = await new VariationHistory(new MemoryStore()).load(); const config = loadConfig(); const counts = { weak: 0, strong: 0 };
    for (let i = 0; i < 90; i++) { const v = sampleVariant({ campaign: { id: 'authority-insights' }, itemId: `i${i}`, personaId: 'pe-vc', platform: 'linkedin', history, rng: mulberry32(i), config, layouts: ['insight-brief', 'short-narrative'], performanceWeights: { layout: { 'insight-brief': 0.5 } } }); counts[v.layout === 'insight-brief' ? 'weak' : 'strong']++; await history.record(v, 'linkedin'); }
    expect(counts.weak).toBeLessThan(counts.strong * 0.75);
  });
  it('falls back to supported formats if every eligible one has zero weight', async () => { const history = await new VariationHistory(new MemoryStore()).load(); const v = sampleVariant({ campaign: { id: 'authority-insights' }, itemId: 'i', personaId: 'pe-vc', platform: 'facebook', history, rng: mulberry32(1), config: loadConfig(), layouts: ['insight-brief'], performanceWeights: { layout: { 'insight-brief': 0 } } }); expect(v.layout).toBe('insight-brief'); });
});
describe('bounded replacement experiments', () => {
  it('requires a source and samples new technique on at most one active test per account', async () => {
    const store = new PerformanceStore(temp); const sources = await seedSources(); const s = sources.find(s => s.purpose === 'content_idea')!;
    await store.put('sources', stableId(s.url, s.revision ?? ''), s);
    const e = proposeExperiments([s], [])[0]!; await store.put('experiments', e.id, e);
    const at = new Date('2026-10-16T00:00:00Z'); await changeExperiment(store, e.id, 'start', 'account', 'linkedin', at);
    let treatments = 0;
    for (let i = 0; i < 150; i++) if (await selectExperiment(temp, 'linkedin', 'account', `item${i}`, at)) treatments++;
    expect(treatments).toBeGreaterThan(10); expect(treatments).toBeLessThan(50);
    expect(await selectExperiment(temp, 'linkedin', 'wrong-account', 'item1', at)).toBeNull();
    expect(await selectExperiment(temp, 'linkedin', 'account', 'item1', new Date('2027-01-01T00:00:00Z'))).toBeNull();
    await changeExperiment(store, e.id, 'pause', 'account', 'linkedin', at);
    expect(await selectExperiment(temp, 'linkedin', 'account', 'item1', at)).toBeNull();
  });
  it('does not activate new structures from research alone', async () => {
    const store = new PerformanceStore(temp); const sources = await seedSources(); const s = { ...sources.find(s => s.purpose === 'content_idea')!, newFormat: true };
    await store.put('sources', stableId(s.url, s.revision ?? ''), s); const e = proposeExperiments([s], [])[0]!; await store.put('experiments', e.id, e);
    await expect(changeExperiment(store, e.id, 'start', 'account', 'linkedin')).rejects.toThrow('sample approval');
  });
});
describe('fresh-cohort checks and source hygiene', () => {
  function cohort(n: number) { const posts: Post[] = []; const snapshots: Snapshot[] = []; for (let i = 0; i < n + 30; i++) { const weak = i < n; const p = post({ id: `p${weak ? 'w' : 'b'}${weak ? i : i - n}`, strategy: { layout: weak ? 'weak' : 'strong' } }); posts.push(p); snapshots.push(snapshot({ id: `s${p.id}`, postId: p.id, metrics: { ...emptyMetrics(), impressions: 1000, likes: weak ? 1 : 90, comments: 1, shares: 1 } })); } return { posts, snapshots }; }
  it('requires newly matured evidence and separate weekly reviews to reduce then pause', () => {
    const a = cohort(10); const first = evaluate(a.posts, a.snapshots, [], new Date('2026-09-16T00:00:00Z'));
    const b = cohort(13); for (let i = 10; i < 13; i++) { b.posts[i]!.publishedAt = '2026-09-09T00:00:00Z'; b.snapshots[i]!.observedAt = '2026-09-23T00:00:00Z'; } const second = evaluate(b.posts, b.snapshots, first, new Date('2026-09-24T00:00:00Z'));
    expect(second.find(f => f.pattern === 'weak')!.status).toBe('reduce');
    const c = cohort(16); for (let i = 13; i < 16; i++) { c.posts[i]!.publishedAt = '2026-09-17T00:00:00Z'; c.snapshots[i]!.observedAt = '2026-10-01T00:00:00Z'; } const third = evaluate(c.posts, c.snapshots, [...first, ...second], new Date('2026-10-02T00:00:00Z'));
    expect(third.find(f => f.pattern === 'weak')!.status).toBe('paused');
  });
  it('removes API tokens in response paging links before evidence persistence', () => { const safe = redactEvidence({ access_token: 'secret', paging: { next: 'https://graph.facebook.com/?access_token=secret&limit=1' }, data: { count: 7 } }); expect(JSON.stringify(safe)).not.toContain('secret'); expect((safe as any).data.count).toBe(7); });
});
