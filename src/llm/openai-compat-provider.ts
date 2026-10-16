import type { LlmProvider, LlmRequest, LlmResult } from '../contracts.js';
import { EngineError } from '../errors.js';
import { KeyPool } from '../evidence/search-providers.js';
import { stripThinking } from './clean.js';
import { ModelHealth } from './model-health.js';

export interface ProviderLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface OpenAiCompatOptions {
  /** Provider id used in results and logs, e.g. 'groq'. */
  id: string;
  /** e.g. https://api.groq.com/openai/v1 (no trailing slash). */
  baseUrl: string;
  /** API keys. Rotated round-robin; never logged, never put in error messages. */
  keys: readonly string[];
  /** Model ids rotated across calls. Quarantined models are skipped. */
  models: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  temperature?: number;
  defaultMaxTokens?: number;
  /** Max (key, model) attempts per generate() call. Default: min(number of keys, 10). */
  maxAttempts?: number;
  /** Returns a short code when the output is junk (refusal, reasoning leak, prompt echo...). The attempt then rotates. */
  rejectOutput?: (text: string) => string | null;
  health?: ModelHealth;
  now?: () => number;
  rateLimitCooldownMs?: number;
  logger?: ProviderLogger;
}

type Outcome =
  | { kind: 'ok'; text: string; complete: boolean }
  | { kind: 'rate_limited' }
  | { kind: 'no_credits' }
  | { kind: 'unauthorized' }
  | { kind: 'http'; status: number }
  | { kind: 'network'; name: string }
  | { kind: 'bad'; code: string };

export interface ModelProbeResult {
  model: string;
  ms: number;
  outcome: string;
  sample?: string;
}

/**
 * OpenAI-compatible chat/completions client with key rotation (Groq,
 * OpenRouter and NVIDIA NIM all speak this). Ported behaviour from the legacy
 * callLLM: rotate on 429/402 without blaming the model, count other HTTP
 * errors against the model, reject junk output and rotate, quarantine a model
 * after repeated failures. Differences: bounded attempts, a request timeout,
 * <think> blocks are stripped instead of discarded, and a reply cut off by the
 * token limit is returned with complete=false instead of being used silently.
 */
export class OpenAiCompatProvider implements LlmProvider {
  readonly id: string;
  private readonly pool: KeyPool;
  private readonly keys: readonly string[];
  private readonly models: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly health: ModelHealth;
  private modelCursor = 0;

  constructor(private readonly opts: OpenAiCompatOptions) {
    this.id = opts.id;
    this.keys = [...new Set(opts.keys)];
    this.models = opts.models;
    this.pool = new KeyPool(this.keys, opts.now);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.health = opts.health ?? new ModelHealth(opts.now);
  }

  get keyCount(): number {
    return this.keys.length;
  }

  get modelIds(): readonly string[] {
    return this.models;
  }

  private pickModel(): string | undefined {
    for (let i = 0; i < this.models.length; i++) {
      const model = this.models[(this.modelCursor + i) % this.models.length]!;
      if (!this.health.isQuarantined(model)) {
        this.modelCursor = (this.modelCursor + i + 1) % this.models.length;
        return model;
      }
    }
    return undefined;
  }

  /** One request with one key and one model, classified. Does not touch pool or health state. */
  private async attemptOnce(key: string, model: string, request: LlmRequest): Promise<Outcome> {
    const signals: AbortSignal[] = [AbortSignal.timeout(this.opts.timeoutMs ?? 60_000)];
    if (request.signal) signals.push(request.signal);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          max_tokens: request.maxOutputTokens ?? this.opts.defaultMaxTokens ?? 800,
          temperature: this.opts.temperature ?? 0.7,
          messages: [{ role: 'user', content: request.prompt }],
        }),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (request.signal?.aborted) throw new EngineError(`${this.id}: request aborted`, 'fatal', 'ABORTED', { cause: e });
      return { kind: 'network', name: (e as Error).name };
    }

    if (res.status === 429) return { kind: 'rate_limited' };
    if (res.status === 402) return { kind: 'no_credits' };
    if (res.status === 401) return { kind: 'unauthorized' };
    if (!res.ok) return { kind: 'http', status: res.status };

    let data: { choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }> };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      return { kind: 'bad', code: 'bad_json' };
    }
    const choice = data.choices?.[0];
    const raw = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const text = stripThinking(raw);
    if (text === '') return { kind: 'bad', code: raw.trim() === '' ? 'empty' : 'reasoning_only' };
    const rejection = this.opts.rejectOutput?.(text) ?? null;
    if (rejection) return { kind: 'bad', code: rejection };
    return { kind: 'ok', text, complete: choice?.finish_reason !== 'length' };
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    if (this.keys.length === 0) throw new EngineError(`${this.id}: no API keys configured`, 'fatal', 'NO_KEYS');
    if (this.models.length === 0) throw new EngineError(`${this.id}: no models configured`, 'fatal', 'NO_MODELS');

    const started = Date.now();
    const maxAttempts = this.opts.maxAttempts ?? Math.min(this.keys.length, 10);
    const cooldown = this.opts.rateLimitCooldownMs ?? 60_000;
    const stats: AttemptStats = { attempts: 0, rateLimited: 0, network: 0, badOutput: [], httpErrors: [] };

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const key = this.pool.next();
      if (key === undefined) break;
      const model = this.pickModel();
      if (model === undefined) {
        // Say WHY: usually the models were quarantined by failures earlier in this very call.
        throw new EngineError(
          `${this.id}: every configured model is quarantined (${describeStats(stats)})`,
          'retryable',
          'MODELS_QUARANTINED',
          { detail: { provider: this.id, ...stats } },
        );
      }
      const label = `${this.id}#${this.keys.indexOf(key) + 1}`;
      stats.attempts++;

      const outcome = await this.attemptOnce(key, model, request);
      switch (outcome.kind) {
        case 'ok':
          this.health.record(model, true);
          return {
            text: outcome.text,
            complete: outcome.complete,
            provider: `${this.id}:${model}`,
            elapsedMs: Date.now() - started,
          };
        case 'rate_limited':
          stats.rateLimited++;
          this.pool.retire(key, cooldown);
          this.opts.logger?.warn({ label, model }, 'rate limited, rotating');
          break;
        case 'no_credits':
          stats.rateLimited++;
          this.pool.retire(key, 60 * 60 * 1000);
          this.opts.logger?.warn({ label, model }, 'no credits, rotating');
          break;
        case 'unauthorized':
          this.pool.retire(key, Infinity);
          stats.httpErrors.push(401);
          this.opts.logger?.warn({ label }, 'key rejected (401); retired for this process');
          break;
        case 'http':
          this.health.record(model, false);
          stats.httpErrors.push(outcome.status);
          this.opts.logger?.warn({ label, model, status: outcome.status }, 'HTTP error, rotating');
          break;
        case 'network':
          stats.network++;
          this.opts.logger?.warn({ label, model, reason: outcome.name }, 'network error, rotating');
          break;
        case 'bad':
          this.health.record(model, false);
          stats.badOutput.push(outcome.code);
          this.opts.logger?.warn({ label, model, code: outcome.code }, 'unusable output, rotating');
          break;
      }
    }

    const detail = { provider: this.id, ...stats };
    if (stats.attempts > 0 && stats.network === stats.attempts) {
      throw new EngineError(`${this.id}: network unreachable on every attempt`, 'retryable', 'NETWORK', { detail });
    }
    if (stats.rateLimited > 0 && stats.badOutput.length === 0 && stats.httpErrors.length === 0) {
      throw new EngineError(`${this.id}: every key is rate limited or out of credits`, 'rate_limited', 'ALL_KEYS_RATE_LIMITED', { detail });
    }
    throw new EngineError(
      `${this.id}: no usable reply after ${stats.attempts} attempt(s) (${describeStats(stats)})`,
      'retryable',
      'PROVIDER_EXHAUSTED',
      { detail },
    );
  }

  /** Model ids the provider says it serves (GET /models with the first key). For discovery only. */
  async listModels(): Promise<string[]> {
    const key = this.keys[0];
    if (key === undefined) throw new EngineError(`${this.id}: no API keys configured`, 'fatal', 'NO_KEYS');
    const res = await this.fetchImpl(`${this.opts.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
    });
    if (!res.ok) throw new EngineError(`${this.id}: listing models returned HTTP ${res.status}`, 'retryable', 'LIST_MODELS_FAILED', { detail: { status: res.status } });
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string').sort();
  }

  /**
   * One request per configured model, each with the first key. Shows which of
   * the configured models actually work right now, without touching key or
   * quarantine state. Uses a few free-tier requests.
   */
  async probeEachModel(request: LlmRequest): Promise<ModelProbeResult[]> {
    const key = this.keys[0];
    if (key === undefined) throw new EngineError(`${this.id}: no API keys configured`, 'fatal', 'NO_KEYS');
    const results: ModelProbeResult[] = [];
    for (const model of this.models) {
      const started = Date.now();
      const o = await this.attemptOnce(key, model, request);
      const outcome =
        o.kind === 'ok' ? (o.complete ? 'ok' : 'ok (cut off by token limit)')
        : o.kind === 'http' ? `HTTP ${o.status}`
        : o.kind === 'bad' ? `unusable: ${o.code}`
        : o.kind === 'network' ? `network error (${o.name})`
        : o.kind;
      results.push({ model, ms: Date.now() - started, outcome, ...(o.kind === 'ok' ? { sample: o.text.replace(/\s+/g, ' ').slice(0, 70) } : {}) });
    }
    return results;
  }
}

interface AttemptStats {
  attempts: number;
  rateLimited: number;
  network: number;
  badOutput: string[];
  httpErrors: number[];
}

/** Short, secret-free summary of what went wrong, e.g. "http 404x3, rate limited x1". */
function describeStats(s: AttemptStats): string {
  const parts: string[] = [];
  const count = <T>(items: T[]): string => {
    const m = new Map<T, number>();
    for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
    return [...m.entries()].map(([k, n]) => `${String(k)}x${n}`).join(',');
  };
  if (s.httpErrors.length > 0) parts.push(`http ${count(s.httpErrors)}`);
  if (s.badOutput.length > 0) parts.push(`bad output ${count(s.badOutput)}`);
  if (s.rateLimited > 0) parts.push(`rate limited x${s.rateLimited}`);
  if (s.network > 0) parts.push(`network errors x${s.network}`);
  return parts.length > 0 ? parts.join('; ') : 'no attempts made';
}
