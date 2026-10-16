import { loadConfig, type LoadedConfig } from '../config/index.js';
import type { PlatformId } from '../schemas/index.js';

/** The item (report) a piece of content is built around. Only what strategy needs. */
export interface StrategyItem {
  id: string;
  title: string;
  /** Ken Research report page. The only link that may appear in generated text. */
  reportUrl: string;
}

let cached: LoadedConfig | undefined;

/** Validated shipped config, loaded once. Callers can always inject their own. */
export function defaultConfig(): LoadedConfig {
  cached ??= loadConfig();
  return cached;
}

export type { PlatformId, LoadedConfig };
