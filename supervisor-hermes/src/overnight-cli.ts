import 'dotenv/config';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFiles } from '../../src/llm/env.js';
import { createSheetsApi, pickNextRow, readPostSnapshot, writeGeneratedPost, type SheetsApi } from '../../src/sheets/social-sheet.js';
import { JsonFileStore } from '../../src/store/store.js';
import { pickRowAgent } from './agents/sheet.js';
import { generateOvernightPost } from './overnight-runtime.js';
import { acquireNightLock, assertReady, atomicSave, completedCounts, NIGHT_PLATFORMS, newNightPlan, recoveryKind, runNight, workerHealth, type NightJob, type NightPlan, type Targets, type WorkerHeartbeat } from './overnight.js';

export interface NightArgs {
  targets: Targets; writeSheet: boolean; hours: number; id?: string; resume?: string;
  extendHours?: number; check: boolean; status: boolean; worker: boolean;
}
export function parseNightArgs(argv: string[]): NightArgs {
  const values = new Map<string, string>(); const flags = new Set<string>();
  const flagNames = new Set(['write-sheet', 'check', 'status', 'worker']);
  const valueNames = new Set(['x', 'fb', 'li', 'tumblr', 'hours', 'id', 'resume', 'extend-hours']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]?.replace(/^--/, '') ?? '';
    if (!argv[i]?.startsWith('--') || (!flagNames.has(key) && !valueNames.has(key))) throw new Error(`Unknown overnight argument: ${argv[i]}`);
    if (flagNames.has(key)) flags.add(key);
    else { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`--${key} requires a value.`); values.set(key, v); }
  }
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const n = Number(values.get(key) ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${key} must be ${min}-${max}.`);
    return n;
  };
  const explicit = ['x', 'fb', 'li', 'tumblr'].some(p => values.has(p));
  const targets: Targets = { x: integer('x', explicit ? 0 : 60, 0, 500), facebook: integer('fb', explicit ? 0 : 75, 0, 500), linkedin: integer('li', explicit ? 0 : 45, 0, 500), tumblr: integer('tumblr', explicit ? 0 : 60, 0, 500) };
  const id = values.get('id'); const resume = values.get('resume');
  if (id && resume) throw new Error('Use --id or --resume, not both.');
  for (const v of [id, resume]) if (v && !/^[a-zA-Z0-9_-]{1,80}$/.test(v)) throw new Error('Batch id must contain only letters, digits, _ or -.');
  if (!resume && Object.values(targets).every(n => n === 0)) throw new Error('At least one target must be positive.');
  if (resume && explicit) throw new Error('Resume preserves saved targets; omit count flags.');
  return { targets, writeSheet: flags.has('write-sheet'), hours: integer('hours', 18, 1, 72), ...(id ? { id } : {}), ...(resume ? { resume } : {}), ...(values.has('extend-hours') ? { extendHours: integer('extend-hours', 18, 1, 72) } : {}), check: flags.has('check'), status: flags.has('status'), worker: flags.has('worker') };
}

export async function commitApprovedJob(api: SheetsApi, job: NightJob): Promise<string> {
  assertReady(job);
  const snapshot = await readPostSnapshot(api, job.platform, job.pick.rowIndex);
  if (snapshot.url.replace(/\/+$/, '') !== job.pick.url.replace(/\/+$/, '')) throw new Error(`Row ${job.pick.rowIndex} changed report; approved package retained, not written.`);
  // A successful PUT followed by a crash/timeout is counted once after this read, even if the publisher has since posted it.
  if (snapshot.text === job.result.text) return snapshot.cell;
  if (snapshot.text.trim()) throw new Error(`Sheet conflict at ${snapshot.cell}: another text already exists; not overwritten.`);
  if (snapshot.status || snapshot.postUrl) throw new Error(`Row ${job.pick.rowIndex} already processed; not written.`);
  const written = await writeGeneratedPost(api, job.platform, job.pick, job.result.text);
  if (!written.verified) throw new Error(`Sheet read-back mismatch at ${written.cell}.`);
  return written.cell;
}

const root = () => path.resolve('output/supervisor-hermes/overnight');
const batchFile = (id: string) => path.join(root(), `${id}.json`);
const heartbeatFile = (id: string) => path.join(root(), `${id}.heartbeat.json`);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function readHeartbeat(id: string): Promise<WorkerHeartbeat | null> {
  try {
    const beat = JSON.parse(await readFile(heartbeatFile(id), 'utf8')) as WorkerHeartbeat;
    return Number.isInteger(beat.pid) && Number.isFinite(beat.updatedAt) ? beat : null;
  } catch { return null; }
}

async function loadPlan(id: string): Promise<NightPlan> {
  const plan = JSON.parse(await readFile(batchFile(id), 'utf8')) as NightPlan;
  if (plan.version !== 1 || plan.id !== id || !Array.isArray(plan.jobs) || typeof plan.writeSheet !== 'boolean'
    || !Number.isFinite(plan.deadline) || !Number.isFinite(plan.createdAt) || !Number.isFinite(plan.updatedAt) || !Number.isFinite(plan.cooldownUntil)
    || plan.deadline < plan.createdAt || !Number.isInteger(plan.cursor) || plan.cursor < 0 || !Number.isInteger(plan.infrastructureFailures) || plan.infrastructureFailures < 0
    || !['running', 'complete', 'blocked', 'incomplete'].includes(plan.status)) throw new Error('Invalid batch checkpoint; inspect it before resuming.');
  newNightPlan(plan.id, plan.targets, plan.writeSheet, plan.createdAt);
  for (const job of plan.jobs) {
    if (!NIGHT_PLATFORMS.includes(job.platform) || !job.pick?.url || !Number.isInteger(job.pick.rowIndex) || job.pick.rowIndex < 2
      || !Number.isInteger(job.attempts) || job.attempts < 0 || !Number.isInteger(job.commitAttempts) || job.commitAttempts < 0
      || !['queued', 'generating', 'ready', 'done', 'skipped'].includes(job.phase)) throw new Error('Invalid job in batch checkpoint.');
    if (job.phase === 'ready' || job.phase === 'done') assertReady(job);
  }
  return plan;
}

async function preflight(args: NightArgs): Promise<void> {
  const api = createSheetsApi(process.env, { write: false });
  const rows = await api.read('A:AZ');
  for (const platform of NIGHT_PLATFORMS.filter(p => args.targets[p] > 0)) {
    const exclude = new Set<number>(); let count = 0;
    const first = pickNextRow(rows, platform, undefined, { skipGenerated: true });
    // Also prove that the Post column exists. No Sheet mutation occurs.
    await readPostSnapshot(api, platform, first?.rowIndex ?? 2);
    while (count < args.targets[platform]) { const p = pickNextRow(rows, platform, undefined, { skipGenerated: true, exclude }); if (!p) break; exclude.add(p.rowIndex); count++; }
    console.log(`${platform}: ${count >= args.targets[platform] ? 'at least ' : ''}${count} eligible rows; target ${args.targets[platform]}.`);
    if (count < args.targets[platform]) throw new Error(`${platform}: not enough pending rows for this target.`);
  }
  const command = process.env.HCE_HERMES_BIN ?? 'hermes';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, ['--version'], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Hermes preflight timed out.')); }, 45_000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Hermes executable preflight failed.')); });
  });
  console.log(`Preflight passed. Mode: ${args.writeSheet ? 'approved posts to Sheet' : 'local only'}. Targets ${JSON.stringify(args.targets)}. No posts generated or written.`);
}

async function worker(args: NightArgs, id: string): Promise<number> {
  const release = await acquireNightLock(path.join(root(), 'writer.lock'));
  try {
    let plan: NightPlan;
    if (args.resume) {
      plan = await loadPlan(id);
      if (args.writeSheet && !plan.writeSheet) throw new Error('A local-only batch cannot be switched to Sheet writes on resume.');
      if (args.extendHours) plan.deadline = Date.now() + args.extendHours * 3_600_000;
    } else {
      if (existsSync(batchFile(id))) throw new Error(`Batch ${id} exists; use --resume ${id}.`);
      plan = newNightPlan(id, args.targets, args.writeSheet, Date.now(), args.hours);
      await atomicSave(batchFile(id), plan);
    }
    const api = createSheetsApi(process.env, { write: plan.writeSheet });
    const store = new JsonFileStore(path.resolve('output/store'));
    const logFile = path.join(root(), `${id}.log`);
    let logQueue: Promise<unknown> = Promise.resolve();
    const log = (message: string) => {
      const line = `[${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })}] ${message}`;
      console.log(line);
      logQueue = logQueue.then(() => appendFile(logFile, `${line}\n`, 'utf8'));
    };
    // A separate, tiny heartbeat keeps a long Hermes call from looking like a dead checkpoint.
    // The checkpoint still records only durable job transitions and is never rewritten by this timer.
    let beatQueue: Promise<void> = Promise.resolve();
    const beat = (): Promise<void> => {
      const write = beatQueue.then(async () => {
        const file = heartbeatFile(id);
        const temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify({ pid: process.pid, updatedAt: Date.now() } satisfies WorkerHeartbeat), 'utf8');
        await rename(temp, file);
      });
      beatQueue = write.catch(() => {});
      return write;
    };
    await beat();
    const pulse = setInterval(() => { void beat().catch(error => { clearInterval(pulse); console.error(`Worker heartbeat failed: ${(error as Error).message}`); }); }, 30_000);
    try {
      await runNight(plan, {
        now: Date.now, sleep: pause, save: p => atomicSave(batchFile(id), p), log,
        async pick(platform, excluded) {
          const rows = await api.read('A:AZ');
          const known = await store.list<{ url: string; platform: string }>('social-skipped');
          const urls = new Set(known.map(r => r.value).filter(r => r.platform === platform).map(r => r.url.trim().replace(/\/+$/, '').toLowerCase()));
          const skip = new Set(excluded);
          rows.forEach((row, i) => { if (i > 0 && row.some(cell => urls.has(cell.trim().replace(/\/+$/, '').toLowerCase()))) skip.add(i + 1); });
          return pickRowAgent(rows, platform, skip)?.output ?? null;
        },
        generate: (platform, pick, signal) => generateOvernightPost(platform, pick, api, signal),
        commit: job => commitApprovedJob(api, job),
      });
    } finally { clearInterval(pulse); await beatQueue; await logQueue; }
    console.log(JSON.stringify({ batch: id, status: plan.status, completed: completedCounts(plan), targets: plan.targets, reason: plan.reason, checkpoint: batchFile(id) }, null, 2));
    return plan.status === 'complete' ? 0 : plan.status === 'blocked' ? 3 : 2;
  } finally { await release(); }
}

/** Parent process supervises unexpected worker crashes; intentional incomplete/blocked exits do not loop. */
async function watchdog(args: NightArgs, original: string[], id: string): Promise<number> {
  await mkdir(root(), { recursive: true });
  const script = fileURLToPath(import.meta.url);
  for (let attempt = 0; attempt < 6; attempt++) {
    const childArgs = attempt === 0 ? original : ['--resume', id];
    if (!args.resume && attempt === 0 && !args.id) childArgs.push('--id', id);
    let exitDetail = 'unknown';
    const code = await new Promise<number>(resolve => {
      const child = spawn(process.execPath, [...process.execArgv, script, ...childArgs, '--worker'], { windowsHide: true, stdio: 'inherit' });
      let cancelled = false;
      let settled = false;
      let suspected: 'heartbeat_stale' | 'generation_stalled' | null = null;
      let checking = false;
      let stopping = false;
      const killTree = () => {
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => child.kill());
        } else child.kill();
      };
      const stop = () => { cancelled = true; if (!stopping) { stopping = true; killTree(); } };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      // A row has a 25-minute soft cancellation. A separate worker pulse distinguishes
      // slow model calls from a stuck process; a 35-minute row cap is a final backstop.
      const health = setInterval(() => {
        if (checking || stopping) return;
        checking = true;
        void Promise.all([readFile(batchFile(id), 'utf8'), readHeartbeat(id)]).then(([raw, beat]) => {
          const condition = workerHealth(JSON.parse(raw) as NightPlan, beat, child.pid ?? -1, Date.now());
          if (condition === 'healthy') { suspected = null; return; }
          if (suspected !== condition) { suspected = condition; console.log(`Worker ${condition}; rechecking in 30s before restart.`); return; }
          stopping = true;
          console.log(`Worker ${condition}; restarting from checkpoint.`);
          killTree();
        }).catch(() => { /* checkpoint may be being created */ }).finally(() => { checking = false; });
      }, 30_000);
      const finish = (n: number) => { if (settled) return; settled = true; clearInterval(health); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); resolve(cancelled ? 130 : n); };
      child.once('error', error => { exitDetail = `spawn error: ${error.message}`; finish(1); });
      child.once('exit', (n, signal) => { exitDetail = signal ? `signal ${signal}` : `exit ${n ?? 1}`; finish(n ?? 1); });
    });
    if ([0, 2, 3, 130].includes(code)) return code;
    if (attempt === 5) {
      if (existsSync(batchFile(id))) {
        const plan = await loadPlan(id); plan.status = 'incomplete'; plan.reason = 'Worker crash recovery limit reached; saved jobs can be resumed.'; plan.updatedAt = Date.now(); await atomicSave(batchFile(id), plan);
      }
      return 1;
    }
    if (!existsSync(batchFile(id))) return 1; // configuration failure before a checkpoint is not a restartable job
    const delay = Math.min(120, 15 * 2 ** attempt);
    console.log(`Worker exited unexpectedly (${exitDetail}). Checkpoint retained; restart ${attempt + 1}/5 in ${delay}s. Batch ${id}.`);
    await pause(delay * 1000);
  }
  return 1;
}

export async function mainNight(argv: string[]): Promise<number> {
  loadEnvFiles();
  const args = parseNightArgs(argv);
  if (args.status) {
    if (!args.resume) throw new Error('Pass --status --resume <batch-id>.');
    const p = await loadPlan(args.resume);
    const lock = await readFile(path.join(root(), 'writer.lock'), 'utf8').then(raw => JSON.parse(raw) as { pid: number }).catch(() => null);
    let workerAlive = false;
    if (lock?.pid) { try { process.kill(lock.pid, 0); workerAlive = true; } catch { /* stale lock */ } }
    const health = p.status === 'running' ? workerHealth(p, await readHeartbeat(args.resume), lock?.pid ?? -1, Date.now()) : 'not_applicable';
    const deadlineExpired = Date.now() >= p.deadline;
    const observedStatus = p.status === 'running' && !workerAlive ? 'interrupted' : p.status;
    console.log(JSON.stringify({ batch: p.id, status: p.status, observedStatus, targets: p.targets, completed: completedCounts(p), ready: p.jobs.filter(j => j.phase === 'ready').length, skipped: p.jobs.filter(j => j.phase === 'skipped').length, reason: p.reason, deadline: new Date(p.deadline).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }), deadlineExpired, workerAlive, health }, null, 2));
    return 0;
  }
  if (args.check) { await preflight(args); return 0; }
  const id = args.resume ?? args.id ?? `overnight_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  console.log(`Batch ${id}. Check progress: npm run hermes:overnight -- --status --resume ${id}`);
  return args.worker ? worker(args, id) : watchdog(args, [...argv], id);
}

if (path.resolve(process.argv[1] ?? '').toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  mainNight(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch((e: unknown) => { const message = (e as Error).message; console.error(message); process.exitCode = recoveryKind(message, 'pick') === 'blocked' || /writer.*lock|another overnight writer/i.test(message) ? 3 : 1; });
}
