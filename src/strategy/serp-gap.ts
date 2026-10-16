import { JSDOM } from 'jsdom';
import { competitors as defaultCompetitors } from '../config/competitors.config.js';
import type { CompetitorEntry } from '../schemas/index.js';
import { normalizeForMatch } from '../utils/normalize.js';

/**
 * SERP gap analysis. PLANNING ONLY. Output is a list of GENERIC topical
 * statements ("add a section on X"). It never copies a page title, URL or
 * quoted sentence: only short topic terms (1 to 2 words) and capitalised
 * entity names (2 to 3 words) derived from headings are used, and a term
 * that equals a whole 3+ word heading is dropped.
 */

export function extractHeadings(html: string): string[] {
  const dom = new JSDOM(html);
  try {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const el of dom.window.document.querySelectorAll('h1, h2, h3')) {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text && !seen.has(text)) {
        seen.add(text);
        out.push(text);
      }
    }
    return out;
  } finally {
    dom.window.close();
  }
}

const STOPWORDS = new Set(
  'a an and are as at be by for from has have how in into is it its of on or that the their this to was what when where which who why will with your you our we vs versus than then there these those can could should would may might about across after over under between within without'.split(
    ' ',
  ),
);
const FILLER = new Set(
  'guide overview introduction intro best top tips tip complete ultimate everything need know new latest update updates report reports analysis insights insight faq faqs summary conclusion final thoughts key takeaways part chapter read more'.split(
    ' ',
  ),
);

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

interface Tok {
  stem: string;
  surface: string;
}

/** Content tokens; stopwords, filler and numbers become null so bigrams never bridge them. */
function tokenize(heading: string): Array<Tok | null> {
  return heading
    .toLowerCase()
    .replace(/'s/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 2 && !/\d/.test(w) && !STOPWORDS.has(w) && !FILLER.has(w) ? { stem: stem(w), surface: w } : null));
}

/** key = stem form, value = display form (first surface seen). Unigrams plus adjacent bigrams. */
function termsOf(heading: string): Map<string, string> {
  const toks = tokenize(heading);
  const out = new Map<string, string>();
  toks.forEach((t, i) => {
    if (!t) return;
    if (!out.has(t.stem)) out.set(t.stem, t.surface);
    const next = toks[i + 1];
    if (next) {
      const key = `${t.stem} ${next.stem}`;
      if (!out.has(key)) out.set(key, `${t.surface} ${next.surface}`);
    }
  });
  return out;
}

/** Runs of 2 to 3 capitalised words, minus stopwords and generic heading words. */
function entitiesOf(heading: string): string[] {
  const words = heading.replace(/[:|()[\],;]/g, ' | ').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length > 0) out.push(run.join(' '));
    run = [];
  };
  for (const raw of words) {
    const w = raw.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
    const lower = w.toLowerCase();
    const isCap = /^[A-Z][A-Za-z]+$/.test(w);
    if (raw === '|' || !isCap || STOPWORDS.has(lower) || FILLER.has(lower) || w.length < 3) {
      flush();
    } else {
      run.push(w);
      if (run.length === 3) flush();
    }
  }
  flush();
  // Single capitalised words are too noisy (title case); keep runs of 2+ words.
  return out.filter((e) => e.split(' ').length >= 2);
}

export interface AngleDef {
  id: string;
  keywords: string[];
  statement: string;
}

/** Angles suggested only when no outline (ours or theirs) touches them. */
export const UNCOVERED_ANGLES: AngleDef[] = [
  { id: 'cost', keywords: ['cost', 'price', 'pricing', 'margin'], statement: 'cost and pricing implications for buyers and investors' },
  { id: 'risk', keywords: ['risk', 'threat', 'headwind'], statement: 'the main risks and headwinds a decision maker should weigh' },
  { id: 'regional', keywords: ['region', 'regional', 'country', 'geography'], statement: 'how the picture differs across regions' },
  { id: 'adoption', keywords: ['adoption', 'barrier', 'readiness'], statement: 'adoption barriers and readiness' },
  { id: 'regulation', keywords: ['regulation', 'regulatory', 'policy', 'compliance'], statement: 'the regulatory and policy backdrop' },
  { id: 'entry', keywords: ['entry', 'strategy', 'playbook', 'opportunity'], statement: 'practical market-entry or positioning options' },
  { id: 'outlook', keywords: ['outlook', 'forecast', 'future', 'scenario'], statement: 'scenarios and the outlook beyond the current period' },
];

export interface CompareOptions {
  /** Minimum number of other pages that must cover a term. Default: min(2, pages). */
  minSupport?: number;
  maxPoints?: number;
  competitors?: readonly CompetitorEntry[];
}

function mentionsCompetitor(text: string, comps: readonly CompetitorEntry[]): boolean {
  const norm = ` ${normalizeForMatch(text)} `;
  const raw = text.toLowerCase();
  const squashed = norm.replace(/ /g, '');
  return comps.some(
    (c) =>
      c.aliases.some((a) => norm.includes(` ${a} `) || squashed.includes(a.replace(/ /g, ''))) ||
      c.literals.some((l) => raw.includes(l.toLowerCase())) ||
      norm.includes(` ${normalizeForMatch(c.name)} `),
  );
}

/**
 * Compares our outline headings with the headings of other pages and returns
 * generic beat points. `otherHeadings` is one heading list per page (a bare
 * string counts as a one-heading page).
 */
export function compareOutline(
  ourOutline: readonly string[],
  otherHeadings: ReadonlyArray<string | readonly string[]>,
  options: CompareOptions = {},
): string[] {
  const comps = options.competitors ?? defaultCompetitors;
  const pages: string[][] = otherHeadings.map((p) => (typeof p === 'string' ? [p] : [...p]));
  const maxPoints = options.maxPoints ?? 8;
  const minSupport = options.minSupport ?? Math.max(1, Math.min(2, pages.length));

  const wholeHeadings = new Set(pages.flat().map((h) => normalizeForMatch(h)));
  const ourTerms = new Set<string>();
  const ourUnigrams = new Set<string>();
  for (const h of ourOutline) {
    for (const [k] of termsOf(h)) {
      ourTerms.add(k);
      if (!k.includes(' ')) ourUnigrams.add(k);
    }
  }
  const ourText = ` ${ourOutline.map((h) => normalizeForMatch(h)).join(' ')} `;

  const safe = (term: string): boolean => {
    if (mentionsCompetitor(term, comps)) return false;
    const norm = normalizeForMatch(term);
    return !(norm.split(' ').length >= 3 && wholeHeadings.has(norm));
  };

  // --- topic terms
  const support = new Map<string, { n: number; display: string }>();
  for (const page of pages) {
    const seen = new Map<string, string>();
    for (const h of page) for (const [k, d] of termsOf(h)) if (!seen.has(k)) seen.set(k, d);
    for (const [k, d] of seen) {
      const cur = support.get(k);
      support.set(k, { n: (cur?.n ?? 0) + 1, display: cur?.display ?? d });
    }
  }
  const gapTerms = [...support.entries()]
    .filter(([k, v]) => {
      if (v.n < minSupport || ourTerms.has(k)) return false;
      const parts = k.split(' ');
      if (parts.length === 2 && parts.every((p) => ourUnigrams.has(p))) return false; // both words already ours
      return safe(v.display);
    })
    .sort((a, b) => b[1].n - a[1].n); // stable: ties keep first-appearance order, which is deterministic
  // Greedy: a bigram that shares a word with an already chosen one is a fragment of the same phrase.
  const bigrams: typeof gapTerms = [];
  for (const g of gapTerms.filter(([k]) => k.includes(' '))) {
    if (bigrams.length >= 4) break;
    const words = g[0].split(' ');
    if (!bigrams.some(([k]) => k.split(' ').some((w) => words.includes(w)))) bigrams.push(g);
  }
  const coveredByBigram = new Set(bigrams.flatMap(([k]) => k.split(' ')));
  const unigrams = gapTerms.filter(([k]) => !k.includes(' ') && !coveredByBigram.has(k)).slice(0, 4);
  const topicAll = [...bigrams, ...unigrams].map(
    ([, v]) => `Add a dedicated section on ${v.display}, a topic comparable outlines cover and ours currently lacks.`,
  );

  // --- entities
  const entSupport = new Map<string, number>();
  for (const page of pages) {
    const seen = new Set<string>();
    for (const h of page) for (const e of entitiesOf(h)) seen.add(e);
    for (const e of seen) entSupport.set(e, (entSupport.get(e) ?? 0) + 1);
  }
  const entityPoints = [...entSupport.entries()]
    .filter(([e, n]) => n >= minSupport && !ourText.includes(` ${normalizeForMatch(e)} `) && safe(e))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 3)
    .map(([e]) => `Address ${e} explicitly, since other outlines on this topic discuss it and ours does not.`);

  // --- angles nobody covers
  const allTerms = new Set<string>([...ourTerms, ...pages.flat().flatMap((h) => [...termsOf(h).keys()])]);
  const anglePoints = UNCOVERED_ANGLES.filter((a) => !a.keywords.some((k) => allTerms.has(stem(k)) || allTerms.has(k)))
    .slice(0, 2)
    .map((a) => `Take an angle no compared outline takes: ${a.statement}.`);

  // Reserve room so entity and angle suggestions are not crowded out by topic terms.
  const entities = entityPoints.slice(0, 2);
  const angles = anglePoints.slice(0, 2);
  const topicBudget = Math.max(0, maxPoints - entities.length - angles.length);
  return [...new Set([...topicAll.slice(0, topicBudget), ...entities, ...angles])].slice(0, maxPoints);
}
