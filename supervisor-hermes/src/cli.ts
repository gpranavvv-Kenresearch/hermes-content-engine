import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/index.js';
import { checkClaims, loadKeysFromEnv, TavilySearchProvider } from '../../src/evidence/index.js';
import { loadEnvFiles } from '../../src/llm/index.js';
import { createSheetsApi, readSocialSheet } from '../../src/sheets/social-sheet.js';
import { HermesProvider } from '../../src/social/hermes-provider.js';
import { loadLessons, loadRecentRepairTraces } from '../../src/social/learning.js';
import { storeRoot } from '../../src/social/runner.js';
import { JsonFileStore } from '../../src/store/store.js';
import { shortHash } from '../../src/utils/hash.js';
import type { AgentDeps } from './agents/deps.js';
import { pickFixedRowAgent, pickRowAgent } from './agents/sheet.js';
import { createHermesAsk } from './hermes-client.js';
import { excludeSkippedRows, runBatch } from './batch.js';
import { Ledger } from './ledger.js';
import { RunLimits, countedProvider } from './limits.js';
import { processRow } from './orchestrator.js';
import { Supervisor } from './supervisor.js';
import { formatTimeline } from './timeline.js';
import type { RowResult, SocialPlatform } from './types.js';

export interface RunArgs {
  platform: SocialPlatform;
  count: number;
  keyword?: string;
  row?: number;
  writeSheet: boolean;
  supplementary: 'off' | 'ken-gov' | 'all';
  maxRegenerations: number;
  maxRetries: number;
  maxHermesCalls: number;
  retrySkipped: boolean;
}

const FLAGS = new Set(['write-sheet', 'background', 'retry-skipped']);
const MAX_SKIPS = 10;

function parsePlatform(value: string | undefined): SocialPlatform {
  const v = (value ?? '').toLowerCase();
  if (v === 'x' || v === 'twitter') return 'x';
  if (v === 'fb' || v === 'facebook') return 'facebook';
  if (v === 'li' || v === 'linkedin') return 'linkedin';
  if (v === 'tumblr') return 'tumblr';
  throw new Error('Pass --platform x, fb, li or tumblr.');
}

function intIn(name: string, value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be ${min}-${max}.`);
  return n;
}

export function parseRunArgs(argv: string[]): RunArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = argv[i + 1];
    if (FLAGS.has(key) || next === undefined || next.startsWith('--')) flags.add(key);
    else {
      values.set(key, next);
      i++;
    }
  }
  const count = intIn('count', values.get('count'), 1, 1, 25);
  const row = values.has('row') ? intIn('row', values.get('row'), 2, 2, 1_000_000) : undefined;
  if (row !== undefined && count > 1) throw new Error('--count cannot be combined with --row.');
  const keyword = values.get('keyword')?.trim();
  return {
    platform: parsePlatform(values.get('platform')),
    count,
    ...(keyword ? { keyword } : {}),
    ...(row !== undefined ? { row } : {}),
    writeSheet: flags.has('write-sheet'),
    supplementary: flags.has('background') ? 'all' : 'ken-gov',
    maxRegenerations: intIn('max-regenerations', values.get('max-regenerations'), 2, 0, 5),
    maxRetries: intIn('max-retries', values.get('max-retries'), 3, 0, 6),
    maxHermesCalls: intIn('max-calls', values.get('max-calls'), 20, 1, 100),
    retrySkipped: flags.has('retry-skipped'),
  };
}

const outputRoot = (): string => path.resolve('output', 'supervisor-hermes');

function printResult(r: RowResult, runId: string): void {
  console.log(`${r.platform}: ${r.status} | ${r.reason}`);
  console.log(`row ${r.rowIndex} | keyword: ${r.keyword} | score: ${r.score === null ? 'n/a' : Math.round(r.score * 100) + '/100'} | regenerations: ${r.regenerations} | retries: ${r.retries}`);
  console.log(`decisions: ${r.decisions.map((d) => `${d.gate}:${d.action}`).join(' > ') || 'none'}`);
  if (r.written) console.log(`sheet: ${r.written.cell} read back ${r.written.verified ? 'and confirmed' : 'with a MISMATCH'}`);
  console.log(`run: ${runId}  (npm run hermes:status -- ${runId})`);
  if (r.text) console.log(`\n${r.text}\n`);
}

async function run(args: RunArgs): Promise<void> {
  loadEnvFiles();
  const config = loadConfig();
  const store = new JsonFileStore(storeRoot());
  const role = readFileSync(new URL('../roles/supervisor.md', import.meta.url), 'utf8');
  const ask = createHermesAsk();
  const searchProvider = loadKeysFromEnv('TAVILY_API_KEY').length > 0 ? new TavilySearchProvider() : undefined;
  const sheets = createSheetsApi(process.env, { write: args.writeSheet });
  const rows = await readSocialSheet();
  const exclude = new Set<number>();
  // Rows an earlier run found unusable (same collection and shape as `hce:next`), unless --retry-skipped or a fixed --row.
  if (args.row === undefined && !args.retrySkipped) {
    const remembered = await store.list<{ url: string; platform: SocialPlatform }>('social-skipped');
    const urls = remembered.map((r) => r.value).filter((r) => r.platform === args.platform).map((r) => r.url);
    for (const index of excludeSkippedRows(rows, urls)) exclude.add(index);
  }
  let counter = 0;

  const summary = await runBatch({
    count: args.count,
    maxFailures: args.count === 1 ? 1 : 3,
    maxSkips: MAX_SKIPS,
    ...(args.row !== undefined ? { fixedRow: true } : {}),
    next: () => {
      const picked = args.row !== undefined ? pickFixedRowAgent(rows, args.platform, args.row, args.keyword) : pickRowAgent(rows, args.platform, exclude, args.keyword);
      if (!picked) {
        console.log(`No pending ${args.platform} row found.`);
        return null;
      }
      exclude.add(picked.output.rowIndex);
      return { rowIndex: picked.output.rowIndex, picked };
    },
    onSkip: async ({ picked }, result) => {
      await store.put('social-skipped', `skip_${shortHash(`${args.platform}:${picked.output.url}`, 16)}`, { url: picked.output.url, platform: args.platform, at: new Date().toISOString(), reason: result.reason });
    },
    process: async ({ picked }) => {
      const pick = picked.output;
      counter++;
      const runId = `run_${shortHash(`${pick.url}|${Date.now()}`, 12)}`;
    const limits = new RunLimits({ maxHermesCalls: args.maxHermesCalls, maxRegenerations: args.maxRegenerations, maxRetries: args.maxRetries });
    const ledger = new Ledger(outputRoot(), runId, (e) => console.log(`  ${formatTimeline([e])}`));
    const hermes = new HermesProvider({ maxCalls: 100, lessons: await loadLessons(store, args.platform), recentTraces: await loadRecentRepairTraces(store, args.platform) });
    const deps: AgentDeps = {
      config,
      store,
      claimChecker: checkClaims,
      writer: countedProvider(hermes, limits),
      hermes,
      sheets,
      ...(searchProvider ? { searchProvider } : {}),
      limits,
      now: () => new Date(),
    };
      console.log(`\n[row ${counter}] sheet row ${pick.rowIndex}: ${pick.title}`);
      await ledger.append({ type: 'agent', agent: 'sheet', data: { summary: picked.summary, concerns: picked.concerns } });
      const result = await processRow(
        { pick, platform: args.platform, writeSheet: args.writeSheet, supplementary: args.supplementary },
        { deps, supervisor: new Supervisor(ask, role, limits), ledger, runId },
      );
      await writeFile(path.join(ledger.dir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
      printResult(result, runId);
      return result;
    },
  });
  console.log(`\nSummary: ${summary.approved}/${args.count} approved, ${summary.skipped} skipped (no usable evidence), ${summary.failures} failed in a row.`);
  if (summary.approved < args.count) process.exitCode = summary.failures > 0 ? 2 : 3;
}

async function status(runId: string | undefined): Promise<void> {
  if (!runId) throw new Error('Pass a run id: npm run hermes:status -- <runId>');
  console.log(formatTimeline(await Ledger.read(outputRoot(), runId)));
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'run') return run(parseRunArgs(rest));
  if (command === 'status') return status(rest[0]);
  console.log('Usage:\n  npm run hermes:run -- --platform x|li|fb|tumblr [--count N] [--keyword ...] [--row R] [--write-sheet] [--background]\n  npm run hermes:status -- <runId>');
}

const isMain = ((): boolean => {
  try {
    return path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1] ?? '').toLowerCase();
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
