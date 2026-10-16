import type { LlmProvider, LlmRequest, LlmResult } from '../contracts.js';
import { BudgetExceededError, EngineError, ShutdownError, isEngineError } from '../errors.js';
import type { ProviderLogger } from './openai-compat-provider.js';

export interface ChainOptions {
  providers: readonly LlmProvider[];
  /** When a provider answers but the reply is incomplete (cut off), try the next provider. Default true. */
  fallbackOnIncomplete?: boolean;
  logger?: ProviderLogger;
  /**
   * A provider that fails with one of these codes is skipped for `cooldownMs` instead of being tried again by the
   * next stage. Keeps "Ollama first" cheap: a slow or memory-starved local model costs one timeout, not one per stage.
   */
  cooldownCodes?: readonly string[];
  cooldownMs?: number;
  now?: () => number;
}

export const DEFAULT_COOLDOWN_CODES: readonly string[] = ['OLLAMA_TIMEOUT', 'LOW_MEMORY'];

/**
 * Tries providers in order and returns the first usable reply. A provider that
 * throws is skipped (its failure is recorded), except shutdown and budget
 * errors, which stop the whole chain immediately. If every provider fails, one
 * EngineError lists each provider's failure code. If providers only produced
 * incomplete replies, the last incomplete reply is returned so the caller can
 * decide (the pipeline treats it as a failed stage).
 */
export class ChainProvider implements LlmProvider {
  readonly id: string;
  private readonly providers: readonly LlmProvider[];
  private readonly coolingUntil = new Map<string, number>();

  constructor(private readonly opts: ChainOptions) {
    if (opts.providers.length === 0) throw new RangeError('ChainProvider needs at least one provider');
    this.providers = opts.providers;
    this.id = `chain(${opts.providers.map((p) => p.id).join('>')})`;
  }

  get providerIds(): string[] {
    return this.providers.map((p) => p.id);
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    const failures: Array<{ provider: string; code: string; category: string }> = [];
    let lastIncomplete: LlmResult | undefined;
    const fallbackOnIncomplete = this.opts.fallbackOnIncomplete ?? true;

    const now = this.opts.now ?? Date.now;
    for (const provider of this.providers) {
      const until = this.coolingUntil.get(provider.id) ?? 0;
      if (until > now()) {
        failures.push({ provider: provider.id, code: 'COOLING_DOWN', category: 'retryable' });
        this.opts.logger?.warn({ provider: provider.id, secondsLeft: Math.round((until - now()) / 1000) }, 'provider skipped: cooling down after a timeout or low memory');
        continue;
      }
      try {
        const result = await provider.generate(request);
        if (result.complete || !fallbackOnIncomplete) return result;
        lastIncomplete = result;
        failures.push({ provider: provider.id, code: 'INCOMPLETE_REPLY', category: 'retryable' });
        this.opts.logger?.warn({ provider: provider.id }, 'incomplete reply, trying next provider');
      } catch (e) {
        if (e instanceof ShutdownError || e instanceof BudgetExceededError) throw e;
        if (request.signal?.aborted) throw e;
        const code = isEngineError(e) ? e.code : 'UNEXPECTED';
        const category = isEngineError(e) ? e.category : 'unknown';
        failures.push({ provider: provider.id, code, category });
        if ((this.opts.cooldownCodes ?? DEFAULT_COOLDOWN_CODES).includes(code)) this.coolingUntil.set(provider.id, now() + (this.opts.cooldownMs ?? 600_000));
        this.opts.logger?.warn({ provider: provider.id, code }, 'provider failed, trying next');
      }
    }

    if (lastIncomplete) return lastIncomplete;
    const allRateLimited = failures.every((f) => f.category === 'rate_limited');
    throw new EngineError(
      `All text providers failed: ${failures.map((f) => `${f.provider}=${f.code}`).join(', ')}`,
      allRateLimited ? 'rate_limited' : 'retryable',
      'ALL_PROVIDERS_FAILED',
      { detail: { failures } },
    );
  }
}
