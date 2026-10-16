import { BudgetExceededError } from '../errors.js';

/**
 * Hard cap on an expensive resource (ChatGPT calls, rewrite rounds, search
 * calls) for one run. consume() throws BudgetExceededError instead of letting
 * a loop run away. Everything is free-tier, so the budget protects quota and
 * stops infinite regeneration loops rather than money.
 */
export class Budget {
  private used = 0;

  constructor(
    readonly name: string,
    readonly limit: number,
  ) {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`Budget "${name}" limit must be a non-negative integer`);
  }

  consume(amount = 1): void {
    if (this.used + amount > this.limit) throw new BudgetExceededError(this.name, this.limit);
    this.used += amount;
  }

  get remaining(): number {
    return this.limit - this.used;
  }

  get spent(): number {
    return this.used;
  }
}
