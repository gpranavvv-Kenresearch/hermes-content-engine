import {
  BrokenCircuitError,
  CircuitState,
  ConsecutiveBreaker,
  DelegateBackoff,
  circuitBreaker,
  handleWhen,
  retry,
  wrap,
} from 'cockatiel';
import { EngineError, isEngineError } from '../errors.js';

// --- Error classification ------------------------------------------------------

const CLOSED_RE =
  /target (page, context or browser )?has been closed|target closed|browser has been closed|page has been closed|page closed|context or browser has been closed|execution context was destroyed|browser closed|connection closed|session closed/i;
const CHALLENGE_RE = /captcha|verify you are human|are you a robot|checking your browser|cloudflare|challenge/i;
const LOGIN_RE = /login required|log in required|not logged in|logged out|session (has )?expired|sign in to continue|log in to continue|auth_required/i;
const RATE_LIMIT_RE =
  /too many requests|rate[- ]?limit|making requests too quickly|reached (our|the|your) (current )?(usage |message |daily )?(limit|cap)|usage (limit|cap)/i;

const UNIT_MS: Record<string, number> = {
  second: 1000,
  sec: 1000,
  minute: 60_000,
  min: 60_000,
  hour: 3_600_000,
  hr: 3_600_000,
  day: 86_400_000,
};

/** Parses "try again in 15 minutes" / "after about 2 hours" style text. Returns undefined when absent. */
export function parseRetryAfterMs(text: string): number | undefined {
  const m = /(?:in|after)\s+(?:about\s+|around\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i.exec(text);
  if (!m) return undefined;
  const unit = m[2]!.toLowerCase().replace(/s$/, '');
  const mult = UNIT_MS[unit];
  return mult === undefined ? undefined : Math.round(Number(m[1]) * mult);
}

/**
 * Maps whatever a browser step threw to an EngineError category.
 * - closed target / page            -> retryable, detail.needsRelaunch
 * - Playwright TimeoutError         -> retryable
 * - SelectorNotFoundError           -> needs_human (already an EngineError, kept)
 * - login wall                      -> auth_required
 * - captcha / challenge             -> needs_human
 * - rate-limit text                 -> rate_limited (+ retryAfterMs when parseable)
 * - anything else                   -> unknown (never retried)
 */
export function classifyBrowserError(e: unknown): EngineError {
  if (isEngineError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  const name = e instanceof Error ? e.name : '';

  if (name === 'TargetClosedError' || CLOSED_RE.test(message)) {
    return new EngineError(`Browser/page closed: ${message}`, 'retryable', 'BROWSER_CLOSED', {
      cause: e,
      detail: { needsRelaunch: true },
    });
  }
  if (name === 'TimeoutError' || /timeout \d+ms exceeded/i.test(message)) {
    return new EngineError(`Browser step timed out: ${message}`, 'retryable', 'BROWSER_TIMEOUT', { cause: e });
  }
  if (CHALLENGE_RE.test(message)) {
    return new EngineError(`Challenge/captcha encountered: ${message}`, 'needs_human', 'CHALLENGE', { cause: e });
  }
  if (LOGIN_RE.test(message)) {
    return new EngineError(`Login required: ${message}`, 'auth_required', 'LOGIN_REQUIRED', { cause: e });
  }
  if (RATE_LIMIT_RE.test(message)) {
    const retryAfterMs = parseRetryAfterMs(message);
    return new EngineError(`Rate limited: ${message}`, 'rate_limited', 'RATE_LIMITED', {
      cause: e,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  return new EngineError(`Unclassified browser error: ${message}`, 'unknown', 'BROWSER_UNKNOWN', { cause: e });
}

export function needsRelaunch(e: EngineError): boolean {
  return e.detail?.needsRelaunch === true;
}

// --- Retry + circuit breaker -----------------------------------------------------

export interface RecoveryOptions {
  /** Total attempts per execute() (first try + retries). Default 3. */
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** Consecutive failures that pause the account. Default 5. */
  breakerThreshold?: number;
  breakerHalfOpenAfterMs?: number;
  /** Wait used for rate_limited errors that carry no parseable retry-after. */
  rateLimitDefaultWaitMs?: number;
  /** A rate-limit wait longer than this is not waited out; the error is surfaced instead. */
  rateLimitMaxWaitMs?: number;
  /** Injectable for deterministic jitter in tests. */
  random?: () => number;
}

export type BreakerState = 'closed' | 'open' | 'half_open' | 'isolated';

export interface AttemptContext {
  /** 1-based attempt number within this execute(). */
  attempt: number;
}

/**
 * Wraps one generation in a cockatiel retry (bounded exponential backoff with
 * jitter) around a shared circuit breaker.
 * - Only `retryable` errors are retried. auth_required, needs_human, fatal and
 *   unknown are NEVER retried.
 * - rate_limited waits (retry-after, capped) and allows at most ONE retry.
 * - N consecutive failures open the breaker: the account is paused and
 *   execute() fails fast with ACCOUNT_PAUSED until the half-open probe.
 * The breaker is per policy instance, so share one instance per account.
 */
export class RecoveryPolicy {
  private readonly cfg: Required<Omit<RecoveryOptions, 'random'>> & { random: () => number };
  private readonly breaker;

  constructor(options: RecoveryOptions = {}) {
    this.cfg = {
      maxAttempts: options.maxAttempts ?? 3,
      initialDelayMs: options.initialDelayMs ?? 2_000,
      maxDelayMs: options.maxDelayMs ?? 30_000,
      breakerThreshold: options.breakerThreshold ?? 5,
      breakerHalfOpenAfterMs: options.breakerHalfOpenAfterMs ?? 10 * 60_000,
      rateLimitDefaultWaitMs: options.rateLimitDefaultWaitMs ?? 60_000,
      rateLimitMaxWaitMs: options.rateLimitMaxWaitMs ?? 30 * 60_000,
      random: options.random ?? Math.random,
    };
    this.breaker = circuitBreaker(handleWhen((e) => isEngineError(e) && e.category !== 'fatal'), {
      breaker: new ConsecutiveBreaker(this.cfg.breakerThreshold),
      halfOpenAfter: this.cfg.breakerHalfOpenAfterMs,
    });
  }

  get breakerState(): BreakerState {
    switch (this.breaker.state) {
      case CircuitState.Closed:
        return 'closed';
      case CircuitState.Open:
        return 'open';
      case CircuitState.HalfOpen:
        return 'half_open';
      default:
        return 'isolated';
    }
  }

  /** True while the account is paused (breaker open or isolated). */
  get isPaused(): boolean {
    const s = this.breakerState;
    return s === 'open' || s === 'isolated';
  }

  /** Backoff delay for the n-th retry (1-based): bounded exponential with jitter in [50%, 100%]. */
  private backoffMs(attempt: number): number {
    const base = Math.min(this.cfg.maxDelayMs, this.cfg.initialDelayMs * 2 ** (attempt - 1));
    return Math.max(0, Math.round(base * (0.5 + this.cfg.random() * 0.5)));
  }

  private rateLimitWaitMs(e: EngineError): number {
    return e.retryAfterMs ?? this.cfg.rateLimitDefaultWaitMs;
  }

  async execute<T>(fn: (ctx: AttemptContext) => Promise<T>): Promise<T> {
    let rateLimitRetriesUsed = 0;

    const shouldRetry = (e: unknown): boolean => {
      if (!isEngineError(e)) return false;
      if (e.category === 'retryable') return true;
      if (e.category === 'rate_limited') {
        if (rateLimitRetriesUsed >= 1) return false;
        if (this.rateLimitWaitMs(e) > this.cfg.rateLimitMaxWaitMs) return false;
        rateLimitRetriesUsed++;
        return true;
      }
      return false; // auth_required, needs_human, fatal, unknown: never retried
    };

    const retryPolicy = retry(handleWhen(shouldRetry), {
      maxAttempts: Math.max(0, this.cfg.maxAttempts - 1),
      backoff: new DelegateBackoff((ctx) => {
        const failure = 'error' in ctx.result ? ctx.result.error : undefined;
        if (isEngineError(failure) && failure.category === 'rate_limited') {
          return Math.min(this.rateLimitWaitMs(failure), this.cfg.rateLimitMaxWaitMs);
        }
        return this.backoffMs(ctx.attempt);
      }),
    });

    let attempt = 0;
    try {
      return await wrap(retryPolicy, this.breaker).execute(async () => {
        attempt++;
        try {
          return await fn({ attempt });
        } catch (e) {
          throw classifyBrowserError(e);
        }
      });
    } catch (e) {
      if (e instanceof BrokenCircuitError) {
        throw new EngineError(
          `ChatGPT account paused: circuit breaker open after ${this.cfg.breakerThreshold} consecutive failures`,
          'needs_human',
          'ACCOUNT_PAUSED',
          { cause: e },
        );
      }
      throw classifyBrowserError(e);
    }
  }
}

export function createRecoveryPolicy(options: RecoveryOptions = {}): RecoveryPolicy {
  return new RecoveryPolicy(options);
}
