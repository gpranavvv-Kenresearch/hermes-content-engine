import type { LoadedConfig } from '../config/index.js';
import { salvagePlainText, type LlmProvider } from '../contracts.js';
import { ConfigError } from '../errors.js';
import { loadKeysFromEnv } from '../evidence/search-providers.js';
import { buildCheckContext } from '../validation/checks/context.js';
import { modelArtifactChecks } from '../validation/checks/model-artifacts.js';
import { ChainProvider } from './chain-provider.js';
import { ModelHealth } from './model-health.js';
import { OllamaProvider } from './ollama-provider.js';
import { OpenAiCompatProvider, type ProviderLogger } from './openai-compat-provider.js';

export type TextProviderName = 'ollama' | 'groq' | 'openrouter' | 'nvidia';

const KNOWN: readonly TextProviderName[] = ['ollama', 'groq', 'openrouter', 'nvidia'];

/** Default order: local first (free, no rate limit), then the free API tiers the legacy pipeline used. */
export const DEFAULT_PROVIDER_ORDER: readonly TextProviderName[] = ['ollama', 'groq', 'nvidia', 'openrouter'];

/**
 * Default models were chosen by listing what each provider serves
 * (`probe-llm --discover`) and testing each candidate once
 * (`probe-llm --each-model`) on 2026-10-13. The legacy defaults
 * (groq/compound-mini, minimax-m3:free, deepseek-v4-pro-0813) were gone by then.
 * Free-tier model ids keep drifting: re-run those two commands when a provider
 * starts failing, then override with CE_GROQ_MODELS / CE_OPENROUTER_MODELS /
 * CE_NVIDIA_MODELS instead of editing code.
 */
const API_PROVIDERS = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    keyPrefix: 'GROQ_API_KEY',
    modelsEnv: 'CE_GROQ_MODELS',
    defaultModels: ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b'],
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    keyPrefix: 'OPENROUTER_API_KEY',
    modelsEnv: 'CE_OPENROUTER_MODELS',
    defaultModels: ['nvidia/nemotron-3-super-120b-a12b:free', 'poolside/laguna-s-2.1:free'],
  },
  nvidia: {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keyPrefix: 'NVIDIA_API_KEY',
    modelsEnv: 'CE_NVIDIA_MODELS',
    // No model was invokable on 2026-10-13 (the ones listed returned 404 or timed out), so no default.
    defaultModels: [] as readonly string[],
  },
} as const;

export interface CreateTextProviderOptions {
  config: LoadedConfig;
  fetchImpl?: typeof fetch;
  freeMemoryMB?: () => number;
  logger?: ProviderLogger;
}

export interface TextProviderSetup {
  provider: ChainProvider;
  /** The individual providers behind the chain (used by the probe command). */
  providers: LlmProvider[];
  /** Providers in the chain, in order. */
  order: string[];
  /** Providers that were requested but left out, with the reason. */
  skipped: Array<{ name: string; reason: string }>;
  /** Models per API provider (not secret). */
  models: Record<string, string[]>;
}

function parseList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Builds the text-post provider chain from the environment:
 *   CE_TEXT_PROVIDERS   comma list, default "ollama,groq,openrouter,nvidia"
 *   CE_OLLAMA_URL / CE_OLLAMA_MODEL / CE_OLLAMA_MIN_FREE_MB
 *   CE_GROQ_MODELS / CE_OPENROUTER_MODELS / CE_NVIDIA_MODELS   comma lists
 *   <PROVIDER>_API_KEY and <PROVIDER>_API_KEY_1..N
 * An API provider with no keys is skipped. Ollama is always included when
 * requested; if it is down or short of RAM at call time the chain moves on.
 */
export function createTextProvider(env: Record<string, string | undefined>, options: CreateTextProviderOptions): TextProviderSetup {
  const requested = parseList(env.CE_TEXT_PROVIDERS);
  const names = (requested.length > 0 ? requested : [...DEFAULT_PROVIDER_ORDER]).map((n) => n.toLowerCase());
  const unknown = names.filter((n) => !(KNOWN as readonly string[]).includes(n));
  if (unknown.length > 0) throw new ConfigError([`CE_TEXT_PROVIDERS: unknown provider(s) ${unknown.join(', ')} (known: ${KNOWN.join(', ')})`]);

  const ctx = buildCheckContext('x', options.config);
  // Replies arrive wrapped in our output-format markers, and those markers are exactly
  // what the prompt-echo check looks for. So the junk checks run on the CONTENT only.
  const rejectOutput = (raw: string): string | null => {
    const subject = salvagePlainText(raw) ?? raw;
    for (const check of modelArtifactChecks) {
      const issues = check(subject, ctx);
      if (issues.length > 0) return issues[0]!.code;
    }
    return null;
  };

  const providers: LlmProvider[] = [];
  const skipped: TextProviderSetup['skipped'] = [];
  const models: Record<string, string[]> = {};
  const health = new ModelHealth();

  for (const name of names as TextProviderName[]) {
    if (name === 'ollama') {
      const minFree = Number(env.CE_OLLAMA_MIN_FREE_MB ?? '');
      const timeoutS = Number(env.CE_OLLAMA_TIMEOUT_S ?? '');
      const numCtx = Number(env.CE_OLLAMA_NUM_CTX ?? '');
      providers.push(
        new OllamaProvider({
          ...(env.CE_OLLAMA_URL ? { baseUrl: env.CE_OLLAMA_URL } : {}),
          ...(env.CE_OLLAMA_MODEL ? { model: env.CE_OLLAMA_MODEL } : {}),
          ...(Number.isFinite(minFree) && env.CE_OLLAMA_MIN_FREE_MB ? { minFreeMemoryMB: minFree } : {}),
          ...(Number.isFinite(timeoutS) && timeoutS > 0 ? { timeoutMs: timeoutS * 1000 } : {}),
          ...(Number.isFinite(numCtx) && numCtx > 0 ? { numCtx } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          ...(options.freeMemoryMB ? { freeMemoryMB: options.freeMemoryMB } : {}),
          ...(options.logger ? { logger: options.logger } : {}),
          rejectOutput,
        }),
      );
      continue;
    }
    const spec = API_PROVIDERS[name];
    const keys = loadKeysFromEnv(spec.keyPrefix, env);
    if (keys.length === 0) {
      skipped.push({ name, reason: `no ${spec.keyPrefix} keys found` });
      continue;
    }
    const configured = parseList(env[spec.modelsEnv]);
    const modelList = configured.length > 0 ? configured : [...spec.defaultModels];
    if (modelList.length === 0) {
      skipped.push({ name, reason: `no verified model: run \`probe-llm --discover\`, then set ${spec.modelsEnv}` });
      continue;
    }
    models[name] = modelList;
    providers.push(
      new OpenAiCompatProvider({
        id: name,
        baseUrl: spec.baseUrl,
        keys,
        models: modelList,
        rejectOutput,
        health,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      }),
    );
  }

  if (providers.length === 0) {
    throw new ConfigError(['no text provider is available: add API keys (GROQ_API_KEY_*, OPENROUTER_API_KEY_*, NVIDIA_API_KEY*) or include ollama in CE_TEXT_PROVIDERS']);
  }
  const chain = new ChainProvider({ providers, ...(options.logger ? { logger: options.logger } : {}) });
  return { provider: chain, providers, order: chain.providerIds, skipped, models };
}
