import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { checkClaims, loadKeysFromEnv, TavilySearchProvider } from '../../src/evidence/index.js';
import type { SheetsApi } from '../../src/sheets/social-sheet.js';
import { HermesProvider } from '../../src/social/hermes-provider.js';
import { loadLessons, loadRecentRepairTraces } from '../../src/social/learning.js';
import { JsonFileStore } from '../../src/store/store.js';
import { shortHash } from '../../src/utils/hash.js';
import type { SheetPickOutput } from './agents/sheet.js';
import { createHermesAsk } from './hermes-client.js';
import { Ledger } from './ledger.js';
import { countedProvider, RunLimits } from './limits.js';
import { processRow } from './orchestrator.js';
import { Supervisor } from './supervisor.js';
import { formatTimeline } from './timeline.js';
import type { RowResult, SocialPlatform } from './types.js';

/** Always generates locally. The durable queue owns the separate, recoverable Sheet commit. */
export async function generateOvernightPost(platform: SocialPlatform, pick: SheetPickOutput, sheets: SheetsApi, signal: AbortSignal): Promise<{ result: RowResult; runId: string }> {
  signal.throwIfAborted();
  const config = loadConfig();
  const store = new JsonFileStore(path.resolve('output/store'));
  const runId = `run_${shortHash(`${platform}:${pick.url}:${Date.now()}`, 12)}`;
  const ledger = new Ledger(path.resolve('output/supervisor-hermes'), runId, event => console.log(`  ${formatTimeline([event])}`));
  const limits = new RunLimits({ maxHermesCalls: 20, maxRetries: 3, maxRegenerations: 2 });
  const hermes = new HermesProvider({ maxCalls: 100, signal, lessons: await loadLessons(store, platform), recentTraces: await loadRecentRepairTraces(store, platform) });
  const searchProvider = loadKeysFromEnv('TAVILY_API_KEY').length ? new TavilySearchProvider() : undefined;
  const role = readFileSync(new URL('../roles/supervisor.md', import.meta.url), 'utf8');
  const result = await processRow({ pick, platform, writeSheet: false, supplementary: 'ken-gov' }, {
    deps: { config, store, writer: countedProvider(hermes, limits), hermes, sheets, claimChecker: checkClaims, limits, now: () => new Date(), ...(searchProvider ? { searchProvider } : {}) },
    supervisor: new Supervisor(createHermesAsk({ signal }), role, limits), ledger, runId,
  });
  await writeFile(path.join(ledger.dir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  return { result, runId };
}
