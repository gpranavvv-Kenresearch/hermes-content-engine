import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { shortHash } from '../../src/utils/hash.js';
import type { SheetPickOutput } from './agents/sheet.js';
import type { RowResult, SocialPlatform } from './types.js';

export const NIGHT_PLATFORMS: readonly SocialPlatform[] = ['x', 'facebook', 'linkedin', 'tumblr'];
export type Targets = Record<SocialPlatform, number>;
export interface NightJob {
  platform: SocialPlatform;
  pick: SheetPickOutput;
  phase: 'queued' | 'generating' | 'ready' | 'done' | 'skipped';
  attempts: number;
  commitAttempts: number;
  result?: RowResult;
  textHash?: string;
  runId?: string;
  reason?: string;
  cell?: string;
}
export interface NightPlan {
  version: 1;
  id: string;
  targets: Targets;
  writeSheet: boolean;
  createdAt: number;
  deadline: number;
  updatedAt: number;
  status: 'running' | 'complete' | 'blocked' | 'incomplete';
  reason?: string;
  jobs: NightJob[];
  cursor: number;
  infrastructureFailures: number;
  cooldownUntil: number;
  exhausted: Partial<Record<SocialPlatform, boolean>>;
}
export interface NightDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  save(plan: NightPlan): Promise<void>;
  pick(platform: SocialPlatform, excluded: ReadonlySet<number>): Promise<SheetPickOutput | null>;
  generate(platform: SocialPlatform, pick: SheetPickOutput, signal: AbortSignal): Promise<{ result: RowResult; runId: string }>;
  commit(job: NightJob): Promise<string>;
  log(message: string): void;
}
export const completedCounts = (plan: NightPlan): Targets => Object.fromEntries(NIGHT_PLATFORMS.map(p => [p, plan.jobs.filter(j => j.platform === p && j.phase === 'done').length])) as Targets;

export function newNightPlan(id: string, targets: Targets, writeSheet: boolean, now: number, hours = 18): NightPlan {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid batch id.');
  if (NIGHT_PLATFORMS.some(p => !Number.isInteger(targets[p]) || targets[p] < 0 || targets[p] > 500) || Object.values(targets).every(v => v === 0)) throw new Error('Targets must be 0-500 per platform, with at least one post.');
  return { version: 1, id, targets, writeSheet, createdAt: now, deadline: now + hours * 3_600_000, updatedAt: now, status: 'running', jobs: [], cursor: 0, infrastructureFailures: 0, cooldownUntil: 0, exhausted: {} };
}

/** Unknown generation problems are quarantined, not promoted to approved posts. */
export function recoveryKind(message: string, stage: 'generation' | 'sheet' | 'pick'): 'retry' | 'blocked' | 'skip' {
  if (/Saved approved package/i.test(message)) return 'blocked';
  if (/ENOENT|could not start|SHEET_CREDENTIALS|credentials not found|missing.*column|no .*column|invalid_grant|invalid.*credential|unauthori[sz]ed|not authenticated|authentication (?:required|failed)|not logged in|token (?:expired|invalid)|expired token|login required|sign.?in required|access.denied|permission.denied|does not have permission|401|insufficient.*permission/i.test(message)) return 'blocked';
  if (/429|rate.?limit|quota|usage.?limit|credit|timed?\s*out|timeout|cancelled|ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|\b50[02348]\b|no terminal result|Hermes exited|read.back mismatch/i.test(message)) return 'retry';
  if (stage !== 'generation' && /\b403\b/.test(message)) return 'blocked';
  if (stage !== 'generation' && !/already has|no longer holds|processed|conflict|changed report|read.back mismatch/i.test(message)) return 'retry';
  return 'skip';
}

/** Every gate must have ended in proceed. An edited or partial saved draft cannot be committed. */
export function assertReady(job: NightJob): asserts job is NightJob & { result: RowResult & { text: string } } {
  const r = job.result;
  if (!r || r.status !== 'approved' || !r.text?.trim() || r.platform !== job.platform || r.rowIndex !== job.pick.rowIndex || r.url !== job.pick.url
    || job.textHash !== shortHash(r.text, 32)
    || ['evidence', 'strategy', 'draft', 'final'].some(g => r.decisions.filter(d => d.gate === g).at(-1)?.action !== 'proceed')) {
    throw new Error('Saved approved package is missing, changed or has not passed every gate.');
  }
}

/** Round-robin platforms; a content failure consumes a candidate, never the requested success count. */
export async function runNight(plan: NightPlan, deps: NightDeps): Promise<NightPlan> {
  if (plan.status === 'complete') return plan;
  plan.status = 'running';
  plan.exhausted = {};
  delete plan.reason;
  const save = async () => { plan.updatedAt = deps.now(); await deps.save(plan); };
  const stop = async (status: 'blocked' | 'incomplete', reason: string) => { plan.status = status; plan.reason = reason; await save(); return plan; };
  for (const j of plan.jobs) if (j.phase === 'generating') {
    j.phase = j.attempts >= 3 ? 'skipped' : 'queued';
    j.reason = 'Previous worker interrupted during generation; no Sheet write was attempted.';
  }
  await save();
  const handle = async (error: string, stage: 'generation' | 'sheet' | 'pick', job?: NightJob): Promise<boolean> => {
    const kind = recoveryKind(error, stage);
    if (job) job.reason = error.slice(0, 1500);
    deps.log(`${stage}: ${kind}: ${error.slice(0, 300)}`);
    if (kind === 'blocked') { await stop('blocked', error); return false; }
    if (kind === 'retry') {
      plan.infrastructureFailures++;
      // Quota waits can span a reset window, but never exceed this batch's deadline.
      const minutes = Math.min(60, 2 ** Math.min(plan.infrastructureFailures - 1, 6));
      plan.cooldownUntil = deps.now() + minutes * 60_000;
      if (job?.phase === 'generating') job.phase = 'queued';
      if (plan.infrastructureFailures >= 16) { await stop('incomplete', `Infrastructure recovery limit reached: ${error}`); return false; }
      if (job && stage === 'sheet' && job.commitAttempts >= 12) { await stop('incomplete', `Approved post retained for Sheet recovery: ${error}`); return false; }
    } else if (job) job.phase = 'skipped';
    await save();
    return true;
  };

  while (deps.now() < plan.deadline) {
    const counts = completedCounts(plan);
    if (NIGHT_PLATFORMS.every(p => counts[p] >= plan.targets[p])) { plan.status = 'complete'; await save(); return plan; }
    if (deps.now() < plan.cooldownUntil) {
      const remaining = Math.min(plan.cooldownUntil, plan.deadline) - deps.now();
      deps.log(`Recovery cooldown; ${Math.ceil(remaining / 60_000)} minute(s) remaining. Progress ${JSON.stringify(counts)}.`);
      await save(); // Intentional quota waits must keep the watchdog heartbeat fresh.
      await deps.sleep(Math.min(30_000, remaining));
      continue;
    }
    let platform: SocialPlatform | undefined;
    for (let n = 0; n < NIGHT_PLATFORMS.length; n++) {
      const p = NIGHT_PLATFORMS[plan.cursor++ % NIGHT_PLATFORMS.length]!;
      if (counts[p] < plan.targets[p] && !plan.exhausted[p]) { platform = p; break; }
    }
    if (!platform) return stop('incomplete', 'Not enough eligible Sheet rows to reach all requested counts.');
    let job = plan.jobs.find(j => j.platform === platform && ['queued', 'ready'].includes(j.phase));
    if (!job) {
      const candidates = plan.jobs.filter(j => j.platform === platform);
      if (candidates.length >= plan.targets[platform] * 5 + 10) {
        plan.exhausted[platform] = true;
        deps.log(`${platform}: candidate safety limit reached; keep completing the other platforms. Failures retained for review.`);
        await save(); continue;
      }
      try {
        const pick = await deps.pick(platform, new Set(candidates.map(j => j.pick.rowIndex)));
        if (!pick) {
          // Keep completing the other platforms; do not reduce this target.
          plan.exhausted[platform] = true;
          await save(); continue;
        }
        job = { platform, pick, phase: 'queued', attempts: 0, commitAttempts: 0 };
        plan.jobs.push(job);
        await save();
      } catch (e) { if (!await handle((e as Error).message, 'pick')) return plan; continue; }
    }
    if (job.phase === 'queued') {
      job.phase = 'generating'; job.attempts++; await save();
      deps.log(`${job.platform} row ${job.pick.rowIndex}: generating; ${counts[job.platform]}/${plan.targets[job.platform]} completed.`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(25 * 60_000, Math.max(1, plan.deadline - deps.now())));
      try {
        const made = await deps.generate(job.platform, job.pick, controller.signal);
        job.result = made.result; job.runId = made.runId;
        if (made.result.status !== 'approved') {
          if (!await handle(made.result.reason, 'generation', job)) return plan;
          continue;
        }
        job.textHash = shortHash(made.result.text ?? '', 32);
        assertReady(job);
        job.phase = 'ready';
        // Persist the complete approved text BEFORE attempting any Sheet mutation.
        await save();
      } catch (e) { if (!await handle((e as Error).message, 'generation', job)) return plan; continue; }
      finally { clearTimeout(timer); }
    }
    if (job.phase === 'ready') {
      try {
        assertReady(job);
        if (plan.writeSheet) { job.commitAttempts++; await save(); job.cell = await deps.commit(job); }
        job.phase = 'done'; delete job.reason; plan.infrastructureFailures = 0; plan.cooldownUntil = 0;
        await save();
        deps.log(`Completed ${job.platform} row ${job.pick.rowIndex}${job.cell ? ` -> ${job.cell} (read-back verified)` : ' locally'}. ${JSON.stringify(completedCounts(plan))}`);
      } catch (e) { if (!await handle((e as Error).message, 'sheet', job)) return plan; }
    }
  }
  return stop('incomplete', 'Batch time limit reached. Approved packages and remaining progress are saved; resume this batch to continue.');
}

export async function atomicSave(file: string, plan: NightPlan): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, 'w');
  try { await handle.writeFile(`${JSON.stringify(plan, null, 2)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp, file);
}

/** One local unattended writer at a time. A dead worker's lock can be reclaimed on resume. */
export async function acquireNightLock(file: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(file), { recursive: true });
  const token = `${process.pid}:${Date.now()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8'); await handle.close();
      return async () => { try { if (JSON.parse(await readFile(file, 'utf8')).token === token) await unlink(file); } catch { /* already released */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Serialize stale-lock reclamation so two restarts cannot remove each other's fresh lock.
      const reclaimFile = `${file}.reclaim`;
      let reclaim;
      try { reclaim = await open(reclaimFile, 'wx'); }
      catch { throw new Error('Overnight writer lock is being reclaimed; retry after the other worker starts.'); }
      try {
        let prior: { pid: number };
        try { prior = JSON.parse(await readFile(file, 'utf8')); }
        catch { throw new Error('Overnight writer lock is unreadable; inspect it before starting another writer.'); }
        if (!Number.isInteger(prior.pid) || prior.pid <= 0) throw new Error('Invalid overnight writer lock; inspect before restarting.');
        try { process.kill(prior.pid, 0); throw new Error('Another overnight writer is already running.'); }
        catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check; }
        await unlink(file);
      } finally { await reclaim.close(); await unlink(reclaimFile); }
    }
  }
  throw new Error('Could not acquire overnight writer lock.');
}
