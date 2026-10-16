import { JSDOM } from 'jsdom';
import { isAllowedFactSource } from '../assets/source-check.js';
import type { ClaimMapping } from '../contracts.js';
import type { Brief, Fact, PlatformId } from '../schemas/index.js';
import { normalizeForMatch } from '../utils/normalize.js';
import { mostSimilar } from '../utils/similarity.js';
import type { ObservedMetrics } from './observations.js';
import {
  findNumericFigures,
  fleschReadingEase,
  hasNumber,
  hierarchySkips,
  parseStructure,
  stripMarkup,
  words,
  wordCount,
} from './text-analysis.js';
export type DimensionName =
  | 'evidenceCoverage'
  | 'sourceTraceability'
  | 'intentMatch'
  | 'originality'
  | 'readability'
  | 'structure'
  | 'technical';

export interface ScoreDimension {
  name: DimensionName;
  /** 0..1, rounded to 4 decimals. */
  score: number;
  /** False when there was nothing to measure; the dimension is then left out of `overall`. */
  applicable: boolean;
  /** The weight from SCORE_WEIGHTS (before renormalisation over applicable dimensions). */
  weight: number;
  evidence: string[];
  /** Human readable formula, identical for every call. */
  formula: string;
}

/**
 * Editorial weights for `overall`. They are a documented choice, NOT fitted to
 * any ranking or citation data. They sum to 1. Evidence dimensions carry the
 * most weight because this pipeline's core promise is that every number is
 * traceable to a verified fact; technical hygiene is only scored when HTML exists.
 */
export const SCORE_WEIGHTS: Readonly<Record<DimensionName, number>> = {
  evidenceCoverage: 0.25,
  sourceTraceability: 0.15,
  intentMatch: 0.15,
  originality: 0.15,
  readability: 0.1,
  structure: 0.1,
  technical: 0.1,
};

export const SCORE_LABEL_TEMPLATE = (percent: number): string =>
  `Content READINESS score ${percent}/100. This is a content READINESS score, NOT a ranking or citation prediction: ` +
  'search or AI-answer inclusion is not guaranteed by any score.';

export interface ScoreInput {
  text: string;
  /** Rendered page HTML. Enables the technical dimension and HTML-based structure parsing. */
  html?: string;
  facts: readonly Fact[];
  /** Output of the claim checker for this text. */
  claimMappings: readonly ClaimMapping[];
  brief: Pick<Brief, 'keywords' | 'beatPoints' | 'angle'>;
  platform: PlatformId;
  /** Previously published texts to compare against for originality. */
  corpus: readonly string[];
  /**
   * Observed metrics (AI-citation checks, Search Console). Carried through to
   * the result untouched for reporting. They are NEVER used in any score.
   */
  observed?: ObservedMetrics;
}

export interface ContentScore {
  dimensions: ScoreDimension[];
  /** Weighted mean of applicable dimensions, 0..1, 4 decimals. */
  overall: number;
  label: string;
  weights: Readonly<Record<DimensionName, number>>;
  observed?: ObservedMetrics;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const MAX_EVIDENCE_ITEMS = 5;

function dim(name: DimensionName, score: number, applicable: boolean, evidence: string[], formula: string): ScoreDimension {
  return { name, score: round4(clamp01(score)), applicable, weight: SCORE_WEIGHTS[name], evidence, formula };
}

// --- 1. evidenceCoverage -----------------------------------------------------

const EVIDENCE_FORMULA =
  'covered / material, where material = claim mappings with status != "ignored" and covered = status in {supported, derived}. ' +
  'If there are no mappings but the text contains numeric figures, score = 0. If there is nothing numeric, the dimension is not applicable.';

export function scoreEvidenceCoverage(input: Pick<ScoreInput, 'text' | 'claimMappings'>): ScoreDimension {
  const material = input.claimMappings.filter((m) => m.status !== 'ignored');
  if (material.length === 0) {
    const figures = findNumericFigures(stripMarkup(input.text));
    if (figures.length > 0) {
      return dim('evidenceCoverage', 0, true, [`text contains ${figures.length} numeric figure(s) (${figures.slice(0, 3).join(', ')}) but no claim mappings were supplied`], EVIDENCE_FORMULA);
    }
    return dim('evidenceCoverage', 1, false, ['no material numeric claims found, nothing to cover'], EVIDENCE_FORMULA);
  }
  const covered = material.filter((m) => m.status === 'supported' || m.status === 'derived');
  const uncovered = material.filter((m) => m.status !== 'supported' && m.status !== 'derived');
  const evidence = [`${covered.length} of ${material.length} material claims are mapped to facts`];
  for (const m of uncovered.slice(0, MAX_EVIDENCE_ITEMS)) evidence.push(`${m.status}: "${m.claim}"`);
  if (uncovered.length > MAX_EVIDENCE_ITEMS) evidence.push(`... and ${uncovered.length - MAX_EVIDENCE_ITEMS} more`);
  return dim('evidenceCoverage', covered.length / material.length, true, evidence, EVIDENCE_FORMULA);
}

// --- 2. sourceTraceability ---------------------------------------------------

const TRACE_FORMULA =
  'traceable / referenced, over every supported/derived claim mapping. A mapping is traceable when its factId exists in the supplied facts, ' +
  'the fact is verified, its sourceUrl passes the source policy (Ken Research or government), and, for derived facts, every input fact is also verified and policy-compliant.';

function factTraceProblem(fact: Fact | undefined, byId: ReadonlyMap<string, Fact>): string | null {
  if (!fact) return 'fact not found in supplied facts';
  if (fact.verificationStatus !== 'verified') return `fact ${fact.id} is ${fact.verificationStatus}`;
  if (!isAllowedFactSource(fact.sourceUrl)) return `fact ${fact.id} source ${fact.sourceUrl} is not an allowed source`;
  if (fact.factType === 'derived') {
    for (const inputId of fact.derivation?.inputFactIds ?? []) {
      const input = byId.get(inputId);
      const problem = factTraceProblem(input, byId);
      if (problem) return `derived fact ${fact.id}: input ${inputId}: ${problem}`;
    }
  }
  return null;
}

export function scoreSourceTraceability(input: Pick<ScoreInput, 'facts' | 'claimMappings'>): ScoreDimension {
  const byId = new Map(input.facts.map((f) => [f.id, f] as const));
  const covered = input.claimMappings.filter((m) => m.status === 'supported' || m.status === 'derived');
  if (covered.length === 0) {
    return dim('sourceTraceability', 1, false, ['no supported or derived claims, nothing to trace'], TRACE_FORMULA);
  }
  let ok = 0;
  const evidence: string[] = [];
  for (const m of covered) {
    const problem = m.factId === undefined ? 'mapping has no factId' : factTraceProblem(byId.get(m.factId), byId);
    if (problem === null) ok++;
    else evidence.push(`"${m.claim}": ${problem}`);
  }
  const head = `${ok} of ${covered.length} supported/derived claims trace to a verified fact from an allowed source`;
  const shown = evidence.slice(0, MAX_EVIDENCE_ITEMS);
  if (evidence.length > MAX_EVIDENCE_ITEMS) shown.push(`... and ${evidence.length - MAX_EVIDENCE_ITEMS} more`);
  return dim('sourceTraceability', ok / covered.length, true, [head, ...shown], TRACE_FORMULA);
}

// --- 3. intentMatch ----------------------------------------------------------

const INTENT_FORMULA =
  'mean of the available components: keywords (each keyword: 1 if its normalized phrase appears contiguously, 0.5 if all its words appear non-adjacently, else 0), ' +
  'beatPoints (each: share of its significant words, length >= 4 and not a stop word, found in the text), angle (same share). Matching is lexical, not semantic.';

const STOP = new Set(
  'about above after again also been being below between both could does doing down during each from further have having here into itself more most other over same should some such than that their them then there these they this those through under until very were what when where which while will with would your the and for are but not you all any can her was one our out has had how its may who why'.split(' '),
);

function stem(token: string): string {
  return token.length > 4 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;
}

function significantTokens(phrase: string): string[] {
  return normalizeForMatch(phrase)
    .split(' ')
    .filter((t) => t.length >= 4 && !STOP.has(t))
    .map(stem);
}

export function scoreIntentMatch(input: Pick<ScoreInput, 'text' | 'brief'>): ScoreDimension {
  const norm = normalizeForMatch(stripMarkup(input.text));
  const padded = ` ${norm} `;
  const textTokens = new Set(norm.split(' ').filter(Boolean).map(stem));
  const evidence: string[] = [];
  const components: number[] = [];

  const kw = input.brief.keywords;
  if (kw.length > 0) {
    const per = kw.map((k) => {
      const phrase = normalizeForMatch(k);
      if (phrase !== '' && padded.includes(` ${phrase} `)) return 1;
      const toks = phrase.split(' ').filter(Boolean).map(stem);
      return toks.length > 0 && toks.every((t) => textTokens.has(t)) ? 0.5 : 0;
    });
    components.push(mean(per));
    const missing = kw.filter((_, i) => per[i] === 0);
    evidence.push(`keywords: ${kw.length - missing.length} of ${kw.length} present${missing.length ? `; missing: ${missing.slice(0, MAX_EVIDENCE_ITEMS).join(', ')}` : ''}`);
  }

  const share = (phrase: string): number => {
    const toks = significantTokens(phrase);
    if (toks.length === 0) return 1;
    return toks.filter((t) => textTokens.has(t)).length / toks.length;
  };

  const beats = input.brief.beatPoints;
  if (beats.length > 0) {
    const per = beats.map(share);
    components.push(mean(per));
    evidence.push(`beat points: mean word coverage ${round4(mean(per))} across ${beats.length}`);
  }
  if (input.brief.angle.trim() !== '') {
    const s = share(input.brief.angle);
    components.push(s);
    evidence.push(`angle: word coverage ${round4(s)}`);
  }

  if (components.length === 0) return dim('intentMatch', 1, false, ['brief has no keywords, beat points or angle'], INTENT_FORMULA);
  return dim('intentMatch', mean(components), true, evidence, INTENT_FORMULA);
}

// --- 4. originality ----------------------------------------------------------

const ORIGINALITY_FORMULA =
  '1 - max over corpus of textSimilarity(text, doc), where textSimilarity is Jaccard similarity of 3-word shingles (src/utils/similarity). Lexical overlap only; paraphrase is not detected. Not applicable with an empty corpus.';

export function scoreOriginality(input: Pick<ScoreInput, 'text' | 'corpus'>): ScoreDimension {
  if (input.corpus.length === 0) return dim('originality', 1, false, ['no corpus supplied, originality not measured'], ORIGINALITY_FORMULA);
  const best = mostSimilar(input.text, input.corpus);
  return dim('originality', 1 - best.score, true, [`highest similarity ${round4(best.score)} against corpus item #${best.index} of ${input.corpus.length}`], ORIGINALITY_FORMULA);
}

// --- 5. readability ----------------------------------------------------------

const READABILITY_FORMULA =
  'Flesch Reading Ease = 206.835 - 1.015 (words/sentence) - 84.6 (syllables/word). Band score for senior B2B: 1.0 for 50..60; 5/7 for 45..65; 3/7 for 40..70; 1/7 otherwise. Not applicable under 10 words.';

/** Band score for senior B2B readers (see docs/metrics.md for provenance and the adapted widths). */
export function readabilityBandScore(readingEase: number): number {
  if (readingEase >= 50 && readingEase <= 60) return 1;
  if (readingEase >= 45 && readingEase <= 65) return 5 / 7;
  if (readingEase >= 40 && readingEase <= 70) return 3 / 7;
  return 1 / 7;
}

export function scoreReadability(input: Pick<ScoreInput, 'text'>): ScoreDimension {
  const flesch = fleschReadingEase(stripMarkup(input.text));
  if (!flesch || flesch.words < 10) return dim('readability', 1, false, ['fewer than 10 words, readability not measured'], READABILITY_FORMULA);
  const band = readabilityBandScore(flesch.readingEase);
  return dim(
    'readability',
    band,
    true,
    [
      `Flesch Reading Ease ${flesch.readingEase.toFixed(1)} (target band 50-60 for senior B2B)`,
      `${flesch.words} words, ${flesch.sentences} sentences, ${flesch.avgSentenceLength.toFixed(1)} words/sentence, ${flesch.avgSyllablesPerWord.toFixed(2)} syllables/word`,
    ],
    READABILITY_FORMULA,
  );
}

// --- 6. structure ------------------------------------------------------------

const STRUCTURE_FORMULA =
  'mean of binary/ratio checks on blog content: heading hierarchy has no skips (claude-blog); at least one H2 (claude-blog); at most one H1; ' +
  'a table or >= 3 list items (claude-blog); front-loading: the first 30% of words is >= 50 words and contains a number (geo-optimizer-skill); ' +
  'passage density: share of paragraphs of >= 10 words that are 50..150 words with a number (geo-optimizer-skill); ' +
  'answer-first: share of question headings followed by a 5..60 word paragraph (geo-optimizer-skill; skipped when there are no question headings). Applies to platform "blog" only.';

export function scoreStructure(input: Pick<ScoreInput, 'text' | 'html' | 'platform'>): ScoreDimension {
  if (input.platform !== 'blog') {
    return dim('structure', 1, false, [`structure checks are defined for blog articles, not platform "${input.platform}"`], STRUCTURE_FORMULA);
  }
  const s = parseStructure(input.text, input.html);
  const checks: Array<{ name: string; score: number; note: string }> = [];

  const skips = hierarchySkips(s.headings);
  checks.push({ name: 'hierarchy', score: skips.length === 0 ? 1 : 0, note: skips.length === 0 ? 'no heading level skips' : `heading skips: ${skips.slice(0, 3).map((k) => `H${k.from} to H${k.to} at "${k.text}"`).join('; ')}` });
  const h2 = s.headings.filter((h) => h.level === 2).length;
  checks.push({ name: 'hasH2', score: h2 >= 1 ? 1 : 0, note: `${h2} H2 heading(s)` });
  checks.push({ name: 'singleH1', score: s.h1Count <= 1 ? 1 : 0, note: `${s.h1Count} H1 heading(s)` });
  const hasList = s.tableCount >= 1 || s.listItemCount >= 3;
  checks.push({ name: 'listsOrTables', score: hasList ? 1 : 0, note: `${s.tableCount} table(s), ${s.listItemCount} list item(s)` });

  const allWords = words(s.paragraphs.join(' '));
  const first30 = allWords.slice(0, Math.max(Math.floor((allWords.length * 30) / 100), 1));
  const front = first30.length >= 50 && first30.some((w) => hasNumber(w));
  checks.push({ name: 'frontLoading', score: front ? 1 : 0, note: `first 30% = ${first30.length} words${first30.some((w) => hasNumber(w)) ? ', has a number' : ', no number'}` });

  const longParas = s.paragraphs.filter((p) => wordCount(p) >= 10);
  if (longParas.length > 0) {
    const dense = longParas.filter((p) => {
      const n = wordCount(p);
      return n >= 50 && n <= 150 && hasNumber(p);
    });
    checks.push({ name: 'passageDensity', score: dense.length / longParas.length, note: `${dense.length} of ${longParas.length} paragraphs are 50-150 words with a number` });
  }

  // Answer-first: needs paragraph following each question heading. Recompute from the ordered document.
  const answer = answerFirstShare(input.text, input.html);
  if (answer) checks.push({ name: 'answerFirst', score: answer.share, note: `${answer.ok} of ${answer.total} question headings are followed by a 5-60 word answer` });

  return dim('structure', mean(checks.map((c) => c.score)), true, checks.map((c) => `${c.name}: ${round4(c.score)} (${c.note})`), STRUCTURE_FORMULA);
}

function answerFirstShare(text: string, html?: string): { ok: number; total: number; share: number } | null {
  let pairs: Array<{ heading: string; next: string | undefined }> = [];
  if (html !== undefined && html.trim() !== '') {
    const doc = new JSDOM(html).window.document;
    const nodes = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p'));
    nodes.forEach((n, i) => {
      if (!/^H[1-6]$/.test(n.tagName)) return;
      const following = nodes[i + 1];
      pairs.push({ heading: (n.textContent ?? '').trim(), next: following?.tagName === 'P' ? (following.textContent ?? '').trim() : undefined });
    });
  } else {
    const lines = text.split(/\r?\n/);
    pairs = [];
    lines.forEach((raw, i) => {
      const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(raw.trim());
      if (!h) return;
      let next: string | undefined;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!.trim();
        if (l === '') continue;
        if (/^#{1,6}\s/.test(l) || /^([-*+]|\d+[.)])\s+/.test(l) || /^\|/.test(l)) break;
        next = stripMarkup(l);
        break;
      }
      pairs.push({ heading: h[1]!.trim(), next });
    });
  }
  const questions = pairs.filter((p) => p.heading.endsWith('?'));
  if (questions.length === 0) return null;
  const ok = questions.filter((q) => {
    if (q.next === undefined) return false;
    const n = wordCount(q.next);
    return n >= 5 && n <= 60;
  }).length;
  return { ok, total: questions.length, share: ok / questions.length };
}

// --- 7. technical (html only) -----------------------------------------------

const TECHNICAL_FORMULA =
  'mean of binary checks on the supplied HTML: non-empty <title>; meta description present; <link rel=canonical> present; exactly one H1 and no heading level skips; ' +
  'at least one parseable JSON-LD block (and none unparseable); robots meta does not contain noindex. Length of title/description is reported, not scored (no sourced threshold).';

export function scoreTechnical(input: Pick<ScoreInput, 'html'>): ScoreDimension {
  if (input.html === undefined || input.html.trim() === '') {
    return dim('technical', 1, false, ['no HTML supplied, technical checks skipped'], TECHNICAL_FORMULA);
  }
  const doc = new JSDOM(input.html).window.document;
  const checks: Array<{ name: string; pass: boolean; note: string }> = [];

  const title = (doc.querySelector('title')?.textContent ?? '').trim();
  checks.push({ name: 'title', pass: title !== '', note: title ? `${title.length} chars` : 'missing or empty' });
  const desc = (doc.querySelector('meta[name="description" i]')?.getAttribute('content') ?? '').trim();
  checks.push({ name: 'metaDescription', pass: desc !== '', note: desc ? `${desc.length} chars` : 'missing or empty' });
  const canonical = (doc.querySelector('link[rel="canonical" i]')?.getAttribute('href') ?? '').trim();
  checks.push({ name: 'canonical', pass: canonical !== '', note: canonical || 'missing' });

  const structure = parseStructure('', input.html);
  const skips = hierarchySkips(structure.headings);
  checks.push({ name: 'headingHierarchy', pass: structure.h1Count === 1 && skips.length === 0, note: `${structure.h1Count} H1, ${skips.length} level skip(s)` });

  const ld = Array.from(doc.querySelectorAll('script[type="application/ld+json" i]'));
  let valid = 0;
  let invalid = 0;
  for (const s of ld) {
    try {
      JSON.parse(s.textContent ?? '');
      valid++;
    } catch {
      invalid++;
    }
  }
  checks.push({ name: 'jsonLd', pass: valid >= 1 && invalid === 0, note: `${valid} valid, ${invalid} invalid block(s)` });

  const robots = (doc.querySelector('meta[name="robots" i]')?.getAttribute('content') ?? '').toLowerCase();
  const noindex = robots.includes('noindex');
  const noai = robots.includes('noai') || robots.includes('noimageai');
  checks.push({ name: 'robotsIndexable', pass: !noindex, note: robots ? `robots="${robots}"${noai ? ' (also blocks AI use)' : ''}` : 'no robots meta' });

  return dim('technical', mean(checks.map((c) => (c.pass ? 1 : 0))), true, checks.map((c) => `${c.name}: ${c.pass ? 'pass' : 'FAIL'} (${c.note})`), TECHNICAL_FORMULA);
}

// --- overall -----------------------------------------------------------------

/** Weighted mean over applicable dimensions only (weights renormalised). Pure function of dimension scores. */
export function combineDimensions(dimensions: readonly ScoreDimension[]): number {
  let weighted = 0;
  let total = 0;
  for (const d of dimensions) {
    if (!d.applicable) continue;
    weighted += d.weight * d.score;
    total += d.weight;
  }
  return total === 0 ? 0 : round4(weighted / total);
}

/**
 * Scores content READINESS from observable properties of the text, its facts
 * and its HTML. It does not predict rankings or citations and never reads
 * `observed`, which is passed through for reporting only.
 */
export function scoreContent(input: ScoreInput): ContentScore {
  const dimensions: ScoreDimension[] = [
    scoreEvidenceCoverage(input),
    scoreSourceTraceability(input),
    scoreIntentMatch(input),
    scoreOriginality(input),
    scoreReadability(input),
    scoreStructure(input),
    scoreTechnical(input),
  ];
  const overall = combineDimensions(dimensions);
  const result: ContentScore = {
    dimensions,
    overall,
    label: SCORE_LABEL_TEMPLATE(Math.round(overall * 100)),
    weights: SCORE_WEIGHTS,
  };
  if (input.observed !== undefined) result.observed = input.observed;
  return result;
}

