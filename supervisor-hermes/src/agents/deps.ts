import type { LoadedConfig } from '../../../src/config/index.js';
import type { ClaimChecker, Fetcher, LlmProvider, SearchProvider } from '../../../src/contracts.js';
import type { SheetsApi } from '../../../src/sheets/social-sheet.js';
import type { HermesProvider } from '../../../src/social/hermes-provider.js';
import type { Store } from '../../../src/store/store.js';
import type { RunLimits } from '../limits.js';

export interface AgentDeps {
  config: LoadedConfig;
  store: Store;
  claimChecker: ClaimChecker;
  /** The writer's model. Wrap with countedProvider so calls spend the shared Hermes budget. */
  writer: LlmProvider;
  /** Only needed by the learning agent (memory call). */
  hermes?: HermesProvider;
  sheets: SheetsApi;
  searchProvider?: SearchProvider;
  fetcher?: Fetcher;
  limits: RunLimits;
  now: () => Date;
}
