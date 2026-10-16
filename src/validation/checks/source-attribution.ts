import type { Fact, SourceNote, ValidationIssue } from '../../schemas/index.js';
import { ATTRIBUTION_RE, contentWords } from './content-sanity.js';
import { issue } from './context.js';

/**
 * Attribution of supplementary evidence (facts and notes that did not come from the report page itself):
 *  - SOURCE_NOT_NAMED: a figure from a government page must appear in a sentence that names that body, so it is
 *    never read as Ken Research's own number.
 *  - SOURCE_SCOPE_MISSING: a figure from ANOTHER Ken Research report must state its scope (geography or the report's
 *    market), so a global figure is never passed off as this report's figure.
 *  - MISATTRIBUTED_NOTE: a sentence that restates neutral background from a non-Ken, non-government page must not
 *    carry a Ken Research attribution ("Ken Research notes...").
 * Runs on PLAIN text. Facts and notes from the report page carry no tier and are not touched.
 */

const sentencesOf = (plain: string): string[] =>
  plain
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ways a fact's number is written in a post (7.2, 7.20, 3,709 ...). */
function numberVariants(f: Fact): string[] {
  const v = f.value;
  const set = new Set<string>([String(v), v.toFixed(1), v.toFixed(2), v.toLocaleString('en-US'), v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })]);
  if (Number.isInteger(v)) set.add(v.toLocaleString('en-US'));
  return [...set].filter((s) => s.length > 0);
}

function sentencesWithFigure(sentences: readonly string[], f: Fact): string[] {
  const re = new RegExp(`(?<![\\d.,])(?:${numberVariants(f).map(escapeRe).join('|')})(?![\\d])`);
  return sentences.filter((s) => re.test(s));
}

const nameTokens = (name: string): string[] => [...contentWords(name)].filter((w) => w.length >= 3);

function mentionsName(sentence: string, name: string): boolean {
  const lower = sentence.toLowerCase();
  if (lower.includes(name.toLowerCase())) return true;
  const tokens = nameTokens(name);
  if (tokens.length === 0) return false;
  const hits = tokens.filter((t) => lower.includes(t)).length;
  return hits >= Math.min(2, tokens.length);
}

export function checkSourceAttribution(plain: string, facts: readonly Fact[], notes: readonly SourceNote[] = []): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sentences = sentencesOf(plain);

  // The same number can come from several facts (the same report listed twice, a CAGR with and without a geography):
  // a sentence is fine when ANY fact with that number is attributed correctly in it.
  const byValue = new Map<number, Fact[]>();
  for (const f of facts) {
    if (f.sourceTier) byValue.set(f.value, [...(byValue.get(f.value) ?? []), f]);
  }
  const scopeOk = (f: Fact, sentence: string): boolean =>
    f.sourceTier === 'government'
      ? !f.sourceName || mentionsName(sentence, f.sourceName)
      : [f.geography, f.sourceName].filter((x): x is string => Boolean(x)).some((w) => mentionsName(sentence, w));
  for (const group of byValue.values()) {
    const f = group[0]!;
    const bad = sentencesWithFigure(sentences, f).find((s) => !group.some((g) => scopeOk(g, s)));
    if (!bad) continue;
    if (group.every((g) => g.sourceTier === 'government')) {
      issues.push(
        issue('SOURCE_NOT_NAMED', 'hard_fail', `The figure ${f.value} comes from ${f.sourceName ?? 'a government body'} (government/regulatory). Name it in the same sentence, and do not attribute it to Ken Research: "${bad.slice(0, 120)}"`, {
          factId: f.id,
          source: f.sourceName,
        }),
      );
    } else {
      issues.push(
        issue('SOURCE_SCOPE_MISSING', 'hard_fail', `The figure ${f.value} is from a different Ken Research report ("${f.sourceName ?? f.sourceTitle}"). State its scope (${f.geography ?? 'its market'}) in the sentence: "${bad.slice(0, 120)}"`, {
          factId: f.id,
        }),
      );
    }
  }

  const other = notes.filter((n) => n.tier === 'other');
  if (other.length > 0) {
    const everyNote = notes.map((n) => ({ n, words: contentWords(n.text) }));
    for (const s of sentences) {
      if (!ATTRIBUTION_RE.test(s)) continue;
      const sw = contentWords(s);
      if (sw.size === 0) continue;
      let best: { tier: string | undefined; shared: number; ratio: number } | undefined;
      for (const { n, words } of everyNote) {
        const shared = [...sw].filter((w) => words.has(w)).length;
        const ratio = shared / sw.size;
        if (!best || ratio > best.ratio) best = { tier: n.tier, shared, ratio };
      }
      if (best && best.tier === 'other' && best.shared >= 4 && best.ratio >= 0.5) {
        issues.push(
          issue('MISATTRIBUTED_NOTE', 'hard_fail', `This sentence restates neutral background from another source but attributes it to Ken Research. State it as a plain neutral statement, without "Ken Research notes/says": "${s.slice(0, 120)}"`),
        );
      }
    }
  }
  return issues;
}
