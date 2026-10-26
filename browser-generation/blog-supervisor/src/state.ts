import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const BLOG_ROOT = path.resolve('output/blog-supervisor');
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Atomic JSON write that survives the Windows EPERM/EBUSY race (antivirus or indexer holding the temp file). */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const body = JSON.stringify(value, null, 2);
  let lastError: unknown;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const tmp = `${file}.${process.pid}.${attempt}.tmp`;
    try {
      await writeFile(tmp, body, 'utf8');
      await rename(tmp, file);
      return;
    } catch (error) {
      lastError = error;
      await rm(tmp, { force: true }).catch(() => {});
      await pause(150 * attempt);
    }
  }
  throw lastError;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export type RowStatus = 'written' | 'skipped' | 'needs_human' | 'parked';

export interface RowState {
  url: string;
  title: string;
  status: RowStatus;
  attempts: number;
  lastReason: string;
  structure?: string;
  updatedAt: number;
  /** A skipped row is not picked again before this time. */
  nextEligibleAt: number;
  /** Consecutive transient failures (ChatGPT rate limit, stalled generation, network). */
  transient?: number;
}

export interface BlogState {
  rows: Record<string, RowState>;
}

/** Hours before a failed row is tried again: 6, 12, 24. After 3 failed attempts the row is parked until a human asks. */
const RETRY_HOURS = [6, 12, 24];
export const MAX_ATTEMPTS = RETRY_HOURS.length;
const TRANSIENT_LIMIT = 4;
const TRANSIENT_COOLDOWN_MS = 20 * 60_000;

export class BlogStateStore {
  constructor(readonly root: string = BLOG_ROOT) {}
  private get stateFile() { return path.join(this.root, 'state.json'); }
  private draftFile(row: number) { return path.join(this.root, 'drafts', `${row}.json`); }

  async load(): Promise<BlogState> {
    return readJson<BlogState>(this.stateFile, { rows: {} });
  }

  async record(row: number, info: { url: string; title: string; status: RowStatus; reason: string; structure?: string; transient?: boolean }, now = Date.now()): Promise<RowState> {
    const state = await this.load();
    const previous = state.rows[String(row)];
    if (info.transient && previous?.url === info.url && (previous.transient ?? 0) < TRANSIENT_LIMIT - 1) {
      const t: RowState = {
        ...previous, url: info.url, title: info.title, status: 'skipped', lastReason: info.reason.slice(0, 600),
        updatedAt: now, nextEligibleAt: now + TRANSIENT_COOLDOWN_MS, transient: (previous.transient ?? 0) + 1,
      };
      state.rows[String(row)] = t;
      await atomicWriteJson(this.stateFile, state);
      return t;
    }
    if (info.transient && !previous) {
      const t: RowState = { url: info.url, title: info.title, status: 'skipped', attempts: 0, lastReason: info.reason.slice(0, 600), updatedAt: now, nextEligibleAt: now + TRANSIENT_COOLDOWN_MS, transient: 1 };
      state.rows[String(row)] = t;
      await atomicWriteJson(this.stateFile, state);
      return t;
    }
    const failed = info.status === 'skipped' || info.status === 'needs_human';
    const attempts = failed ? (previous?.url === info.url ? previous.attempts : 0) + 1 : previous?.attempts ?? 0;
    const parked = failed && attempts >= MAX_ATTEMPTS;
    const next: RowState = {
      url: info.url,
      title: info.title,
      status: parked ? 'parked' : info.status,
      attempts,
      lastReason: info.reason.slice(0, 600),
      ...(info.structure ? { structure: info.structure } : {}),
      updatedAt: now,
      nextEligibleAt: failed && !parked ? now + RETRY_HOURS[Math.min(attempts - 1, RETRY_HOURS.length - 1)]! * 3_600_000 : parked ? Number.MAX_SAFE_INTEGER : 0,
    };
    state.rows[String(row)] = next;
    await atomicWriteJson(this.stateFile, state);
    return next;
  }

  /** Rows the runner may try now: not written, not parked, and past their cool-down. A changed URL resets the row. */
  isEligible(state: BlogState, row: number, url: string, now = Date.now()): boolean {
    const s = state.rows[String(row)];
    if (!s || s.url !== url) return true;
    if (s.status === 'written' || s.status === 'parked') return false;
    return now >= s.nextEligibleAt;
  }

  async unpark(): Promise<number> {
    const state = await this.load();
    let n = 0;
    for (const s of Object.values(state.rows)) {
      if (s.status === 'parked') { s.status = 'skipped'; s.attempts = 0; s.nextEligibleAt = 0; n++; }
    }
    await atomicWriteJson(this.stateFile, state);
    return n;
  }

  /** The approved article is saved before images and the Sheet write, so a crash there never costs a 15-minute regeneration. */
  async saveApprovedDraft(row: number, draft: unknown): Promise<void> {
    await atomicWriteJson(this.draftFile(row), draft);
  }
  async loadApprovedDraft<T>(row: number): Promise<T | null> {
    return readJson<T | null>(this.draftFile(row), null);
  }
  async clearApprovedDraft(row: number): Promise<void> {
    await rm(this.draftFile(row), { force: true });
  }

  async heartbeat(info: Record<string, unknown>): Promise<void> {
    await atomicWriteJson(path.join(this.root, 'heartbeat.json'), { pid: process.pid, updatedAt: Date.now(), ...info });
  }
  async readHeartbeat(): Promise<Record<string, unknown> | null> {
    return readJson<Record<string, unknown> | null>(path.join(this.root, 'heartbeat.json'), null);
  }
}

/** One blog engine at a time. A crashed process leaves a pid file whose process no longer exists, which is taken over. */
export function acquireBlogLock(root: string = BLOG_ROOT): (() => void) | null {
  const file = path.join(root, 'engine.lock');
  mkdirSync(root, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return () => { try { unlinkSync(file); } catch { /* already gone */ } };
    } catch {
      let owner = 0;
      try { owner = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }).pid ?? 0; } catch { /* unreadable lock is stale */ }
      let alive = false;
      if (owner) { try { process.kill(owner, 0); alive = true; } catch { alive = false; } }
      if (alive && owner !== process.pid) return null;
      try { unlinkSync(file); } catch { /* raced with another process */ }
    }
  }
  return null;
}

export class BlogLedger {
  readonly dir: string;
  private readonly file: string;
  constructor(root: string, readonly runId: string, private readonly onEvent?: (line: string) => void) {
    this.dir = path.join(root, 'runs', runId);
    this.file = path.join(this.dir, 'events.jsonl');
  }
  async append(type: string, data: Record<string, unknown>): Promise<void> {
    const event = { at: new Date().toISOString(), type, ...data };
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file, `${JSON.stringify(event)}\n`, 'utf8');
    try {
      this.onEvent?.(`  ${new Date().toLocaleTimeString('en-GB')}  ${type}${data.gate ? ` [${String(data.gate)}]` : ''}: ${String(data.summary ?? data.action ?? data.reason ?? '').slice(0, 220)}`);
    } catch { /* progress output must never break a run */ }
  }
  async saveText(name: string, text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, name), text, 'utf8');
  }
}
