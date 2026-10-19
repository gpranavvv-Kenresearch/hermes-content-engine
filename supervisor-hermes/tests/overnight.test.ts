import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shortHash } from '../../src/utils/hash.js';
import { commitApprovedJob, parseNightArgs } from '../src/overnight-cli.js';
import { acquireNightLock, assertReady, atomicSave, completedCounts, newNightPlan, recoveryKind, runNight, workerHealth, type NightDeps, type NightJob, type NightPlan, type Targets } from '../src/overnight.js';
import { GATES, type RowResult, type SocialPlatform } from '../src/types.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const targets = (extra: Partial<Targets> = {}): Targets => ({ x: 1, facebook: 0, linkedin: 0, tumblr: 0, ...extra });
const pick = (rowIndex: number) => ({ rowIndex, url: `https://www.kenresearch.com/report-${rowIndex}`, title: `Market ${rowIndex}`, keyword: 'market keyword' });
function result(platform: SocialPlatform, rowIndex: number, approved = true, reason = 'passed'): RowResult {
  return { ...pick(rowIndex), platform, status: approved ? 'approved' : 'needs_human', text: approved ? `Ken Research finds market ${rowIndex} supported.` : null, score: approved ? 0.85 : null, reason, retries: 0, regenerations: 0, written: null, noEvidence: false,
    decisions: GATES.map(gate => ({ gate, action: approved ? 'proceed' : 'stop', reason: 'test', concerns: [] })) };
}
function setup(t = targets()) {
  let now = 1_000_000; const saved: NightPlan[] = []; const generated: Array<{ platform: SocialPlatform; row: number }> = []; const committed: string[] = []; const waits: number[] = [];
  const plan = newNightPlan('test', t, true, now);
  const deps: NightDeps = {
    now: () => now,
    sleep: async ms => { waits.push(ms); now += ms; },
    save: async p => { saved.push(structuredClone(p)); },
    pick: async (_p, excluded) => pick([2, 3, 4, 5, 6, 7].find(r => !excluded.has(r)) ?? 99),
    generate: async (platform, p) => { generated.push({ platform, row: p.rowIndex }); return { result: result(platform, p.rowIndex), runId: `run-${p.rowIndex}` }; },
    commit: async job => { committed.push(`${job.platform}:${job.pick.rowIndex}`); return 'C2'; },
    log: () => {},
  };
  return { plan, deps, saved, generated, committed, waits };
}
const readyJob = (): NightJob => {
  const r = result('x', 2);
  return { platform: 'x', pick: pick(2), phase: 'ready', attempts: 1, commitAttempts: 0, result: r, textHash: shortHash(r.text!, 32) };
};

describe('overnight recovery', () => {
  it('distinguishes a slow Hermes call from a stale worker and caps one generation attempt', () => {
    const now = 3_000_000;
    const plan = newNightPlan('health', targets(), false, now - 20 * 60_000);
    plan.updatedAt = now - 20 * 60_000;
    plan.jobs = [{ ...readyJob(), phase: 'generating', startedAt: now - 20 * 60_000 }];
    expect(workerHealth(plan, { pid: 42, updatedAt: now - 30_000 }, 42, now)).toBe('healthy');
    expect(workerHealth(plan, { pid: 41, updatedAt: now - 30_000 }, 42, now)).toBe('heartbeat_stale');
    plan.jobs[0]!.startedAt = now - 36 * 60_000;
    expect(workerHealth(plan, { pid: 42, updatedAt: now - 30_000 }, 42, now)).toBe('generation_stalled');
  });
  it('persists approved text before committing and reaches each target round-robin', async () => {
    const s = setup(targets({ facebook: 2, tumblr: 1 }));
    s.deps.commit = async job => {
      expect(s.saved.at(-1)!.jobs.find(j => j.platform === job.platform && j.pick.rowIndex === job.pick.rowIndex)?.phase).toBe('ready');
      assertReady(job); return 'C2';
    };
    await runNight(s.plan, s.deps);
    expect(s.plan.status).toBe('complete');
    expect(completedCounts(s.plan)).toEqual(targets({ facebook: 2, tumblr: 1 }));
    expect(s.generated.slice(0, 3).map(j => j.platform)).toEqual(['x', 'facebook', 'tumblr']);
  });
  it('quarantines a content failure and replaces the row without lowering the target', async () => {
    const s = setup(); let calls = 0;
    s.deps.generate = async (p, item) => ({ result: result(p, item.rowIndex, ++calls !== 1, 'unsupported numerical claim'), runId: 'r' });
    await runNight(s.plan, s.deps);
    expect(s.plan.jobs.map(j => j.phase)).toEqual(['skipped', 'done']);
    expect(s.committed).toEqual(['x:3']);
  });
  it('waits through temporary model quota failure and resumes the same candidate', async () => {
    const s = setup(); let calls = 0;
    s.deps.generate = async (p, item) => ({ result: result(p, item.rowIndex, ++calls > 1, 'Hermes rate limit 429'), runId: 'r' });
    await runNight(s.plan, s.deps);
    expect(s.plan.status).toBe('complete');
    expect(s.plan.jobs).toHaveLength(1);
    expect(s.waits.reduce((a, b) => a + b, 0)).toBe(60_000);
  });
  it('retries an uncertain Sheet commit without generating a second draft', async () => {
    const s = setup(); let commits = 0;
    s.deps.commit = async () => { if (++commits === 1) throw new Error('network timeout after PUT'); return 'C2'; };
    await runNight(s.plan, s.deps);
    expect(s.generated).toHaveLength(1); expect(commits).toBe(2); expect(s.plan.status).toBe('complete');
  });
  it('resumes a ready checkpoint without another model call', async () => {
    const s = setup(); s.plan.jobs = [readyJob()];
    await runNight(s.plan, s.deps);
    expect(s.generated).toHaveLength(0); expect(s.committed).toHaveLength(1);
  });
  it('recovers an interrupted generation and never counts a partial draft', async () => {
    const s = setup(); s.plan.jobs = [{ ...readyJob(), phase: 'generating', result: undefined }];
    await runNight(s.plan, s.deps);
    expect(s.generated).toHaveLength(1); expect(completedCounts(s.plan).x).toBe(1);
  });
  it('leaves auth failures blocked without asking or writing', async () => {
    const s = setup(); s.deps.generate = async () => { throw new Error('Hermes authentication required'); };
    await runNight(s.plan, s.deps);
    expect(s.plan.status).toBe('blocked'); expect(s.committed).toHaveLength(0); expect(s.waits).toHaveLength(0);
  });
  it('finishes remaining platforms if one runs out, and reports incomplete counts honestly', async () => {
    const s = setup(targets({ tumblr: 1 })); const original = s.deps.pick;
    s.deps.pick = (p, exclude) => p === 'x' ? Promise.resolve(null) : original(p, exclude);
    await runNight(s.plan, s.deps);
    expect(s.plan.status).toBe('incomplete'); expect(completedCounts(s.plan)).toEqual({ x: 0, facebook: 0, linkedin: 0, tumblr: 1 });
  });
  it('stops at its deadline during repeated infrastructure failure and preserves progress', async () => {
    const s = setup(); s.plan.deadline = s.deps.now() + 1000;
    s.deps.generate = async () => { throw new Error('network timeout'); };
    await runNight(s.plan, s.deps);
    expect(s.plan.status).toBe('incomplete'); expect(s.plan.jobs[0]?.phase).toBe('queued');
    expect(s.saved.at(-1)?.status).toBe('incomplete');
  });
  it('rejects changed approved packages and never treats them as ready', () => {
    const job = readyJob(); job.result!.text += ' changed'; expect(() => assertReady(job)).toThrow(/changed/);
    const failed = readyJob(); failed.result!.decisions.at(-1)!.action = 'stop'; expect(() => assertReady(failed)).toThrow(/gate/);
  });
  it('does not write local-only batches', async () => {
    const s = setup(); s.plan.writeSheet = false; await runNight(s.plan, s.deps);
    expect(s.plan.status).toBe('complete'); expect(s.committed).toHaveLength(0);
  });
  it('blocks a corrupted ready checkpoint before handing anything to the Sheet', async () => {
    const s = setup(); const job = readyJob(); job.result!.text += ' edited'; s.plan.jobs.push(job);
    await runNight(s.plan, s.deps);
    expect(s.plan.status).toBe('blocked'); expect(s.committed).toHaveLength(0); expect(s.generated).toHaveLength(0);
  });
  it('atomically replaces a checkpoint and excludes a second live writer', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'night-')); dirs.push(dir);
    const file = path.join(dir, 'state.json'); const p = newNightPlan('a', targets(), false, 1000);
    await atomicSave(file, p); p.reason = 'new'; await atomicSave(file, p);
    expect(JSON.parse(await readFile(file, 'utf8')).reason).toBe('new');
    const lock = path.join(dir, 'writer.lock'); const release = await acquireNightLock(lock);
    await expect(acquireNightLock(lock)).rejects.toThrow(/already running/); await release();
    const releaseAgain = await acquireNightLock(lock); await releaseAgain();
  });
});

describe('idempotent Sheet handoff', () => {
  function api(initial = '') {
    let post = initial; let writes = 0; let failAfterPut = false;
    return {
      tab: 't', get writes() { return writes; }, set uncertain(value: boolean) { failAfterPut = value; },
      async read(range: string) { return range === '1:1' ? [['targetUrl', 'X Post', 'X Status', 'X Post URL']] : range === '2:2' ? [[pick(2).url, post, '', '']] : [[post]]; },
      async writeCell(_cell: string, text: string) { writes++; post = text; if (failAfterPut) { failAfterPut = false; throw new Error('network timeout'); } },
    };
  }
  it('recognizes a successful write after a timeout without writing twice', async () => {
    const sheet = api(); sheet.uncertain = true; const job = readyJob();
    await expect(commitApprovedJob(sheet, job)).rejects.toThrow(/timeout/);
    expect(await commitApprovedJob(sheet, job)).toBe('B2'); expect(sheet.writes).toBe(1);
  });
  it('never overwrites another post', async () => {
    const sheet = api('another post'); await expect(commitApprovedJob(sheet, readyJob())).rejects.toThrow(/conflict/); expect(sheet.writes).toBe(0);
  });
});

describe('overnight arguments and recovery policy', () => {
  it('loads the requested 240-post profile, preserves explicit counts and makes writes opt-in', () => {
    expect(parseNightArgs([])).toMatchObject({ targets: { x: 60, facebook: 75, linkedin: 45, tumblr: 60 }, writeSheet: false });
    expect(parseNightArgs(['--x', '2', '--write-sheet'])).toMatchObject({ targets: { x: 2, facebook: 0, linkedin: 0, tumblr: 0 }, writeSheet: true });
    expect(() => parseNightArgs(['--resume', '../bad'])).toThrow();
    expect(() => parseNightArgs(['--resume', 'test', '--x', '3'])).toThrow();
    expect(() => parseNightArgs(['--x', '501'])).toThrow();
  });
  it('separates temporary outages from permissions, conflicts and factual failures', () => {
    expect(recoveryKind('Hermes timed out', 'generation')).toBe('retry');
    expect(recoveryKind('No Tumblr Post column', 'pick')).toBe('blocked');
    expect(recoveryKind('SHEET_CREDENTIALS', 'sheet')).toBe('blocked');
    expect(recoveryKind('unsupported forecast claim', 'generation')).toBe('skip');
    expect(recoveryKind('Sheet conflict', 'sheet')).toBe('skip');
    expect(recoveryKind('403 quota exceeded', 'sheet')).toBe('retry');
    expect(recoveryKind('The caller does not have permission (403)', 'sheet')).toBe('blocked');
    expect(recoveryKind('Hermes token expired', 'generation')).toBe('blocked');
    expect(recoveryKind('Report returned 403 Forbidden', 'generation')).toBe('skip');
  });
});
