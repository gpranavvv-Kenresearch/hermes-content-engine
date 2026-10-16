import 'dotenv/config';
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadEnvFiles } from '../llm/env.js';
import { loadConfig } from '../config/index.js';
import { pickNextRow, readSocialSheet, createSheetsApi } from '../sheets/social-sheet.js';
import { JsonFileStore } from '../store/store.js';
import { VariationHistory } from '../strategy/variation.js';
import { shortHash } from '../utils/hash.js';
import { choosePrimaryKeyword, runSocialJob, storeRoot, type BrainChoice, type SocialPlatform } from './runner.js';
import { loadLessons } from './learning.js';

type Args = { command: string; values: Map<string, string>; flags: Set<string> };

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) { values.set(key, next); i++; }
    else flags.add(key);
  }
  return { command, values, flags };
}

function required(args: Args, key: string): string {
  const value = args.values.get(key)?.trim();
  if (!value) throw new Error(`Pass --${key} <value>.`);
  return value;
}

function platform(value: string): SocialPlatform | 'both' {
  const name = value.toLowerCase();
  if (name === 'fb' || name === 'facebook') return 'facebook';
  if (name === 'li' || name === 'linkedin') return 'linkedin';
  if (name === 'both') return 'both';
  throw new Error('Use --platform fb, li or both.');
}

function brain(value: string | undefined): BrainChoice {
  if (value === undefined || value === 'hermes') return 'hermes';
  if (value === 'ollama' || value === 'chain') return value;
  throw new Error('Use --brain hermes, ollama or chain.');
}

function titleFromSheet(title: string): string {
  return title.replace(/\b(?:Market Share|Market Size|Companies|Trends|Forecast|Outlook|Analysis|Report)\b.*$/i, '').replace(/\s+/g, ' ').trim() || title.trim();
}

function keywordFromRow(rows: string[][], rowIndex: number): string | undefined {
  const headers = rows[0]?.map((s) => s.trim().toLowerCase()) ?? [];
  const index = ['primary keyword', 'seo keyword', 'seoKeywords', 'keyword', 'keywords'].map((name) => headers.indexOf(name.toLowerCase())).find((i) => i >= 0);
  return index === undefined ? undefined : rows[rowIndex - 1]?.[index]?.split(/[;,]/)[0]?.trim();
}

function printResult(result: Awaited<ReturnType<typeof runSocialJob>>): void {
  console.log(`${result.platform}: ${result.status} | ${result.reason}`);
  console.log(`keyword: ${result.keyword} | score: ${result.score === null ? 'n/a' : Math.round(result.score * 100) + '/100'} | attempts: ${result.attempts}`);
  console.log(`variant: ${result.variation ? JSON.stringify({ persona: result.variation.personaId, layout: result.variation.layout, hook: result.variation.hookStyle, tone: result.variation.tone, opener: result.variation.opener }) : 'none'}`);
  console.log(`artifact: ${result.artifact}`);
  if (result.sheet) console.log(`sheet: ${result.sheet.cell} read back and confirmed`);
  if (result.text) console.log(`\n${result.text}\n`);
}

async function doctor(args: Args): Promise<void> {
  const config = loadConfig();
  const env = loadEnvFiles();
  const hermes = spawnSync(process.env.HCE_HERMES_BIN ?? 'hermes', ['--version'], { windowsHide: true, timeout: 15_000, encoding: 'utf8' });
  const localEnv = path.resolve('.env');
  const sourceEnv = process.env.CE_ENV_FILE;
  const credentials = process.env.CE_GOOGLE_SA_FILE;
  console.log(`project: ${process.cwd()}`);
  console.log(`config: ${config.version} | local .env: ${existsSync(localEnv) ? 'present' : 'missing'}`);
  console.log(`API source .env: ${sourceEnv && existsSync(sourceEnv) ? 'available' : 'missing'} | loaded: ${env.loaded.length > 0 ? 'yes' : 'no'}`);
  console.log(`Google service account: ${credentials && existsSync(credentials) ? 'available' : 'missing'}`);
  console.log(`Hermes executable: ${hermes.status === 0 ? 'available' : 'missing or not on PATH'}`);
  console.log(`Ollama model preference: ${process.env.CE_OLLAMA_MODEL?.trim() || 'auto-select first installed model'}`);
  console.log(`method packs: ${existsSync('config/techniques') ? readdirSync('config/techniques').filter((name) => name.endsWith('.json')).length : 0}`);
  if (args.flags.has('check-sheet')) {
    const headings = await createSheetsApi(process.env, { write: false }).read('1:1');
    console.log(`Sheet read: OK; ${headings[0]?.length ?? 0} columns in ${process.env.CE_SHEET_TAB || 'Social Media'}`);
  }
}

async function draft(args: Args): Promise<void> {
  const url = required(args, 'url');
  const title = required(args, 'title');
  const platforms = platform(args.values.get('platform') ?? 'both');
  const choice = brain(args.values.get('brain'));
  const keyword = choosePrimaryKeyword(title, args.values.get('keyword'));
  let evidence: Awaited<ReturnType<typeof runSocialJob>>['evidence'] | undefined;
  for (const p of platforms === 'both' ? (['facebook', 'linkedin'] as const) : [platforms]) {
    const result = await runSocialJob({ url, title, keyword, platform: p, brain: choice, ...(evidence ? { evidence } : {}), allowNeutralBackground: args.flags.has('background') });
    evidence = result.evidence;
    printResult(result);
    if (result.status !== 'approved') process.exitCode = 2;
  }
}

async function next(args: Args): Promise<void> {
  const p = platform(required(args, 'platform'));
  if (p === 'both') throw new Error('next uses one Sheet platform at a time. Run next once for fb and once for li.');
  const choice = brain(args.values.get('brain'));
  const rowValue = args.values.get('row');
  const requestedRow = rowValue === undefined ? undefined : Number(rowValue);
  if (requestedRow !== undefined && (!Number.isInteger(requestedRow) || requestedRow < 2)) throw new Error('--row must be a 1-based data row number.');
  const maxRows = Number(args.values.get('max-rows') ?? '5');
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 25) throw new Error('--max-rows must be 1–25.');
  const rows = await readSocialSheet();
  const store = new JsonFileStore(storeRoot());
  const remembered = await store.list<{ url: string; platform: SocialPlatform }>('social-skipped');
  const skipUrls = new Set(remembered.map((r) => r.value).filter((r) => r.platform === p).map((r) => r.url.replace(/\/+$/, '').toLowerCase()));
  const exclude = new Set<number>();
  if (!requestedRow && !args.flags.has('retry-skipped')) {
    rows.forEach((row, index) => { if (row.some((cell) => skipUrls.has(cell.trim().replace(/\/+$/, '').toLowerCase()))) exclude.add(index + 1); });
  }
  const count = Number(args.values.get('count') ?? '1');
  if (!Number.isInteger(count) || count < 1 || count > 25) throw new Error('--count must be 1–25.');
  if (requestedRow && count > 1) throw new Error('--count cannot be combined with --row.');
  // One row failing is normal in a batch; three in a row means something systemic (login, quota, evidence), so stop.
  const maxFailures = count === 1 ? 1 : 3;
  const approved: Array<{ row: number; title: string; score: number | null; written: boolean }> = [];
  let skipped = 0;
  let failures = 0;
  while (approved.length < count && skipped < maxRows && failures < maxFailures) {
    const pick = pickNextRow(rows, p, requestedRow, { skipGenerated: !requestedRow, exclude });
    if (!pick) { console.log(`No pending ${p} row found.`); break; }
    const title = titleFromSheet(pick.title);
    const keyword = choosePrimaryKeyword(title, args.values.get('keyword') ?? keywordFromRow(rows, pick.rowIndex));
    console.log(`\n[${approved.length + 1}/${count}] Sheet row ${pick.rowIndex}: ${title}`);
    // Whatever the outcome, this row is not picked again in this run (a local draft leaves the Post cell empty).
    exclude.add(pick.rowIndex);
    const result = await runSocialJob({ url: pick.url, title, keyword, platform: p, brain: choice, sheetRow: pick.rowIndex, writeSheet: args.flags.has('write-sheet'), allowNeutralBackground: args.flags.has('background') });
    printResult(result);
    if (result.status === 'approved') {
      approved.push({ row: pick.rowIndex, title, score: result.score, written: result.sheet !== null });
      failures = 0;
      continue;
    }
    if (result.reason.includes('NO_VERIFIED_FACTS') || result.reason.includes('NO_VERIFIED_FIGURE')) {
      await store.put('social-skipped', `skip_${shortHash(`${p}:${pick.url}`, 16)}`, { url: pick.url, platform: p, at: new Date().toISOString(), reason: result.reason });
      skipped++;
    } else {
      failures++;
    }
    if (requestedRow) break;
  }
  if (count > 1 || approved.length === 0) {
    console.log(`\nSummary: ${approved.length}/${count} approved, ${skipped} skipped (no verified facts), ${failures} failed.`);
    for (const a of approved) console.log(`  row ${a.row} | ${a.score === null ? 'n/a' : Math.round(a.score * 100) + '/100'} | ${a.written ? 'written to Sheet' : 'local only'} | ${a.title}`);
  }
  if (approved.length < count) process.exitCode = failures > 0 ? 2 : 3;
}

async function history(args: Args): Promise<void> {
  const store = new JsonFileStore(storeRoot());
  const p = platform(args.values.get('platform') ?? 'facebook');
  if (p === 'both') throw new Error('history uses one platform.');
  const lessons = await loadLessons(store, p);
  const variants = (await new VariationHistory(store).load()).all().filter((record) => record.platform === p);
  console.log(`lessons for ${p}: ${lessons.length}`);
  for (const lesson of lessons) console.log(`${lesson.status} ${lesson.failureCode}: ${lesson.procedure} (${lesson.successfulRuns.length} success run(s))`);
  console.log(`variation records for ${p}: ${variants.length}`);
  for (const record of variants.slice(-8)) console.log(`#${record.seq} ${record.at} ${JSON.stringify({ layout: record.variant.layout, hook: record.variant.hookStyle, tone: record.variant.tone, opener: record.variant.opener })}`);
}

function help(): void {
  console.log(`Hermes Content Engine — Facebook and LinkedIn text\n\nCommands:\n  npm run hce:doctor [-- --check-sheet]\n  npm run hce:draft -- --url <Ken report URL> --title <market> [--keyword <phrase>] [--platform fb|li|both] [--brain hermes|ollama|chain] [--background]\n  npm run hce:next -- --platform fb|li [--row N] [--keyword <phrase>] [--brain hermes|ollama|chain] [--write-sheet] [--retry-skipped] [--max-rows 5]\n  npm run hce:history -- --platform fb|li\n\nDraft and next only save local artifacts unless next includes --write-sheet. Nothing publishes to a social platform.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case 'doctor': await doctor(args); return;
    case 'draft': await draft(args); return;
    case 'next': await next(args); return;
    case 'history': await history(args); return;
    default: help();
  }
}

main().catch((error: unknown) => { console.error(`Content Engine: ${(error as Error).message}`); process.exitCode = 1; });
