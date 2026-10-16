import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ChatGptProvider, createBrowserSession } from './chatgpt/index.js';
import { loadConfig } from './config/index.js';
import type { LlmProvider } from './contracts.js';
import { isEngineError } from './errors.js';
import { TavilySearchProvider, checkClaims, loadKeysFromEnv } from './evidence/index.js';
import { OpenAiCompatProvider, createTextProvider, loadEnvFiles } from './llm/index.js';
import { createLogger } from './logger.js';
import { formatManifest, gatherEvidence, runContentPlan } from './pipeline/index.js';
import { Budget } from './safety/budget.js';
import { loadFlags } from './safety/flags.js';
import { ShutdownController } from './safety/shutdown.js';
import { FactSchema, FactSetSchema, PlatformIdSchema, type Fact, type SourceNote } from './schemas/index.js';
import { auditLegacyPosts, formatAuditMarkdown, mapSheetRows, parseCsv, rowsToObjects } from './shadow/index.js';
import { JsonFileStore } from './store/store.js';
import { createSheetsApi, pickNextFromSheet, parseSheetPlatform, writeGeneratedPost } from './sheets/social-sheet.js';
import { RepoStatusSchema, adoptCandidates, formatRegistry, loadRegistry, markRepo, runIntake, saveRegistry } from './repos/index.js';
import { addRepo, checkLabOutput, formatLabCheck, loadLab, runInRepo, saveLabCheck } from './lab/index.js';
import { shortHash } from './utils/hash.js';
import { buildCompetitorDetector } from './validation/competitors.js';
import { validateText } from './validation/index.js';

/**
 * Command line entry point. Nothing here publishes anything: the engine has no
 * publishing code, and dry_run / shadow_mode default to ON.
 *
 *   check-config
 *   probe-llm       [--prompt "..."] [--discover | --each-model]
 *                   one tiny request to each text provider; --discover lists served models; --each-model tests every configured model
 *   audit-legacy    --csv <sheet-export.csv> [--out <report.json>] [--col-x H] [--col-fb H] [--col-li H] [--col-url H] [--col-id H]
 *   gather-evidence --url <ken research report url> [--out <factset.json>]
 *   generate        --facts <factset.json> --campaign <id> --platform <x|facebook|linkedin|...> [--title T] [--url U] [--provider chain|chatgpt]
 *   validate        --platform <id> --file <text file> [--facts <factset.json>]     checks any finished text (for example a blog)
 *
 * Text posts use the API/Ollama chain. Blogs, carousels and images stay in the
 * existing ChatGPT pipelines. Set CE_ENV_FILE to read API keys from another
 * .env without copying it.
 */

type Args = { command: string; values: Map<string, string>; flags: Set<string> };

function parseArgs(argv: readonly string[]): Args {
  const [command = 'help', ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next);
      i++;
    } else {
      flags.add(name);
    }
  }
  return { command, values, flags };
}

function need(args: Args, name: string): string {
  const v = args.values.get(name);
  if (!v) throw new Error(`missing required option --${name}`);
  return v;
}

const OUTPUT_DIR = path.resolve('output');

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function cmdCheckConfig(): Promise<void> {
  const config = loadConfig();
  const flags = loadFlags();
  console.log(`config OK (version ${config.version})`);
  console.log(`  competitors: ${config.competitors.length}, blocked hosts: ${config.sourcePolicy.blockedHosts.length}`);
  console.log(`  campaigns: ${config.campaigns.map((c) => c.id).join(', ')}`);
  console.log(`  FB/LI hard cap: ${config.platformLimits.facebook.hardMaxChars}`);
  console.log(
    `flags OK: dryRun=${flags.dryRun} shadowMode=${flags.shadowMode} platformsEnabled=[${[...flags.enabledPlatforms].join(',')}] maxChatGptCalls=${flags.maxChatGptCalls} rewriteRounds=${flags.maxRewriteRounds}`,
  );
  const env = loadEnvFiles();
  if (env.loaded.length > 0) console.log(`extra env file read: ${env.loaded.join(', ')}`);
  if (env.missing.length > 0) console.warn(`warning: CE_ENV_FILE could not be read: ${env.missing.join(', ')}`);
  try {
    const setup = createTextProvider(process.env, { config });
    console.log(`text providers: ${setup.order.join(' > ')}`);
    for (const s of setup.skipped) console.log(`  skipped ${s.name}: ${s.reason}`);
  } catch (e) {
    console.warn(`text providers: not ready (${(e as Error).message})`);
  }
}

async function cmdProbeLlm(args: Args): Promise<void> {
  const config = loadConfig();
  const setup = createTextProvider(process.env, { config });
  // A normal-length answer: a one-word reply would be (correctly) rejected as degenerate output.
  const prompt =
    args.values.get('prompt') ??
    'In two plain sentences, explain why senior executives read market research before entering a new country.';
  for (const s of setup.skipped) console.log(`  skipped ${s.name}: ${s.reason}`);

  if (args.flags.has('discover')) {
    // Ask each provider which models it serves right now (free; no generation).
    for (const p of setup.providers) {
      if (!(p instanceof OpenAiCompatProvider)) continue;
      try {
        const ids = await p.listModels();
        const shown = p.id === 'openrouter' ? ids.filter((id) => id.endsWith(':free')) : ids;
        console.log(`${p.id}: ${ids.length} model(s)${p.id === 'openrouter' ? `, ${shown.length} free` : ''}`);
        for (const id of shown.slice(0, 80)) console.log(`    ${id}`);
      } catch (e) {
        console.log(`${p.id}: could not list models (${(e as Error).message})`);
      }
    }
    return;
  }

  if (args.flags.has('each-model')) {
    // One request per CONFIGURED model, so a dead model id is visible instead of being rotated past.
    console.log('testing every configured model once (set CE_GROQ_MODELS / CE_OPENROUTER_MODELS / CE_NVIDIA_MODELS to try others)');
    for (const p of setup.providers) {
      if (!(p instanceof OpenAiCompatProvider)) continue;
      console.log(`${p.id}:`);
      for (const r of await p.probeEachModel({ prompt, purpose: 'probe', maxOutputTokens: 400 })) {
        console.log(`    ${r.outcome.startsWith('ok') ? 'OK  ' : 'FAIL'} ${r.model.padEnd(52)} ${String(r.ms).padStart(5)}ms  ${r.outcome}${r.sample ? `: "${r.sample}"` : ''}`);
      }
    }
    return;
  }

  console.log(`probing ${setup.providers.length} provider(s), one tiny request each: ${setup.order.join(', ')}`);
  for (const provider of setup.providers) {
    const started = Date.now();
    try {
      const r = await provider.generate({ prompt, purpose: 'probe', maxOutputTokens: 120 });
      console.log(`  OK    ${provider.id.padEnd(11)} via ${r.provider} in ${Date.now() - started}ms: "${r.text.replace(/\s+/g, ' ').slice(0, 60)}"`);
    } catch (e) {
      const code = isEngineError(e) ? `${e.category}/${e.code}` : 'error';
      console.log(`  FAIL  ${provider.id.padEnd(11)} ${code}: ${(e as Error).message.slice(0, 140)}`);
    }
  }
}

async function cmdAuditLegacy(args: Args): Promise<void> {
  const csvPath = need(args, 'csv');
  const config = loadConfig();
  const rows = rowsToObjects(parseCsv(await readFile(csvPath, 'utf8')));
  const colArg = (name: string): string | undefined => args.values.get(name);
  const columns = {
    ...(colArg('col-x') ? { x: colArg('col-x')! } : {}),
    ...(colArg('col-fb') ? { facebook: colArg('col-fb')! } : {}),
    ...(colArg('col-li') ? { linkedin: colArg('col-li')! } : {}),
    ...(colArg('col-url') ? { url: colArg('col-url')! } : {}),
    ...(colArg('col-id') ? { id: colArg('col-id')! } : {}),
  };
  const mapped = mapSheetRows(rows, columns);
  for (const w of mapped.warnings) console.warn(`warning: ${w}`);
  console.log(`matched columns: ${JSON.stringify(mapped.matchedColumns)}; posts: ${mapped.posts.length}`);
  if (mapped.posts.length === 0) throw new Error('nothing to audit');

  const report = auditLegacyPosts(mapped.posts, config);
  const out = args.values.get('out') ?? path.join(OUTPUT_DIR, `audit-${Date.now()}.json`);
  await writeJson(out, report);
  console.log(formatAuditMarkdown(report));
  console.log(`\nfull report: ${out}`);
}

async function cmdGatherEvidence(args: Args): Promise<void> {
  const config = loadConfig();
  const result = await gatherEvidence({ url: need(args, 'url'), config });
  const out = args.values.get('out') ?? path.join(OUTPUT_DIR, `factset-${result.factSet.itemId}.json`);
  await writeJson(out, result.factSet);
  console.log(`extracted ${result.factSet.facts.length} fact(s) via ${result.extractionMethod}; source ${result.source.sourceType}`);
  for (const f of result.factSet.facts) {
    console.log(`  [${f.verificationStatus}] ${f.id}: ${f.metric} = ${f.value} ${f.unit}${f.period ? ` (${f.period})` : ''}${f.geography ? ` ${f.geography}` : ''}`);
  }
  console.log(`${result.factSet.notes.length} source note(s) from the page (qualitative statements the model may restate):`);
  for (const n of result.factSet.notes) console.log(`  [${n.id}] ${n.text}`);
  console.log(`saved: ${out}`);
}

async function loadFacts(file: string): Promise<{ facts: Fact[]; notes: SourceNote[]; itemId?: string; reportUrl?: string }> {
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  const asSet = FactSetSchema.safeParse(raw);
  if (asSet.success) return { facts: asSet.data.facts, notes: asSet.data.notes, itemId: asSet.data.itemId, reportUrl: asSet.data.reportUrl };
  return { facts: z.array(FactSchema).parse(raw), notes: [] };
}

async function cmdGenerate(args: Args): Promise<{ status: string; reason: string; text: string | null } | undefined> {
  const config = loadConfig();
  const flags = loadFlags();
  const platform = PlatformIdSchema.parse(need(args, 'platform'));
  const factsFile = args.values.get('facts');
  const loaded = factsFile ? await loadFacts(factsFile) : { facts: [] as Fact[], notes: [] as SourceNote[] } as Awaited<ReturnType<typeof loadFacts>>;
  const url = args.values.get('url') ?? loaded.reportUrl;
  if (!factsFile && !url) throw new Error('pass --facts <factset.json> or --url <report page>');
  const item = url
    ? { id: loaded.itemId ?? `item_${shortHash(url, 12)}`, title: args.values.get('title') ?? 'Ken Research report', reportUrl: url }
    : undefined;

  const logger = createLogger({ level: flags.logLevel });
  const shutdown = new ShutdownController();
  const removeSignals = shutdown.installSignalHandlers();
  const useChatGpt = args.values.get('provider') === 'chatgpt';
  try {
    let provider: LlmProvider;
    if (useChatGpt) {
      const session = await createBrowserSession({ headless: args.flags.has('headless') });
      shutdown.register(() => session.close());
      provider = new ChatGptProvider({ session, budget: new Budget('chatgpt-calls', flags.maxChatGptCalls), shutdown, logger });
    } else {
      const setup = createTextProvider(process.env, { config, logger });
      for (const s of setup.skipped) console.log(`skipped ${s.name}: ${s.reason}`);
      console.log(`text providers: ${setup.order.join(' > ')}`);
      provider = setup.provider;
    }
    const store = new JsonFileStore(path.join(OUTPUT_DIR, 'store'));
    const strict = args.flags.has('strict');
    const feedUrls = (process.env.CE_RSS_FEEDS ?? '').split(',').map((u) => u.trim()).filter(Boolean);
    const searchProvider = loadKeysFromEnv('TAVILY_API_KEY').length > 0 ? new TavilySearchProvider() : undefined;
    const result = await runContentPlan(
      {
        platform,
        campaignId: need(args, 'campaign'),
        ...(item ? { item } : {}),
        ...(loaded.facts.length > 0 ? { facts: loaded.facts, notes: loaded.notes } : {}),
        ...(url ? { url } : {}),
        ...(args.values.get('title') ? { market: args.values.get('title')! } : {}),
      },
      {
        config,
        provider,
        lenientOutput: !useChatGpt,
        claimChecker: checkClaims,
        store,
        flags,
        logger,
        budget: new Budget('rewrite-rounds', flags.maxRewriteRounds * 5),
        shutdown,
      },
      { strict, minimal: args.flags.has('minimal'), techniques: args.flags.has('techniques'), qualitativeFallback: !args.flags.has('figures-only'), supplementary: args.flags.has('report-only') ? 'off' : args.flags.has('ken-gov-only') ? 'ken-gov' : 'all', feedUrls, ...(searchProvider ? { searchProvider } : {}) },
    );
    console.log(`\nPLAN (${platform})${strict ? ' [strict]' : ''}\n${formatManifest(result.steps)}`);
    if (result.sanity.length > 0) {
      console.log('\nCONTENT SANITY');
      for (const r of result.sanity) {
        const mark = r.status === 'pass' ? 'PASS' : r.status === 'warn' ? 'WARN' : 'FAIL';
        console.log(`  ${mark}  ${r.label}${r.detail ? `\n        -> ${r.detail}` : ''}`);
      }
    }
    if (result.supplementary) {
      console.log('');
      console.log('EVIDENCE PACK (beyond the report page)');
      for (const s of result.supplementary.sources) console.log(`  ${s.tier.padEnd(12)} ${s.name}  [${s.facts} facts, ${s.notes} notes]  ${s.url}`);
      if (result.supplementary.sources.length === 0) console.log('  nothing usable was found');
      for (const k of result.supplementary.skipped.slice(0, 6)) console.log(`  skipped: ${k.url} (${k.reason})`);
    }
    if (result.fresh) {
      for (const g of result.fresh.government) console.log(`  fresh govt: ${g.title} ${g.url}`);
      for (const t of result.fresh.trends) console.log(`  fresh trend (planning only): ${t.title} ${t.url}`);
    }
    console.log(`\nstatus: ${result.status}\nreason: ${result.reason}`);
    for (const s of result.stages) console.log(`stage ${s.stage}: ${s.provider}${s.salvaged ? ' (format ignored, text salvaged)' : ''}`);
    if (result.draft) console.log(`\n--- draft (${result.draft.platform}, ${result.draft.text.length} chars) ---\n${result.draft.text}\n---`);
    console.log(`run: ${result.runId} (saved under ${path.join(OUTPUT_DIR, 'store')})`);
    console.log(`flags: dryRun=${flags.dryRun} shadowMode=${flags.shadowMode}; nothing was published.`);
    if (result.status === 'needs_human') process.exitCode = 2;
    return { status: result.status, reason: result.reason, text: result.draft?.text ?? null };
  } finally {
    removeSignals();
    await shutdown.shutdown(5_000);
  }
}

/**
 * Sheet titles carry the catalogue suffix ("... Market Share, Companies & Trends Report 2025-2032"). Models paste the
 * title into the closing line of a post, so only the market name is passed on.
 */
export function cleanReportTitle(title: string): string {
  return title
    .replace(/\s*(?:Market\s+Share,?\s*Companies\s*(?:&|and)\s*Trends\s+Report|Market\s+Report|Report)\b.*$/i, '')
    .replace(/\s+\d{4}\s*[-–]\s*\d{4}\s*$/, '')
    .trim();
}

/** Rows the engine could not make a post for (no verified fact), remembered locally so the next run does not stop on them again. */
interface SkippedRow {
  url: string;
  reason: string;
  at: string;
}
const SKIPPED_FILE = path.join(OUTPUT_DIR, 'skipped-rows.json');

async function loadSkippedRows(): Promise<Record<string, Record<string, SkippedRow>>> {
  try {
    return JSON.parse(await readFile(SKIPPED_FILE, 'utf8')) as Record<string, Record<string, SkippedRow>>;
  } catch {
    return {};
  }
}

/**
 * Picks the next sheet row for a platform, runs the full plan on its report URL and, when the post is approved, writes
 * the text into that row's "<Platform> Post" cell (nothing else in the sheet is touched).
 *
 * A row whose report has no usable verified fact cannot become a post: it is remembered in output/skipped-rows.json
 * and the next row is tried (up to --max-rows, default 5, per run). The check happens before any model is called, so
 * skipping is quick. --retry-skipped forgets that list.
 *
 * --no-write only generates; --overwrite replaces text already in the cell; --row N forces one row (no skipping).
 */
async function cmdNext(args: Args): Promise<void> {
  const platform = parseSheetPlatform(need(args, 'platform'));
  const from = args.values.get('row');
  const write = !args.flags.has('no-write');
  const maxRows = Math.max(1, Number(args.values.get('max-rows') ?? 5));
  const skippedAll = args.flags.has('retry-skipped') ? {} : await loadSkippedRows();
  const excluded = new Set<number>(from ? [] : Object.keys(skippedAll[platform] ?? {}).map(Number));

  for (let attempt = 1; attempt <= maxRows; attempt++) {
    const pick = await pickNextFromSheet(platform, from ? Number(from) : undefined, process.env, {
      skipGenerated: !from && !args.flags.has('overwrite'),
      exclude: excluded,
    });
    if (!pick) {
      console.log(`No pending row for ${platform}: every row after the last processed one is empty, processed, already has generated text, or was skipped (${excluded.size} skipped).`);
      process.exitCode = 3;
      return;
    }
    console.log(`sheet row ${pick.rowIndex}: ${pick.title}`);
    console.log(`  ${pick.url}`);
    console.log(write ? "  (the approved post will be written to this row's Post cell; no other cell is touched)" : '  (--no-write: the sheet is not changed)');
    args.values.set('platform', platform);
    args.values.set('url', pick.url);
    if (pick.title) args.values.set('title', cleanReportTitle(pick.title));
    if (!args.values.has('campaign')) args.values.set('campaign', 'authority-insights');
    const outcome = await cmdGenerate(args);

    if (!from && outcome?.status === 'needs_human' && outcome.reason.startsWith('NO_VERIFIED_FACTS')) {
      const all = await loadSkippedRows();
      all[platform] = { ...(all[platform] ?? {}), [pick.rowIndex]: { url: pick.url, reason: outcome.reason, at: new Date().toISOString() } };
      await mkdir(OUTPUT_DIR, { recursive: true });
      await writeFile(SKIPPED_FILE, JSON.stringify(all, null, 2), 'utf8');
      excluded.add(pick.rowIndex);
      process.exitCode = undefined;
      console.log(`\nROW ${pick.rowIndex} SKIPPED: no verified, non-conflicting fact from 2024 or later on that report page. Remembered in ${SKIPPED_FILE}; trying the next row (${attempt}/${maxRows}).\n`);
      continue;
    }

    if (!write) return;
    if (!outcome || outcome.status !== 'approved' || !outcome.text) {
      console.log('\nSHEET: nothing written (the post was not approved).');
      return;
    }
    try {
      const api = createSheetsApi(process.env, { write: true });
      const done = await writeGeneratedPost(api, platform, { rowIndex: pick.rowIndex, url: pick.url }, outcome.text, { overwrite: args.flags.has('overwrite') });
      console.log(`\nSHEET: wrote the post to cell ${done.cell} of "${api.tab}" ${done.verified ? '(read back and confirmed)' : '(WARNING: read-back did not match)'}. Status and URL cells were left empty, so the daemon posts it.`);
    } catch (e) {
      console.log(`\nSHEET: not written: ${(e as Error).message}`);
      process.exitCode = 4;
    }
    return;
  }
  console.log(`\nStopped after ${maxRows} skipped rows. Run again to try the next ones, or raise --max-rows.`);
  process.exitCode = 3;
}

/** Reads a GitHub repo someone gave us, checks it against our rules and lists techniques we could adopt. */
async function cmdRepoIntake(args: Args): Promise<void> {
  const config = loadConfig();
  const report = await runIntake(need(args, 'url'), { detector: buildCompetitorDetector(config.competitors) });
  console.log(`${report.repo}  license: ${report.license.spdx ?? 'none'} (${report.license.level})  stars: ${report.language ?? '-'} / ${report.stars}`);
  console.log(`useful for: ${report.usefulFor.map((u) => `${u.use}(${u.hits})`).join(', ') || 'unclear'}`);
  for (const w of report.warnings) console.log(`WARNING: ${w}`);
  for (const r of report.risks) console.log(`RISK ${r.code}: ${r.message}`);
  console.log(`
${report.recommendation}
`);
  for (const c of report.candidates) console.log(`${String(c.n).padStart(2)}. ${c.blocked ? `[BLOCKED: ${c.blocked}] ` : ''}${c.text}`);
  console.log(`
full report: output/repo-intake/${report.repo.replace('/', '__')}.md`);
  console.log(`adopt with: npm run repo:adopt -- --repo ${report.repo} --pick 1,3 --for linkedin,facebook,x,blog`);
}

/** Turns picked candidates into techniques the prompts will use. */
function cmdRepoAdopt(args: Args): void {
  const picks = (args.values.get('pick') ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const appliesTo = (args.values.get('for') ?? 'all').split(',').map((s) => s.trim()).filter(Boolean);
  const text = args.values.get('text');
  const result = adoptCandidates({ repoId: need(args, 'repo'), picks, appliesTo, ...(text ? { text } : {}) });
  console.log(`adopted ${result.adopted.length} technique(s) for ${appliesTo.join(', ')}:`);
  for (const a of result.adopted) console.log(`  - ${a}`);
  console.log(`saved: ${result.file}
They appear in the prompts as "WRITING TECHNIQUES" from the next run.`);
}

/** Clones a repo into the lab (github-seo/repos). Installs and runs nothing. */
async function cmdLabAdd(args: Args): Promise<void> {
  const url = need(args, 'url');
  const entry = await addRepo(url);
  console.log(`cloned ${entry.id} into ${entry.dir}`);
  for (const h of entry.hints) console.log(`  hint: ${h}`);
  try {
    const config = loadConfig();
    const report = await runIntake(url, { detector: buildCompetitorDetector(config.competitors) });
    console.log(`license: ${report.license.spdx ?? 'none'} (${report.license.level}). ${report.license.note}`);
    for (const r of report.risks) console.log(`RISK ${r.code}: ${r.message}`);
  } catch (e) {
    console.log(`(license/risk check skipped: ${(e as Error).message})`);
  }
  console.log(`\nNothing was installed or run. To run it as it is:\n  npm run lab:run -- --repo ${entry.id} --cmd "npm install"\n  npm run lab:run -- --repo ${entry.id} --cmd "<its run command>" --env GROQ_API_KEY_1`);
  console.log(`Then judge what it wrote:\n  npm run lab:check -- --repo ${entry.id} --platform linkedin --url <Ken Research report url> --file <its output text file>`);
}

function cmdLabList(): void {
  const lab = loadLab();
  if (lab.repos.length === 0) return console.log('The lab is empty. Add a repo with: npm run lab:add -- --url https://github.com/<owner>/<repo>');
  for (const r of lab.repos) {
    console.log(`${r.id}  (cloned ${r.clonedAt.slice(0, 10)})\n  ${r.dir}`);
    for (const h of r.hints) console.log(`  - ${h}`);
  }
}

/** Runs one command you typed inside a lab repo. Only the environment variables named with --env reach it. */
async function cmdLabRun(args: Args): Promise<void> {
  const allow = (args.values.get('env') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const timeoutSec = Number(args.values.get('timeout') ?? 600);
  console.log(`running inside the lab repo with a scrubbed environment (keys passed: ${allow.join(', ') || 'none'})`);
  const result = await runInRepo(need(args, 'repo'), need(args, 'cmd'), { allowEnv: allow, timeoutMs: timeoutSec * 1000 });
  console.log(`\nexit code: ${result.code}\nlog: ${result.log}`);
  if (result.code !== 0) process.exitCode = 2;
}

/** Judges a text that any repo produced with this engine's own checks. */
async function cmdLabCheck(args: Args): Promise<void> {
  const config = loadConfig();
  const platform = PlatformIdSchema.parse(need(args, 'platform'));
  const text = await readFile(need(args, 'file'), 'utf8');
  let facts: Fact[] = [];
  let notes: SourceNote[] = [];
  if (args.values.get('facts')) {
    ({ facts, notes } = await loadFacts(args.values.get('facts')!));
  } else {
    const got = await gatherEvidence({ url: need(args, 'url'), config });
    facts = got.factSet.facts;
    notes = got.factSet.notes;
  }
  const layout = args.values.get('layout');
  const result = checkLabOutput({ repoId: need(args, 'repo'), platform, text, facts, notes, ...(layout ? { layout } : {}) }, config, checkClaims);
  console.log(formatLabCheck(result));
  console.log(`saved: ${saveLabCheck(result, text)}`);
  if (!result.wouldPass) process.exitCode = 2;
}

/** Records the decision on a repo: pending, reviewed, ideas-adopted or rejected, with the reason. */
function cmdRepoMark(args: Args): void {
  const status = RepoStatusSchema.parse(need(args, 'status'));
  const updated = markRepo(loadRegistry(), need(args, 'repo'), status, args.values.get('note') ?? '');
  saveRegistry(updated);
  console.log(`marked ${need(args, 'repo')} as ${status}`);
}

function cmdRepoList(): void {
  console.log(formatRegistry(loadRegistry()));
}

async function cmdValidate(args: Args): Promise<void> {
  const config = loadConfig();
  const platform = PlatformIdSchema.parse(need(args, 'platform'));
  const text = await readFile(need(args, 'file'), 'utf8');
  const facts = args.values.get('facts') ? (await loadFacts(args.values.get('facts')!)).facts : [];
  const report = validateText(
    { draftId: 'cli-validate', platform, text, facts, recentTexts: [], claimChecker: checkClaims },
    config,
  );
  console.log(`${platform}: ${text.length} chars, ${report.passed ? 'PASSED hard checks' : 'FAILED hard checks'}`);
  if (facts.length === 0) console.log('note: no --facts given, so any number in the text is reported as unsupported.');
  for (const issue of report.issues) console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
  if (!report.passed) process.exitCode = 2;
}

const HELP = `content-engine CLI
  check-config
  probe-llm       [--prompt "..."]
  audit-legacy    --csv <file> [--out <file>] [--col-x H] [--col-fb H] [--col-li H] [--col-url H] [--col-id H]
  gather-evidence --url <ken research report url> [--out <file>]
  repo-intake     --url <github url>                      (check a repo against our rules, list adoptable techniques)
  repo-adopt      --repo owner/name (--pick 1,3 | --text "own wording") [--for linkedin,x,blog]
  repo-mark       --repo owner/name --status pending|reviewed|ideas-adopted|rejected --note "why"
  lab-add         --url <github url>                      (clone a repo into github-seo/repos; installs and runs nothing)
  lab-run         --repo owner/name --cmd "<command>" [--env KEY1,KEY2] [--timeout 600]   (runs as it is, scrubbed env)
  lab-check       --repo owner/name --platform <id> --file <text> (--url <report> | --facts <factset.json>) [--layout id]
  lab-list
  repo-list                                                 (every repo we looked at and what became of it)
  next            --platform <li|fb|x> [--row N] [--no-write] [--overwrite] [--max-rows 5] [--retry-skipped] [--figures-only] [--report-only | --ken-gov-only] [--strict] [--minimal]   (picks the next row, generates, and writes the approved post into that row's <Platform> Post cell)
  generate        (--facts <factset.json> | --url U) --campaign <id> --platform <id> [--title T] [--strict] [--minimal] [--techniques] [--provider chain|chatgpt] [--headless]
  validate        --platform <id> --file <text file> [--facts <factset.json>]`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnvFiles();
  if (env.missing.length > 0) console.warn(`warning: CE_ENV_FILE could not be read: ${env.missing.join(', ')}`);
  switch (args.command) {
    case 'check-config':
      return cmdCheckConfig();
    case 'probe-llm':
      return cmdProbeLlm(args);
    case 'audit-legacy':
      return cmdAuditLegacy(args);
    case 'gather-evidence':
      return cmdGatherEvidence(args);
    case 'generate':
      await cmdGenerate(args);
      return;
    case 'next':
      return cmdNext(args);
    case 'repo-intake':
      return cmdRepoIntake(args);
    case 'repo-adopt':
      return cmdRepoAdopt(args);
    case 'repo-list':
      return cmdRepoList();
    case 'repo-mark':
      return cmdRepoMark(args);
    case 'lab-add':
      return cmdLabAdd(args);
    case 'lab-list':
      return cmdLabList();
    case 'lab-run':
      return cmdLabRun(args);
    case 'lab-check':
      return cmdLabCheck(args);
    case 'validate':
      return cmdValidate(args);
    default:
      console.log(HELP);
  }
}

main().catch((e: unknown) => {
  if (isEngineError(e)) console.error(`${e.name} [${e.category}/${e.code}]: ${e.message}`);
  else console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
