import { Experiment, Source, stableId, type Platform } from './contracts.js';
import { PerformanceStore } from './store.js';

export async function changeExperiment(store: PerformanceStore, id: string, action: 'start' | 'pause' | 'complete', accountId: string, platform: Platform, at = new Date()): Promise<Experiment> {
  const e = await store.get('experiments', id, Experiment); if (!e) throw new Error('Experiment not found');
  if (e.platform !== 'all' && e.platform !== platform) throw new Error('Experiment platform mismatch');
  if (e.accountId && e.accountId !== accountId) throw new Error('Experiment account mismatch');
  if (action === 'start') {
    const source = await store.get('sources', e.sourceId, Source);
    if (!source || source.purpose !== 'content_idea' || source.newFormat || e.status === 'needs_format_approval') throw new Error('Experiment needs a reviewed existing-format source; new structures require sample approval.');
    const active = (await store.list('experiments', Experiment)).filter(x => x.status === 'testing' && x.accountId === accountId && x.platform === platform && x.id !== id);
    if (active.length) throw new Error('An experiment is already testing on this account/platform; avoid overlapping interventions.');
    if (e.status === 'complete') throw new Error('Create a new hypothesis/version rather than restarting a completed experiment.');
    e.status = 'testing'; e.platform = platform; e.accountId = accountId; e.startsAt = at.toISOString(); e.endsAt = new Date(at.getTime() + 42 * 86400000).toISOString();
  } else { if (e.status !== 'testing') throw new Error('Only a testing experiment can be paused or completed.'); e.status = action === 'pause' ? 'paused' : 'complete'; e.endsAt = at.toISOString(); }
  await store.put('experiments', e.id, e); return e;
}
export async function selectExperiment(root: string, platform: Platform, accountId: string | undefined, itemId: string, at = new Date()): Promise<Experiment | null> {
  if (!accountId) return null;
  try {
    const experiments = await new PerformanceStore(root).list('experiments', Experiment);
    const active = experiments.filter(e => e.status === 'testing' && e.platform === platform && e.accountId === accountId && e.startsAt && e.endsAt && Date.parse(e.startsAt) <= at.getTime() && Date.parse(e.endsAt) > at.getTime());
    if (active.length !== 1) return null;
    const e = active[0]!;
    const bucket = parseInt(stableId(e.id, platform, accountId, itemId).slice(0, 8), 16) / 4294967296;
    return bucket < e.allocation ? e : null;
  } catch { return null; }
}
