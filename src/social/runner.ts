import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import type { LlmProvider } from '../contracts.js';
import { loadConfig } from '../config/index.js';
import { checkClaims, loadKeysFromEnv, TavilySearchProvider } from '../evidence/index.js';
import { createTextProvider, loadEnvFiles, OllamaProvider } from '../llm/index.js';
import { PLAN_RUNS_COLLECTION, runContentPlan, type PlanResult } from '../pipeline/run-plan.js';
import { loadTechniques } from '../repos/techniques.js';
import { Budget } from '../safety/budget.js';
import { loadFlags } from '../safety/flags.js';
import type { Fact, PlatformId, SourceNote } from '../schemas/index.js';
import { createSheetsApi, writeGeneratedPost } from '../sheets/social-sheet.js';
import { JsonFileStore } from '../store/store.js';
import { shortHash } from '../utils/hash.js';
import { HermesProvider } from './hermes-provider.js';
import { loadLessons, loadRecentRepairTraces, recordLearning } from './learning.js';

export type SocialPlatform = 'facebook' | 'linkedin';
export type BrainChoice = 'hermes' | 'ollama' | 'chain';

export interface SocialJob {
  url: string;
  title: string;
  keyword: string;
  platform: SocialPlatform;
  brain?: BrainChoice;
  /** Previously collected evidence can be shared between FB and LI. */
  evidence?: { facts: Fact[]; notes: SourceNote[] };
  /** Optional Sheet destination, always explicitly requested by the caller. */
  sheetRow?: number;
  writeSheet?: boolean;
  allowNeutralBackground?: boolean;
}

export interface SocialJobResult {
  runId: string;
  status: PlanResult['status'];
  reason: string;
  text: string | null;
  keyword: string;
  platform: SocialPlatform;
  score: number | null;
  variation: PlanResult['variant'];
  attempts: number;
  modelCalls: number | null;
  modelTokens: number | null;
  learned: string[];
  hermesMemory: string;
  sheet: { row: number; cell: string; verified: boolean } | null;
  evidence: { facts: Fact[]; notes: SourceNote[] };
  artifact: string;
}

export const storeRoot = (): string => path.resolve('output', 'store');

export function choosePrimaryKeyword(title: string, supplied?: string): string {
  if (supplied?.trim()) return supplied.trim().replace(/\s+/g, ' ');
  const cleaned = title.replace(/\b(?:Market Share|Market Size|Companies|Trends|Forecast|Outlook|Analysis|Report)\b.*$/i, '').replace(/\s+/g, ' ').trim().replace(/[,:;–—-]+$/, '').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2) throw new Error('No usable primary keyword could be inferred; pass --keyword explicitly.');
  return words.slice(0, 5).join(' ');
}

function providerFor(choice: BrainChoice, lessons: Awaited<ReturnType<typeof loadLessons>>, recentTraces: Awaited<ReturnType<typeof loadRecentRepairTraces>>): { provider: LlmProvider; hermes?: HermesProvider } {
  if (choice === 'hermes') {
    const hermes = new HermesProvider({ lessons, recentTraces });
    return { provider: hermes, hermes };
  }
  if (choice === 'ollama') return { provider: new OllamaProvider({ model: process.env.CE_OLLAMA_MODEL }) };
  const setup = createTextProvider(process.env, { config: loadConfig() });
  return { provider: setup.provider };
}

export async function runSocialJob(job: SocialJob): Promise<SocialJobResult> {
  loadEnvFiles();
  const config = loadConfig();
  const flags = loadFlags();
  const store = new JsonFileStore(storeRoot());
  const keyword = choosePrimaryKeyword(job.title, job.keyword);
  const lessons = await loadLessons(store, job.platform);
  const recentTraces = await loadRecentRepairTraces(store, job.platform);
  const { provider, hermes } = providerFor(job.brain ?? 'hermes', lessons, recentTraces);
  const searchProvider = loadKeysFromEnv('TAVILY_API_KEY').length > 0 ? new TavilySearchProvider() : undefined;
  const result = await runContentPlan(
    {
      platform: job.platform,
      campaignId: 'authority-insights',
      item: { id: `item_${shortHash(job.url, 12)}`, title: job.title, reportUrl: job.url },
      url: job.url,
      market: job.title,
      primaryKeyword: keyword,
      minUsefulWords: job.platform === 'linkedin' ? 110 : 95,
      ...(job.evidence ? { facts: job.evidence.facts, notes: job.evidence.notes } : {}),
    },
    { config, provider, lenientOutput: job.brain === 'ollama', claimChecker: checkClaims, store, flags, budget: new Budget('rewrite-rounds', 3) },
    { socialLean: true, skipFreshData: true, techniques: true, styleDir: job.platform === 'facebook' ? 'config/style-examples/facebook' : 'config/style-examples', qualitativeFallback: true, supplementary: job.evidence ? 'off' : job.allowNeutralBackground ? 'all' : 'ken-gov', ...(searchProvider ? { searchProvider } : {}), variantLimit: 0.6 },
  );
  const pack = await store.get<{ evidencePack?: { facts?: Fact[]; notes?: SourceNote[] } }>(PLAN_RUNS_COLLECTION, result.runId);
  const evidence = { facts: pack?.evidencePack?.facts ?? job.evidence?.facts ?? [], notes: pack?.evidencePack?.notes ?? job.evidence?.notes ?? [] };
  const methods = loadTechniques(job.platform).files;
  const learning = await recordLearning(store, result, job.platform, keyword, methods, [...(hermes?.usedLessonIds ?? [])], hermes?.calls ?? 0, hermes?.tokens ?? null);

  let hermesMemory = 'not applicable';
  if (hermes && learning.newLessons.length > 0) {
    try { hermesMemory = await hermes.rememberLesson(learning.newLessons[0]!); }
    catch (error) { hermesMemory = `pending: ${(error as Error).message}`; }
  }

  let sheet: SocialJobResult['sheet'] = null;
  if (job.writeSheet) {
    if (!job.sheetRow) throw new Error('Sheet write requires the selected row number.');
    if (result.status !== 'approved' || !result.draft?.text) throw new Error(`Sheet not written: ${result.reason}`);
    const api = createSheetsApi(process.env, { write: true });
    const done = await writeGeneratedPost(api, job.platform, { rowIndex: job.sheetRow, url: job.url }, result.draft.text);
    if (!done.verified) throw new Error(`Sheet read-back mismatch at ${done.cell}; this run is not ready for posting.`);
    sheet = { row: job.sheetRow, cell: done.cell, verified: true };
  }

  const outFile = path.resolve('output', 'social-runs', `${result.runId}.json`);
  const output: SocialJobResult = {
    runId: result.runId,
    status: result.status,
    reason: result.reason,
    text: result.draft?.text ?? null,
    keyword,
    platform: job.platform,
    score: result.score?.overall ?? null,
    variation: result.variant,
    attempts: result.rewrite?.attempts.length ?? 0,
    modelCalls: hermes?.calls ?? null,
    modelTokens: hermes?.tokens ?? null,
    learned: learning.newLessons.map((lesson) => lesson.id),
    hermesMemory,
    sheet,
    evidence,
    artifact: outFile,
  };
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(output, null, 2), 'utf8');
  return output;
}
