import type { Fact } from '../schemas/index.js';

/**
 * Year rules for everything the engine writes:
 *  - data older than MIN_DATA_YEAR is never quoted (a fact whose period starts before it is not used);
 *  - a year is only written when a usable fact (or source note) carries it. A fact without a period
 *    gives no year, and the model may not add one.
 */
export const MIN_DATA_YEAR = 2024;

export const YEAR_RE = /\b(?:19|20)\d{2}\b/g;

/** Years named in a fact period such as "2025" or "2025-2031" (empty when the fact has no period). */
export function yearsOf(period: string | undefined): number[] {
  return [...(period ?? '').matchAll(YEAR_RE)].map((m) => Number(m[0]));
}

/** True when any year the fact covers is older than `min`. Facts without a period are never stale. */
export function isStaleFact(fact: Pick<Fact, 'period'>, min: number = MIN_DATA_YEAR): boolean {
  return yearsOf(fact.period).some((y) => y < min);
}

/** Years in plain text, URLs excluded (a link may legitimately contain digits). */
export function yearsInText(text: string): number[] {
  const noUrls = text.replace(/https?:\/\/\S+/gi, ' ');
  return [...noUrls.matchAll(YEAR_RE)].map((m) => Number(m[0]));
}
