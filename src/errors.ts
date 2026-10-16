/**
 * Error taxonomy shared across the engine. The category decides what the
 * caller may do next: retry with backoff, wait for a rate limit, stop, pause
 * the account, hand to a human, or reconcile an unknown outcome first.
 */
export type ErrorCategory =
  | 'retryable'
  | 'rate_limited'
  | 'fatal'
  | 'auth_required'
  | 'needs_human'
  | 'unknown';

export interface EngineErrorOptions {
  cause?: unknown;
  retryAfterMs?: number;
  detail?: Record<string, unknown>;
}

export class EngineError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly retryAfterMs: number | undefined;
  readonly detail: Record<string, unknown> | undefined;

  constructor(message: string, category: ErrorCategory, code: string, options: EngineErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.category = category;
    this.code = code;
    this.retryAfterMs = options.retryAfterMs;
    this.detail = options.detail;
  }
}

export class ConfigError extends EngineError {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n - ${issues.join('\n - ')}`, 'fatal', 'CONFIG_INVALID');
    this.issues = issues;
  }
}

export class BudgetExceededError extends EngineError {
  constructor(what: string, limit: number) {
    super(`Budget exceeded: ${what} (limit ${limit})`, 'fatal', 'BUDGET_EXCEEDED', { detail: { what, limit } });
  }
}

export class TimeoutError extends EngineError {
  constructor(label: string, ms: number) {
    super(`Timed out after ${ms}ms: ${label}`, 'retryable', 'TIMEOUT', { detail: { label, ms } });
  }
}

export class ShutdownError extends EngineError {
  constructor(message = 'Engine is shutting down; new work refused') {
    super(message, 'fatal', 'SHUTTING_DOWN');
  }
}

export function isEngineError(e: unknown): e is EngineError {
  return e instanceof EngineError;
}
