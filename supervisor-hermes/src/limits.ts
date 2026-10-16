import type { LlmProvider } from '../../src/contracts.js';
import { Budget } from '../../src/safety/budget.js';

export interface LimitOptions {
  maxHermesCalls?: number;
  maxRegenerations?: number;
  maxRetries?: number;
}

export class RunLimits {
  readonly calls: Budget;
  regenerations = 0;
  retries = 0;
  private readonly maxRegenerations: number;
  private readonly maxRetries: number;

  constructor(options: LimitOptions = {}) {
    this.calls = new Budget('hermes-calls', options.maxHermesCalls ?? 20);
    this.maxRegenerations = options.maxRegenerations ?? 2;
    this.maxRetries = options.maxRetries ?? 3;
  }

  get regenerationsLeft(): number {
    return this.maxRegenerations - this.regenerations;
  }
  get retriesLeft(): number {
    return this.maxRetries - this.retries;
  }
  canRegenerate(): boolean {
    return this.regenerations < this.maxRegenerations;
  }
  useRegeneration(): void {
    this.regenerations++;
  }
  canRetry(): boolean {
    return this.retries < this.maxRetries;
  }
  useRetry(): void {
    this.retries++;
  }
  resetRetries(): void {
    this.retries = 0;
  }
}

/** Every writer call spends one unit of the shared Hermes call budget. */
export function countedProvider(inner: LlmProvider, limits: RunLimits): LlmProvider {
  return {
    id: inner.id,
    async generate(request) {
      limits.calls.consume();
      return inner.generate(request);
    },
  };
}
