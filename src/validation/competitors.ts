import type { CompetitorEntry } from '../schemas/index.js';
import { normalizeForMatch } from '../utils/normalize.js';

export interface CompetitorMatch {
  competitor: string;
  matched: string;
  via: 'alias' | 'literal' | 'domain';
}

/**
 * Detects competitor research firms in text: by normalized alias (word-bounded),
 * by raw literal (e.g. "market.us"), and by domain name. Hard-fail material:
 * a competitor must never appear in generated output in any form.
 *
 * Limits: obfuscated spellings ("I.M.A.R.C") are not detected, and an alias
 * that is also an ordinary word could false-positive. Both are accepted; the
 * hard-fail path is cheap to review.
 */
export function buildCompetitorDetector(list: readonly CompetitorEntry[]) {
  return {
    find(text: string): CompetitorMatch[] {
      const padded = ` ${normalizeForMatch(text)} `;
      const lower = text.toLowerCase();
      const matches: CompetitorMatch[] = [];
      for (const entry of list) {
        for (const alias of entry.aliases) {
          if (padded.includes(` ${alias} `)) matches.push({ competitor: entry.name, matched: alias, via: 'alias' });
        }
        for (const literal of entry.literals) {
          if (lower.includes(literal.toLowerCase())) matches.push({ competitor: entry.name, matched: literal, via: 'literal' });
        }
        for (const domain of entry.domains) {
          if (lower.includes(domain)) matches.push({ competitor: entry.name, matched: domain, via: 'domain' });
        }
      }
      return matches;
    },
  };
}

export type CompetitorDetector = ReturnType<typeof buildCompetitorDetector>;
