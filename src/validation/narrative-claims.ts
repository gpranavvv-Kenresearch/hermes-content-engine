import type { Fact, ValidationIssue } from '../schemas/index.js';
import { issue } from './checks/context.js';

/**
 * The numeric claim checker only sees numbers. A model given two facts will
 * happily add plausible-sounding causes ("driven by regulatory tightening"),
 * policy claims, supply/demand statements and comparisons that no fact states.
 * This check flags those sentences unless the facts themselves contain the
 * same term.
 *
 * It is a lexical heuristic: it catches the common fabrication patterns, it
 * does not understand meaning. A paraphrased invention can still slip through,
 * and a legitimate sentence that happens to use one of the words is flagged
 * (the rewrite loop then removes it or a human decides). It only runs when
 * facts were supplied.
 */

const CAUSAL_RE =
  /\b(driven by|drivers? (?:are|is|include|includes)|due to|because of|owing to|as a result of|thanks to|fuell?ed by|propelled by|underpinned by|stems? from|attributed to|prompted by)\b/i;

const DOMAIN_RE =
  /\b(regulat\w*|tariffs?|subsid\w*|incentives?|compliance|legislat\w*|polic(?:y|ies)|government\w*|ministr\w*|consolidat\w*|barriers? to entry|price wars?|supply (?:is|are|was|were)|demand (?:is|are|remains?|was|were))\b/gi;

const COMPARISON_RE =
  /\b(faster than|slower than|outpac(?:es|ed|ing)|outperform\w*|ahead of|than the (?:average|global|regional|industry|sector)|above the (?:average|industry)|below the (?:average|industry))\b/i;

const MULTIPLIER_RE = /\b(doubles?|doubled|doubling|triples?|tripled|quadruples?|quadrupled|halves|halved)\b/i;

// "mid-single-digit", "high single digit", "double-digit": a qualitative label for a growth rate that
// must fit the CAGR facts. Bands: low 1-4, mid 4-7, high 7-10 (single digit); 10+ is double digit.
const GROWTH_BAND_RE = /\b(?:(low|mid|high)[- ]?)?(single|double)[- ]digit\b/gi;

function bandFits(label: string | undefined, kind: string, value: number): boolean {
  if (kind === 'double') return value >= 10 && value < 100;
  if (value < 1 || value >= 10) return false;
  if (!label) return true;
  if (label === 'low') return value < 4;
  if (label === 'mid') return value >= 4 && value < 7;
  return value >= 7; // high
}

function factsText(facts: readonly Fact[]): string {
  return facts
    .flatMap((f) => [f.sourceQuote, f.sourceTitle, f.marketDefinition, f.metric])
    .filter((s): s is string => typeof s === 'string')
    .join(' ')
    .toLowerCase();
}

function sentences(text: string): string[] {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const excerpt = (s: string): string => (s.length > 140 ? `${s.slice(0, 137)}...` : s);

const STOP = new Set(['which', 'their', 'there', 'these', 'those', 'where', 'while', 'would', 'could', 'should', 'about', 'other', 'being', 'through', 'market']);

function significantWords(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z]{5,}/g) ?? []).filter((w) => !STOP.has(w)));
}

/**
 * A causal sentence is allowed when a source note says the same thing in other words: it shares at
 * least three significant words (5+ letters) with one note ("driven by higher employer adoption of
 * digital recruitment" vs the note "supported by higher employer adoption of digital recruitment").
 */
function restatesNote(sentence: string, notes: readonly string[]): boolean {
  const words = significantWords(sentence);
  return notes.some((note) => {
    let shared = 0;
    for (const w of significantWords(note)) if (words.has(w)) shared++;
    return shared >= 3;
  });
}

// Opinion / advice verbs. "Ken Research positions this as...", "Ken Research recommends..." credit the brand
// with a view that no fact or source note states. (Neutral reporting verbs such as "finds" are fine.)
const ATTRIBUTION_RE =
  /\bKen Research\s+(?:\w+\s+)?(positions|recommends|advises|believes|suggests|sees|views|argues|urges|expects|predicts|warns|considers|calls|labels)\b/i;

/**
 * @param notes source-note texts from the report page. They count as known statements, so a driver or
 *              challenge that appears in a note is not flagged.
 */
export function checkNarrativeClaims(text: string, facts: readonly Fact[], notes: readonly string[] = []): ValidationIssue[] {
  if (facts.length === 0 && notes.length === 0) return [];
  const known = `${factsText(facts)} ${notes.join(' ').toLowerCase()}`;
  const cagrValues = facts.filter((f) => f.metric === 'cagr').map((f) => f.value);
  const issues: ValidationIssue[] = [];

  for (const sentence of sentences(text)) {
    const lower = sentence.toLowerCase();
    const reasons: string[] = [];

    // A question asks, it does not assert: only statements can carry an unsupported claim.
    const isQuestion = sentence.trim().endsWith('?');
    if (!isQuestion) {
      if (CAUSAL_RE.test(sentence) && !CAUSAL_RE.test(known) && !restatesNote(sentence, notes)) reasons.push('states a cause or driver');
      const unknownTerms = [...sentence.matchAll(DOMAIN_RE)]
        .map((m) => m[0].toLowerCase())
        .filter((term) => !known.includes(term.split(/\s+/)[0]!.slice(0, 6)));
      if (unknownTerms.length > 0) reasons.push(`mentions ${[...new Set(unknownTerms)].join(', ')}`);
      if (COMPARISON_RE.test(sentence) && !COMPARISON_RE.test(known)) reasons.push('makes a comparison');
    }
    for (const m of sentence.matchAll(GROWTH_BAND_RE)) {
      const fits = cagrValues.some((v) => bandFits(m[1]?.toLowerCase(), m[2]!.toLowerCase(), v));
      if (!fits) {
        reasons.push(
          cagrValues.length === 0
            ? `calls growth "${m[0]}" but no growth rate is supplied`
            : `calls growth "${m[0]}" but the growth rate is ${cagrValues.join('%, ')}%`,
        );
      }
    }

    if (reasons.length > 0) {
      issues.push(
        issue(
          'UNSUPPORTED_NARRATIVE_CLAIM',
          'hard_fail',
          `This sentence ${reasons.join(' and ')} that the FACTS do not state: "${excerpt(sentence)}". Remove it or restate it using only the facts.`,
          { sentence: excerpt(sentence), reasons },
        ),
      );
    }
    const attribution = sentence.match(ATTRIBUTION_RE);
    if (attribution && !known.includes(attribution[1]!.toLowerCase())) {
      issues.push(
        issue(
          'UNSUPPORTED_ATTRIBUTION',
          'hard_fail',
          `This sentence credits Ken Research with a view ("${attribution[1]}") that the facts and source notes do not contain: "${excerpt(sentence)}". Attribute only the facts and source notes to Ken Research; phrase your own interpretation as a consideration for the reader.`,
          { sentence: excerpt(sentence), verb: attribution[1] },
        ),
      );
    }
    const mult = lower.match(MULTIPLIER_RE);
    if (mult && !known.includes(mult[0])) {
      issues.push(
        issue(
          'UNSUPPORTED_MULTIPLIER_CLAIM',
          'hard_fail',
          `This sentence describes a growth multiple ("${mult[0]}") that no fact states: "${excerpt(sentence)}". State only the figures from the FACTS.`,
          { sentence: excerpt(sentence), word: mult[0] },
        ),
      );
    }
  }
  return issues;
}
