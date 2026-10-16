import type { Fact, ValidationIssue } from '../../schemas/index.js';
import { MIN_DATA_YEAR, yearsInText, yearsOf } from '../../utils/years.js';
import { issue } from './context.js';

/**
 * STALE_YEAR: the text names a year before MIN_DATA_YEAR (old data is not quoted).
 * UNSUPPORTED_YEAR: the text names a year that no supplied fact or source note carries (when a fact
 * has no period, no year may be written for it). Runs on plain text; skipped when no facts are supplied.
 */
export function checkYears(plain: string, facts: readonly Fact[], notes: readonly string[] = [], min: number = MIN_DATA_YEAR): ValidationIssue[] {
  const used = [...new Set(yearsInText(plain))];
  const issues: ValidationIssue[] = [];

  const stale = used.filter((y) => y < min);
  if (stale.length > 0) {
    issues.push(
      issue('STALE_YEAR', 'hard_fail', `The text mentions ${stale.join(', ')}. Never quote data or years before ${min}; remove that statement or the year.`, { years: stale }),
    );
  }

  if (facts.length > 0) {
    const allowed = new Set<number>([...facts.flatMap((f) => yearsOf(f.period)), ...notes.flatMap((n) => yearsInText(n))]);
    const unsupported = used.filter((y) => y >= min && !allowed.has(y));
    if (unsupported.length > 0) {
      issues.push(
        issue(
          'UNSUPPORTED_YEAR',
          'hard_fail',
          `The text mentions ${unsupported.join(', ')}, which no supplied fact carries. Use a year only exactly as it appears in the FACTS; if a fact has no period, write no year.`,
          { years: unsupported },
        ),
      );
    }
  }
  return issues;
}
