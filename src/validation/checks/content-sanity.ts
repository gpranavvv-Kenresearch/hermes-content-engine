import type { Fact, ValidationIssue } from '../../schemas/index.js';
import { findFigures } from '../../utils/figures.js';
import { issue } from './context.js';

/**
 * Content sanity: deterministic checks on how good the post is as writing, on top of the compliance
 * checks (competitors, numbers, years, layout). Each check has a fixed id, a severity and a plain label,
 * so a run can show one row per check (pass / warn / fail) instead of a single pass flag.
 *
 * What the checks come from:
 *  - Princeton GEO study (arXiv 2311.09735, KDD 2024): content that carries real statistics, named
 *    sources and fluent prose is cited more by AI answer engines; repeated keywords do not help. Only
 *    those findings are used. The study's own prompts ask for invented quotes, statistics and sources,
 *    which this engine never does: every figure must be a verified fact.
 *  - Failures seen in real runs of this engine: two list points saying the same thing, the same lead-in
 *    phrase repeated in every point, "7.20%" where the source says 7.2, and sentences with no basis in
 *    the report.
 *
 * Runs on PLAIN text (bold and spacers already removed).
 */

export type SanityStatus = 'pass' | 'warn' | 'fail';

export interface SanityRow {
  code: string;
  label: string;
  severity: 'hard_fail' | 'review';
  status: SanityStatus;
  detail?: string;
}

interface SanityInput {
  plain: string;
  facts: readonly Fact[];
  notes: readonly string[];
}

interface SanityCheck {
  code: string;
  label: string;
  severity: 'hard_fail' | 'review';
  /** Returns a message when the check fails, otherwise undefined. */
  run(input: SanityInput, ctx: Parsed): { message: string; detail?: Record<string, unknown>; severity?: 'hard_fail' | 'review' } | undefined;
}

// --- text helpers --------------------------------------------------------------------

const LIST_MARKER_RE = /^\s*(?:\d{1,2}[.)]|[•\-*])\s+/;
const HASHTAG_LINE_RE = /^(?:\s*#[\p{L}\p{N}_]+)+\s*$/u;
const URL_LINE_RE = /^\s*https?:\/\/\S+\s*$/;
const BOILERPLATE_RE = /full market breakdown|review the full|full report|full data/i;
const LABEL_RE = /^(?:myth|reality):\s*/i;

const STOP = new Set(
  'about above after again also among and are because been before being between both but can could did does doing down during each for from further had has have having here how into its itself just more most much must not now off once only other our out over own same should some such than that the their them then there these they this those through under until very was were what when where which while who whom will with within without would you your'.split(
    ' ',
  ),
);

const words = (s: string): string[] => (s.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? []).map((w) => w.replace(/['’]s$/, ''));
export const contentWords = (s: string): Set<string> => new Set(words(s).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)));

interface Parsed {
  /** Paragraphs that are real body text (hashtags, bare links and the fixed "review the full..." line removed). */
  blocks: string[];
  /** The list points, marker removed. */
  points: string[];
  /** Body sentences (labels and markers removed), questions kept apart. */
  sentences: string[];
}

function parse(plain: string): Parsed {
  const lines = plain
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !HASHTAG_LINE_RE.test(l) && !URL_LINE_RE.test(l) && !BOILERPLATE_RE.test(l));
  const points = lines.filter((l) => LIST_MARKER_RE.test(l)).map((l) => l.replace(LIST_MARKER_RE, ''));
  const blocks = lines.map((l) => l.replace(LIST_MARKER_RE, '').replace(LABEL_RE, ''));
  const sentences = blocks
    .flatMap((b) => b.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/))
    .map((s) => s.trim())
    .filter(Boolean);
  return { blocks, points, sentences };
}

const isQuestion = (s: string): boolean => s.trim().endsWith('?');

// --- the checks ----------------------------------------------------------------------

const OVERLAP_LIMIT = 0.45;
const MIN_SHARED = 6;

const DUPLICATE_POINT: SanityCheck = {
  code: 'DUPLICATE_POINT',
  label: 'No two points say the same thing',
  severity: 'hard_fail',
  run(_in, { points }) {
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = contentWords(points[i]!);
        const b = contentWords(points[j]!);
        const shared = [...a].filter((w) => b.has(w)).length;
        const overlap = shared / Math.max(1, Math.min(a.size, b.size));
        if (shared >= MIN_SHARED && overlap >= OVERLAP_LIMIT) {
          return {
            message: `Points ${i + 1} and ${j + 1} repeat the same idea (${Math.round(overlap * 100)}% of the shorter one's key words are shared). Merge them or give one a different point.`,
            detail: { points: [i + 1, j + 1], overlap: Number(overlap.toFixed(2)) },
          };
        }
      }
    }
    return undefined;
  },
};

const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const COUNT_NOUNS =
  'things|factors|realities|points|reasons|signals|shifts|takeaways|drivers|moves|steps|risks|trends|insights|lessons|ways|forces|priorities|questions|findings|observations|considerations|numbers|facts|ideas|checks|implications|themes|dynamics';
const COUNT_RE = new RegExp(`\\b(two|three|four|five|six|seven|eight|nine|ten|\\d{1,2})\\s+(?:[A-Za-z-]+\\s+){0,3}(?:${COUNT_NOUNS})\\b`, 'i');

const LIST_COUNT_MISMATCH: SanityCheck = {
  code: 'LIST_COUNT_MISMATCH',
  label: 'The intro and the list agree on how many points there are',
  severity: 'hard_fail',
  run({ plain }) {
    const lines = plain.split('\n').map((l) => l.trim()).filter(Boolean);
    const first = lines.findIndex((l) => LIST_MARKER_RE.test(l));
    if (first <= 0) return undefined;
    let count = 0;
    for (let i = first; i < lines.length && LIST_MARKER_RE.test(lines[i]!); i++) count++;
    const m = COUNT_RE.exec(lines[first - 1]!);
    if (!m) return undefined;
    const said = NUMBER_WORDS[m[1]!.toLowerCase()] ?? Number(m[1]);
    if (said === count) return undefined;
    return {
      message: `The line before the list promises ${said} (${m[0]}) but the list has ${count}. Make the number match the list, or change the list.`,
      detail: { promised: said, found: count },
    };
  },
};

const REPEAT_N = 4;
const REPEAT_LIMIT = 3;

const REPEATED_PHRASE: SanityCheck = {
  code: 'REPEATED_PHRASE',
  label: 'No lead-in phrase repeated across points',
  severity: 'hard_fail',
  run(_in, { blocks }) {
    const counts = new Map<string, number>();
    for (const b of blocks) {
      const w = words(b);
      const seen = new Set<string>();
      for (let i = 0; i + REPEAT_N <= w.length; i++) {
        const gram = w.slice(i, i + REPEAT_N);
        if (gram.every((x) => STOP.has(x) || x.length < 4)) continue;
        seen.add(gram.join(' '));
      }
      for (const g of seen) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    const worst = [...counts.entries()].filter(([, n]) => n >= REPEAT_LIMIT).sort((a, b) => b[1] - a[1])[0];
    return worst
      ? { message: `The phrase "${worst[0]}" appears in ${worst[1]} different paragraphs. Vary the wording instead of repeating a stock lead-in.`, detail: { phrase: worst[0], paragraphs: worst[1] } }
      : undefined;
  },
};

const NO_VERIFIED_FIGURE: SanityCheck = {
  code: 'NO_VERIFIED_FIGURE',
  label: 'Uses at least one verified figure',
  severity: 'hard_fail',
  run({ plain, facts }) {
    if (facts.length === 0) return undefined;
    return findFigures(plain).length === 0
      ? { message: 'The post states no figure. Replace a general claim with one of the verified figures from FACTS (statistics are what readers and AI answers cite).' }
      : undefined;
  },
};

export const ATTRIBUTION_RE =
  /\bken research\b[^.!?]{0,60}\b(notes?|finds?|found|estimates?|estimated|projects?|projected|expects?|forecasts?|anticipates?|reports?|sizes?|sized|values?|valued|measures?|calculates?|assesses|tracks?|models?|places?|puts?|identifies|indicates?|shows?|sees?|highlights?|states?|points? to|analysis)\b|\b(according to|per|as per|based on)\s+ken research\b|\bken research\b\s+(analysis|data|estimates|research|report)/i;

const NO_ATTRIBUTION: SanityCheck = {
  code: 'NO_ATTRIBUTION',
  label: 'A finding is attributed to Ken Research by name',
  severity: 'review',
  run({ plain }) {
    return ATTRIBUTION_RE.test(plain)
      ? undefined
      : { message: 'No finding is attributed to Ken Research ("Ken Research finds...", "according to Ken Research..."). Name the source next to a finding, not only in a hashtag.' };
  },
};

const MAX_WORDS = 40;
const MAX_AVG_WORDS = 30; // the house reference post averages 28

const LONG_SENTENCE: SanityCheck = {
  code: 'LONG_SENTENCE',
  label: 'Sentences stay readable',
  severity: 'review',
  run(_in, { sentences }) {
    const body = sentences.filter((s) => !isQuestion(s));
    if (body.length === 0) return undefined;
    const lengths = body.map((s) => words(s).length);
    const longest = Math.max(...lengths);
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    if (longest > MAX_WORDS) return { message: `A sentence runs ${longest} words (limit ${MAX_WORDS}). Split it.`, detail: { longest } };
    if (avg > MAX_AVG_WORDS) return { message: `Sentences average ${avg.toFixed(0)} words (limit ${MAX_AVG_WORDS}). Shorten them.`, detail: { avg: Number(avg.toFixed(1)) } };
    return undefined;
  },
};

const CHOPPY: SanityCheck = {
  code: 'CHOPPY_SENTENCES',
  label: 'Prose flows (no run of very short sentences)',
  severity: 'review',
  run(_in, { blocks }) {
    for (const b of blocks) {
      const parts = b.split(/(?<=[.!?])\s+/).filter(Boolean);
      let run = 0;
      for (const p of parts) {
        run = words(p).length <= 5 ? run + 1 : 0;
        if (run >= 3) return { message: 'Three or more very short sentences in a row read as choppy. Join them into one fluent sentence.' };
      }
    }
    return undefined;
  },
};

const REPETITIVE_OPENERS: SanityCheck = {
  code: 'REPETITIVE_OPENERS',
  label: 'Points do not all start the same way',
  severity: 'review',
  run(_in, { points }) {
    if (points.length < 3) return undefined;
    const counts = new Map<string, number>();
    for (const p of points) {
      const w = words(p).slice(0, 2).join(' ');
      if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
    const worst = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return worst && worst[1] >= 3 ? { message: `${worst[1]} points start with "${worst[0]}". Vary how the points open.`, detail: { opener: worst[0] } } : undefined;
  },
};

const decimals = (s: string): number => (s.split('.')[1] ?? '').length;

const FIGURE_PRECISION: SanityCheck = {
  code: 'FIGURE_PRECISION',
  label: 'Figures are written at the source precision',
  severity: 'review',
  run({ plain, facts }) {
    for (const m of plain.matchAll(/(\d+\.\d+)\s?%/g)) {
      const written = m[1]!;
      const fact = facts.find((f) => f.unit.toLowerCase().includes('percent') && Number(written) === f.value);
      if (!fact) continue;
      const sourceDecimals = fact.precision ?? decimals(String(fact.value));
      if (decimals(written) > sourceDecimals) {
        return { message: `"${written}%" is written with more decimals than the source (${fact.value.toFixed(sourceDecimals)}%). Write it exactly as the source does.`, detail: { written, source: fact.value } };
      }
    }
    return undefined;
  },
};

const GROUNDING_MIN = 0.25;
const MIN_SENTENCE_WORDS = 9;

const UNGROUNDED_SENTENCE: SanityCheck = {
  code: 'UNGROUNDED_SENTENCE',
  label: 'Statements trace back to the report',
  severity: 'review',
  run({ facts, notes }, { sentences }) {
    if (facts.length === 0 && notes.length === 0) return undefined;
    const reference = new Set<string>();
    for (const n of notes) for (const w of contentWords(n)) reference.add(w);
    for (const f of facts) for (const w of contentWords(`${f.metric.replace(/_/g, ' ')} ${f.geography ?? ''} ${f.marketDefinition ?? ''} ${f.sourceTitle}`)) reference.add(w);
    const loose = sentences.filter((s) => {
      if (isQuestion(s) || words(s).length < MIN_SENTENCE_WORDS) return false;
      if (findFigures(s).length > 0) return false; // a verified figure is checked elsewhere
      const cw = contentWords(s);
      if (cw.size === 0) return false;
      const overlap = [...cw].filter((w) => reference.has(w)).length / cw.size;
      return overlap < GROUNDING_MIN;
    });
    const body = sentences.filter((s) => !isQuestion(s) && words(s).length >= MIN_SENTENCE_WORDS).length;
    // One loose sentence is a warning. With source notes to check against, two (or a third of a long body) is a post that argues beyond its sources.
    const severity = notes.length > 0 && (loose.length >= 2 || (body >= 6 && loose.length / body >= 0.3)) ? 'hard_fail' : 'review';
    return loose.length > 0
      ? {
          severity,
          message: `${loose.length} sentence(s) have little basis in the report's facts or notes. Tie each statement to a source note or fact, or cut it: "${loose[0]!.slice(0, 120)}"`,
          detail: { sentences: loose.slice(0, 3) },
        }
      : undefined;
  },
};

export const SANITY_CHECKS: readonly SanityCheck[] = [
  DUPLICATE_POINT,
  LIST_COUNT_MISMATCH,
  REPEATED_PHRASE,
  NO_VERIFIED_FIGURE,
  NO_ATTRIBUTION,
  FIGURE_PRECISION,
  UNGROUNDED_SENTENCE,
  LONG_SENTENCE,
  CHOPPY,
  REPETITIVE_OPENERS,
];

/** One row per check, for the run report. */
export function sanityReport(plain: string, facts: readonly Fact[], notes: readonly string[] = []): SanityRow[] {
  const input: SanityInput = { plain, facts, notes };
  const parsed = parse(plain);
  return SANITY_CHECKS.map((c) => {
    const hit = c.run(input, parsed);
    return {
      code: c.code,
      label: c.label,
      severity: hit?.severity ?? c.severity,
      status: hit ? ((hit.severity ?? c.severity) === 'hard_fail' ? 'fail' : 'warn') : 'pass',
      ...(hit ? { detail: hit.message } : {}),
    };
  });
}

/** The same checks as validation issues (what the rewrite loop and the editorial pass see). */
export function checkContentSanity(plain: string, facts: readonly Fact[], notes: readonly string[] = []): ValidationIssue[] {
  const input: SanityInput = { plain, facts, notes };
  const parsed = parse(plain);
  const issues: ValidationIssue[] = [];
  for (const c of SANITY_CHECKS) {
    const hit = c.run(input, parsed);
    if (hit) issues.push(issue(c.code, hit.severity ?? c.severity, hit.message, hit.detail));
  }
  return issues;
}
