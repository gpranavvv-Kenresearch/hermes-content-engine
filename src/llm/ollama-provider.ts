import os from 'node:os';
import { Agent, fetch as undiciFetch } from 'undici';
import type { LlmProvider, LlmRequest, LlmResult } from '../contracts.js';
import { EngineError } from '../errors.js';
import { stripThinking } from './clean.js';
import type { ProviderLogger } from './openai-compat-provider.js';

export interface OllamaOptions {
  id?: string;
  baseUrl?: string;
  /** Model name. When omitted, the first installed model reported by /api/tags is used. */
  model?: string;
  fetchImpl?: typeof fetch;
  /**
   * How long the HTTP client waits for the reply to START (milliseconds, 0 = no limit). Node's built-in fetch gives up
   * after 300 s, and Ollama only answers a non-streaming call once the whole text is written, so on a slow CPU every
   * stage was cut at exactly 5 min (HTTP 500 in Ollama's log, OLLAMA_UNREACHABLE here) however high `timeoutMs` was.
   * Only used when no `fetchImpl` is given. Default 0: `timeoutMs` alone decides.
   */
  headersTimeoutMs?: number;
  timeoutMs?: number;
  temperature?: number;
  defaultMaxTokens?: number;
  /** Context window. Ollama's own default (4096) silently cuts the start off a long prompt, which is where the brand rules sit. Default 8192. */
  numCtx?: number;
  /** How long the model stays loaded after a call (so the next stage does not reload it). Default 30m. */
  keepAlive?: string;
  /**
   * Refuse to LOAD a model when less than this much RAM is free. A model that
   * is already loaded is always allowed. Protects a busy machine (the live
   * posting daemon runs many Chrome windows) from being starved. Default 3000.
   */
  minFreeMemoryMB?: number;
  freeMemoryMB?: () => number;
  rejectOutput?: (text: string) => string | null;
  logger?: ProviderLogger;
}

/**
 * Local Ollama through its native /api/chat (not the OpenAI shim) so that
 * `think: false` can switch off reasoning for models like Qwen3. Free, no key,
 * no rate limit, but bounded by local RAM and CPU.
 */
/** A fetch that does not give up on a slow reply after Node's default 5 minutes (see OllamaOptions.headersTimeoutMs). */
function patientFetch(headersTimeoutMs: number): typeof fetch {
  const agent = new Agent({ headersTimeout: headersTimeoutMs, bodyTimeout: 0, connectTimeout: 10_000 });
  return ((url: unknown, init?: unknown) => undiciFetch(url as never, { ...(init as object), dispatcher: agent } as never)) as unknown as typeof fetch;
}

export class OllamaProvider implements LlmProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private resolvedModel: string | undefined;

  constructor(private readonly opts: OllamaOptions = {}) {
    this.id = opts.id ?? 'ollama';
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? patientFetch(opts.headersTimeoutMs ?? 0);
    this.resolvedModel = opts.model;
  }

  private async getJson<T>(path: string, timeoutMs: number): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private unreachable(cause: unknown): EngineError {
    return new EngineError(`${this.id}: Ollama is not reachable at ${this.baseUrl}`, 'retryable', 'OLLAMA_UNREACHABLE', { cause });
  }

  async resolveModel(): Promise<string> {
    if (this.resolvedModel) return this.resolvedModel;
    let tags: { models?: Array<{ name?: string }> };
    try {
      tags = await this.getJson('/api/tags', 5_000);
    } catch (e) {
      throw this.unreachable(e);
    }
    const first = tags.models?.find((m) => typeof m.name === 'string')?.name;
    if (!first) throw new EngineError(`${this.id}: no models installed in Ollama`, 'fatal', 'OLLAMA_NO_MODEL');
    this.resolvedModel = first;
    return first;
  }

  async isModelLoaded(model: string): Promise<boolean> {
    try {
      const ps = await this.getJson<{ models?: Array<{ name?: string; model?: string }> }>('/api/ps', 3_000);
      return (ps.models ?? []).some((m) => m.name === model || m.model === model);
    } catch {
      return false;
    }
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    const started = Date.now();
    const model = await this.resolveModel();

    const minFree = this.opts.minFreeMemoryMB ?? 3000;
    const freeMB = (this.opts.freeMemoryMB ?? (() => os.freemem() / (1024 * 1024)))();
    if (freeMB < minFree && !(await this.isModelLoaded(model))) {
      throw new EngineError(
        `${this.id}: not loading "${model}" with only ${Math.round(freeMB)} MB RAM free (needs ${minFree} MB)`,
        'retryable',
        'LOW_MEMORY',
        { detail: { freeMB: Math.round(freeMB), minFree, model } },
      );
    }

    const signals: AbortSignal[] = [AbortSignal.timeout(this.opts.timeoutMs ?? 900_000)];
    if (request.signal) signals.push(request.signal);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: request.prompt }],
          stream: false,
          think: false,
          keep_alive: this.opts.keepAlive ?? '30m',
          options: {
            num_ctx: this.opts.numCtx ?? 8192,
            temperature: this.opts.temperature ?? 0.7,
            num_predict: request.maxOutputTokens ?? this.opts.defaultMaxTokens ?? 800,
          },
        }),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (request.signal?.aborted) throw new EngineError(`${this.id}: request aborted`, 'fatal', 'ABORTED', { cause: e });
      const causeCode = (e as { cause?: { code?: string } }).cause?.code;
      if ((e as Error).name === 'TimeoutError' || causeCode === 'UND_ERR_HEADERS_TIMEOUT' || causeCode === 'UND_ERR_BODY_TIMEOUT') {
        throw new EngineError(`${this.id}: generation timed out`, 'retryable', 'OLLAMA_TIMEOUT', { cause: e });
      }
      throw this.unreachable(e);
    }

    if (res.status === 404) {
      throw new EngineError(`${this.id}: model "${model}" is not installed`, 'fatal', 'OLLAMA_MODEL_MISSING', { detail: { model } });
    }
    if (!res.ok) {
      throw new EngineError(`${this.id}: HTTP ${res.status}`, res.status >= 500 ? 'retryable' : 'fatal', 'OLLAMA_HTTP', { detail: { status: res.status } });
    }

    let data: { message?: { content?: unknown }; done_reason?: string };
    try {
      data = (await res.json()) as typeof data;
    } catch (e) {
      throw new EngineError(`${this.id}: unreadable reply`, 'retryable', 'OLLAMA_BAD_JSON', { cause: e });
    }
    const raw = typeof data.message?.content === 'string' ? data.message.content : '';
    const text = stripThinking(raw);
    if (text === '') throw new EngineError(`${this.id}: empty or reasoning-only reply`, 'retryable', 'OLLAMA_EMPTY');
    const rejection = this.opts.rejectOutput?.(text) ?? null;
    if (rejection) throw new EngineError(`${this.id}: unusable output (${rejection})`, 'retryable', 'OLLAMA_BAD_OUTPUT', { detail: { code: rejection } });

    return {
      text,
      complete: data.done_reason !== 'length',
      provider: `${this.id}:${model}`,
      elapsedMs: Date.now() - started,
    };
  }
}
