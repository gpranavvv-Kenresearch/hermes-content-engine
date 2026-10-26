import { getContentPoolRowsNeedingGeneration } from '../../src/sheets/sheets.js';
import { createRealDeps } from './defaults.js';
import { processBlogRow, type BlogRowInput } from './orchestrator.js';
import { acquireBlogLock, BLOG_ROOT, BlogLedger, BlogStateStore } from './state.js';
import { BlogLimits, BlogSupervisor, createBlogHermesAsk, loadBlogRole } from './supervisor.js';
import { HermesUnavailableError } from './types.js';

export interface RunnerOptions {
  /** Keep going forever (continuous mode). Otherwise stop when nothing is pending or `limit` rows were handled. */
  loop: boolean;
  limit?: number;
  /** Only this Sheet row. */
  row?: number;
  withImage: boolean;
  /** v1.3 (default), rotate, random or an architecture id. */
  structureMode: string;
  blogAccount?: string;
  imageAccount?: string;
  imagePromptChoice?: '1' | '2';
  rowDeadlineMs?: number;
  idleSeconds?: number;
  hermesRetrySeconds?: number;
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Failures that say nothing about the article: ChatGPT limits, stalls, dropped connections, closed windows. */
export function isTransientError(message: string): boolean {
  if (/RESEARCH_BLOCKED/.test(message)) return false;
  return /STALLED|EVIDENCE_FETCH_TRANSIENT|SEND_NOT_CONFIRMED|PREAMBLE_ONLY|LINK_VALIDATION_BLOCKED|REVISION_NOT_ARTICLE|timed out|timeout|ECONN|ETIMEDOUT|EAI_AGAIN|rate.?limit|too many|network|navigation|Target (page|closed)|browser has been closed|has been closed|No HTML content/i.test(message);
}

async function waitWithHeartbeat(store: BlogStateStore, seconds: number, phase: string, extra: Record<string, unknown> = {}): Promise<void> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await store.heartbeat({ phase, ...extra }).catch(() => {});
    await pause(Math.min(30_000, Math.max(1_000, until - Date.now())));
  }
}

export async function runBlogEngine(opts: RunnerOptions): Promise<{ written: number; skipped: number }> {
  const release = acquireBlogLock();
  if (!release) {
    console.log('Blog engine is already running; no duplicate started.');
    return { written: 0, skipped: 0 };
  }
  const store = new BlogStateStore();
  const idleSeconds = opts.idleSeconds ?? 600;
  const hermesRetrySeconds = opts.hermesRetrySeconds ?? 300;
  const rowDeadlineMs = opts.rowDeadlineMs ?? 90 * 60_000;
  let written = 0;
  let skipped = 0;
  let handled = 0;

  try {
    for (;;) {
      if (!opts.loop && opts.limit !== undefined && handled >= opts.limit) break;

      const pendingAll = await getContentPoolRowsNeedingGeneration(60, 'newLogic');
      const state = await store.load();
      const row = pendingAll
        .filter((r) => (opts.row === undefined || r.rowIndex === opts.row) && store.isEligible(state, r.rowIndex, r.targetUrl))
        .at(0);

      if (!row) {
        if (!opts.loop) break;
        await waitWithHeartbeat(store, idleSeconds, 'idle', { message: 'No eligible rows (Target URL set, Blog Content empty); waiting.' });
        continue;
      }

      const input: BlogRowInput = { rowIndex: row.rowIndex, title: row.title || row.targetUrl, targetUrl: row.targetUrl };
      const runId = `blog_${input.rowIndex}_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
      const ledger = new BlogLedger(BLOG_ROOT, runId, (line) => console.log(line));
      await store.heartbeat({ phase: 'row', row: input.rowIndex, title: input.title, runId });
      console.log(`\n[BLOG] Row ${input.rowIndex}: "${input.title}" (${runId})`);

      const limits = new BlogLimits();
      const supervisor = new BlogSupervisor(createBlogHermesAsk(), loadBlogRole(), limits);
      const deps = {
        supervisor, limits, ledger, store,
        ...createRealDeps({
          withImage: opts.withImage, structureMode: opts.structureMode, ledger,
          ...(opts.blogAccount ? { blogAccount: opts.blogAccount } : {}),
          ...(opts.imageAccount ? { imageAccount: opts.imageAccount } : {}),
          ...(opts.imagePromptChoice ? { imagePromptChoice: opts.imagePromptChoice } : {}),
        }),
      };

      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          processBlogRow(input, deps),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`ROW_DEADLINE: exceeded ${Math.round(rowDeadlineMs / 60000)} minutes`)), rowDeadlineMs); }),
        ]);
        await ledger.append('row-result', { summary: `${result.status}: ${result.reason}`, ...result });
        await store.record(input.rowIndex, { url: input.targetUrl, title: input.title, status: result.status, reason: result.reason, structure: result.structure });
        console.log(`[BLOG] Row ${input.rowIndex} ${result.status}: ${result.reason}`);
        if (result.status === 'written') written++; else skipped++;
        handled++;
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        if (error instanceof HermesUnavailableError) {
          console.warn(`[BLOG] Hermes unavailable (${message}); waiting ${hermesRetrySeconds}s and retrying the same row.`);
          await ledger.append('hermes-unavailable', { summary: message });
          await waitWithHeartbeat(store, hermesRetrySeconds, 'hermes-unavailable', { row: input.rowIndex, message });
          continue;
        }
        const transient = isTransientError(message);
        await ledger.append('row-error', { summary: message, transient });
        await store.record(input.rowIndex, { url: input.targetUrl, title: input.title, status: 'skipped', reason: message, transient });
        console.warn(`[BLOG] Row ${input.rowIndex} failed${transient ? ' (transient, will retry soon)' : ''}: ${message}`);
        skipped++;
        handled++;
        // A stuck browser cannot be cancelled from here; a fresh process is the clean way to reset it. The wrapper restarts us.
        if (/^ROW_DEADLINE/.test(message)) {
          await store.heartbeat({ phase: 'restarting', message });
          release();
          process.exit(2);
        }
        // Give ChatGPT a moment after a failure so one bad window cannot spin.
        await pause(30_000);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  } finally {
    release();
  }
  return { written, skipped };
}
