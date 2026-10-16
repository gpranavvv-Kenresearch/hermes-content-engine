import type { ClaimChecker, ClaimCheckResult, ClaimMapping } from '../contracts.js';
import type { Fact, ValidationIssue } from '../schemas/index.js';
import { findConflicts, findGeographies, findGeographyMentions, findPeriods, type PeriodMention } from './fact-extractor.js';
import {
  CURRENCY_PREFIX_PATTERN,
  CURRENCY_WORD_PATTERN,
  SCALE_MULTIPLIER,
  decimalsOf,
  granularity,
  matchesWithinPrecision,
  normalizeCurrency,
  normalizeScale,
  parseFactUnit,
  parseNumber,
  toBaseValue,
  type Scale,
} from './units.js';

/**
 * Deterministic numeric-claim checker. Extraction is regex based and
 * deliberately conservative about WHAT counts as a material claim (money with
 * a scale, percentages, multipliers, counts of market nouns); everything else
 * (years, dates, URLs, hashtags, list numbers, phone-like numbers, ids,
 * character counts, small bare integers) is ignored. Every claim must then be
 * matched to a Fact; unmatched claims are hard failures.
 */

export type ClaimKind = 'money' | 'percent' | 'multiplier' | 'quantity';

export interface NumericClaim {
  kind: ClaimKind;
  raw: string;
  start: number;
  end: number;
  /** Value as printed (e.g. 4.2 for "USD 4.2 billion"). */
  value: number;
  decimals: number;
  currency?: string;
  scale?: Scale;
  /** For quantity claims: the counted noun, singular lower-case. */
  noun?: string;
  /** Value in base units (money/quantity with scale multiplied out). */
  base: number;
  /** Smallest printed step in base units. */
  gran: number;
}

// ----------------------------------------------------------------- masking

const MONTHS = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';

const MASKERS: Array<{ re: RegExp; keep?: (m: string) => boolean }> = [
  { re: /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi },
  { re: /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|in|gov|io|co|edu|uk|eu|info)\b(?:\/[^\s<>"')\]]*)?/gi },
  { re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { re: /(?<![\w])@\w+/g },
  { re: /#[\p{L}\p{N}_]+/gu },
  { re: /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g },
  { re: /\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g },
  { re: new RegExp(`\\b${MONTHS}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?\\b`, 'gi') },
  { re: new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}\\.?(?:,?\\s*\\d{4})?\\b`, 'gi') },
  { re: new RegExp(`\\b${MONTHS}\\.?\\s+\\d{4}\\b`, 'gi') },
  { re: /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:[ap]\.?m\.?)?/gi },
  { re: /\bv?\d+\.\d+\.\d+(?:\.\d+)*\b/g },
  { re: /^[ \t]*\(?\d{1,3}[.)]\s+/gm },
  { re: /\b(?:step|tip|rule|slide|fig|table|page|chapter|ticket|invoice|ref|id|no)\.?\s*#?[:-]?\s*\d+\b(?![.,]\d)(?!\s?(?:%|percent|billion|million|trillion|bn|mn))/gi },
  { re: /\b[A-Z]{1,6}-\d{2,}\b/g },
  { re: /\b\d{9,}\b/g },
  {
    re: /(?<![\w$€£₹.,])\+?\(?\d{2,4}\)?[\s.-]\d{3,5}[\s.-]\d{3,5}(?:[\s.-]\d{2,5})?(?![\w%]|,\d)/g,
    keep: (m) => m.replace(/\D/g, '').length < 9,
  },
];

/** Replaces non-claim regions with spaces so offsets stay stable. */
export function maskIgnorable(text: string): string {
  let out = text;
  for (const { re, keep } of MASKERS) {
    out = out.replace(new RegExp(re.source, re.flags), (m) => (keep?.(m) ? m : ' '.repeat(m.length)));
  }
  return out;
}

// --------------------------------------------------------------- extraction

const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
const MONEY_PREFIX = new RegExp(`(?<![A-Za-z$])(${CURRENCY_PREFIX_PATTERN})\\s?${NUM}`, 'g');
const MONEY_SUFFIX = new RegExp(`(?<![\\w.,])${NUM}\\s?([A-Za-z]+)\\s+(${CURRENCY_WORD_PATTERN}|${CURRENCY_PREFIX_PATTERN.replace('|\\$', '')})\\b`, 'gi');
const MONEY_WORD_ONLY = new RegExp(`(?<![\\w.,])${NUM}\\s?(${CURRENCY_WORD_PATTERN})\\b`, 'gi');
const SCALE_ONLY = /(?<![\w.,$€£₹])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?([A-Za-z]+)\b/g;
const PERCENT_RANGE = /(?<![\w.,])(\d+(?:\.\d+)?)\s?(?:-|–|—|to)\s?(\d+(?:\.\d+)?)\s?(?:%|percent\b|per cent\b)/gi;
const PERCENT = /(?<![\w.,])(\d+(?:\.\d+)?)\s?(?:%|percent\b|per cent\b)/gi;
const MULTIPLIER_X = /(?<![\w.,])(\d+(?:\.\d+)?)\s?(?:x|×)(?![A-Za-z0-9])/g;
const MULTIPLIER_TIMES = /(?<![\w.,])(\d+(?:\.\d+)?)\s(times)\s+(?:as\b|higher|larger|bigger|greater|more|faster|the\b|its\b|current|than\b)/gi;
const MULTIPLIER_VERB = /(?:grew|grow|rise|rose|increase[ds]?|expand(?:s|ed)?|multipl\w+|reach(?:es|ed)?|jump(?:s|ed)?)\s+(?:by\s+|to\s+)?(?:about\s+|nearly\s+|almost\s+)?(\d+(?:\.\d+)?)\s(times)\b/gi;

const QUANTITY_NOUNS = [
  'companies', 'firms', 'manufacturers', 'players', 'vendors', 'suppliers', 'startups', 'brands', 'countries', 'customers',
  'users', 'consumers', 'stores', 'outlets', 'plants', 'factories', 'facilities', 'employees', 'workers', 'households',
  'enterprises', 'businesses', 'distributors', 'retailers', 'units', 'hospitals', 'banks', 'schools', 'farms', 'vehicles',
  'devices', 'installations', 'projects', 'subscribers', 'dealers',
];
const QUANTITY = new RegExp(`(?<![\\w.,$€£₹])${NUM}\\s+(${QUANTITY_NOUNS.join('|')})\\b`, 'gi');
const QUANTITY_LEAD = /\b(top|best|leading|first|last|biggest|largest|major)\s*$/i;

function overlaps(list: ReadonlyArray<{ start: number; end: number }>, s: number, e: number): boolean {
  return list.some((c) => s < c.end && e > c.start);
}

function mk(
  kind: ClaimKind,
  text: string,
  start: number,
  end: number,
  value: number,
  printed: string,
  extra: { currency?: string; scale?: Scale; noun?: string } = {},
): NumericClaim {
  const decimals = decimalsOf(printed);
  const mult = extra.scale ? SCALE_MULTIPLIER[extra.scale] : 1;
  const c: NumericClaim = {
    kind,
    raw: text.slice(start, end).trim(),
    start,
    end,
    value,
    decimals,
    base: value * mult,
    gran: 10 ** -decimals * mult,
  };
  if (extra.currency) c.currency = extra.currency;
  if (extra.scale) c.scale = extra.scale;
  if (extra.noun) c.noun = extra.noun;
  return c;
}

/** Material numeric claims in `text`, in order of position. Everything else is ignored. */
export function extractNumericClaims(text: string): NumericClaim[] {
  const masked = maskIgnorable(text);
  const claims: NumericClaim[] = [];

  // Money with prefix currency: "USD 4.2 billion", "$4.2B", "INR 1,250".
  for (const m of masked.matchAll(MONEY_PREFIX)) {
    const currency = normalizeCurrency(m[1]!);
    if (!currency) continue;
    const start = m.index ?? 0;
    let end = start + m[0].length;
    const after = /^\s?([A-Za-z]+)\b/.exec(masked.slice(end));
    const scale = after ? normalizeScale(after[1]!) : undefined;
    if (scale && after) end += after[0].length;
    const value = parseNumber(m[2]!);
    if (!scale && value < 1000) continue; // small bare amounts (prices) are not material market claims
    claims.push(mk('money', text, start, end, value, m[2]!, { currency, ...(scale ? { scale } : {}) }));
  }
  // Money with suffix currency: "350 mn USD", "4.2 billion dollars".
  for (const m of masked.matchAll(MONEY_SUFFIX)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlaps(claims, start, end)) continue;
    const scale = normalizeScale(m[2]!);
    const currency = normalizeCurrency(m[3]!) ?? normalizeCurrency(m[3]!.toUpperCase());
    if (!scale || !currency) continue;
    claims.push(mk('money', text, start, end, parseNumber(m[1]!), m[1]!, { currency, scale }));
  }
  for (const m of masked.matchAll(MONEY_WORD_ONLY)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlaps(claims, start, end)) continue;
    const currency = normalizeCurrency(m[2]!);
    const value = parseNumber(m[1]!);
    if (!currency || value < 1000) continue;
    claims.push(mk('money', text, start, end, value, m[1]!, { currency }));
  }
  // Scale without currency: "4.2 billion", "1.4B".
  for (const m of masked.matchAll(SCALE_ONLY)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlaps(claims, start, end)) continue;
    const scale = normalizeScale(m[2]!);
    if (!scale) continue;
    // Single-letter scales must be attached ("4.2B"); "4 M" with a space is too ambiguous.
    if (m[2]!.length === 1 && /\s/.test(m[0].slice(m[1]!.length, m[1]!.length + 1))) continue;
    claims.push(mk('money', text, start, end, parseNumber(m[1]!), m[1]!, { scale }));
  }
  // Percentages (ranges first so both ends count).
  for (const m of masked.matchAll(PERCENT_RANGE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlaps(claims, start, end)) continue;
    const firstEnd = start + m[1]!.length;
    claims.push(mk('percent', text, start, firstEnd, parseNumber(m[1]!), m[1]!));
    const secondStart = end - (m[0].length - m[0].lastIndexOf(m[2]!));
    claims.push(mk('percent', text, secondStart, end, parseNumber(m[2]!), m[2]!));
  }
  for (const m of masked.matchAll(PERCENT)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlaps(claims, start, end)) continue;
    claims.push(mk('percent', text, start, end, parseNumber(m[1]!), m[1]!));
  }
  // Multipliers.
  for (const re of [MULTIPLIER_X, MULTIPLIER_TIMES, MULTIPLIER_VERB]) {
    for (const m of masked.matchAll(re)) {
      const numStr = m[1]!;
      const numAt = (m.index ?? 0) + m[0].indexOf(numStr);
      const start = numAt;
      const end = (m.index ?? 0) + m[0].length;
      // For the lookahead form of "times", only the number and the word belong to the claim.
      const claimEnd = re === MULTIPLIER_X ? end : numAt + numStr.length + 1 + 'times'.length;
      if (overlaps(claims, start, claimEnd)) continue;
      claims.push(mk('multiplier', text, start, claimEnd, parseNumber(numStr), numStr));
    }
  }
  // Counts of market nouns (>= 10, not list labels like "top 10 companies").
  for (const m of masked.matchAll(QUANTITY)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (overlaps(claims, start, end)) continue;
    const value = parseNumber(m[1]!);
    if (value < 10) continue;
    if (QUANTITY_LEAD.test(masked.slice(Math.max(0, start - 14), start))) continue;
    claims.push(mk('quantity', text, start, end, value, m[1]!, { noun: m[2]!.toLowerCase().replace(/ies$/, 'y').replace(/s$/, '') }));
  }

  return claims.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- matching

function factDecimals(f: Fact): number {
  return f.precision ?? decimalsOf(String(f.value));
}

function singularNoun(unit: string): string {
  return unit.trim().toLowerCase().replace(/ies$/, 'y').replace(/s$/, '');
}

function valueMatches(claim: NumericClaim, f: Fact): boolean {
  const unit = parseFactUnit(f.unit);
  switch (claim.kind) {
    case 'percent':
      return unit.percent && matchesWithinPrecision(claim.value, 10 ** -claim.decimals, f.value, 10 ** -factDecimals(f));
    case 'multiplier':
      return /^(x|times|multiple)$/i.test(f.unit.trim()) && matchesWithinPrecision(claim.value, 10 ** -claim.decimals, f.value, 10 ** -factDecimals(f));
    case 'quantity':
      return (
        singularNoun(f.unit) === claim.noun &&
        matchesWithinPrecision(claim.base, claim.gran, f.value, 10 ** -factDecimals(f))
      );
    case 'money': {
      if (unit.percent) return false;
      const factCur = f.currency ?? unit.currency;
      if (claim.currency && factCur && claim.currency !== factCur) return false;
      if (claim.currency && !factCur) return false;
      if (!unit.currency && !unit.scale && !f.currency) return false;
      return matchesWithinPrecision(
        claim.base,
        claim.gran,
        toBaseValue(f.value, f.unit),
        granularity(factDecimals(f), f.unit),
      );
    }
  }
}

interface PairDerivation {
  start: Fact;
  end: Fact;
  years: number;
  cagr: number;
  growth: number;
  multiple: number;
  period: string;
}

function derivedPairs(facts: readonly Fact[]): PairDerivation[] {
  const sizes = facts.filter((f) => f.metric === 'market_size' && /^\d{4}$/.test(f.period ?? ''));
  const out: PairDerivation[] = [];
  for (const a of sizes) {
    for (const b of sizes) {
      const ya = Number(a.period);
      const yb = Number(b.period);
      if (yb <= ya) continue;
      const ua = parseFactUnit(a.unit);
      const ub = parseFactUnit(b.unit);
      if (!ua.currency || ua.currency !== ub.currency) continue;
      if ((a.geography ?? '').toLowerCase() !== (b.geography ?? '').toLowerCase()) continue;
      const va = toBaseValue(a.value, a.unit);
      const vb = toBaseValue(b.value, b.unit);
      if (!(va > 0) || !(vb > 0)) continue;
      const years = yb - ya;
      out.push({
        start: a,
        end: b,
        years,
        cagr: ((vb / va) ** (1 / years) - 1) * 100,
        growth: (vb / va - 1) * 100,
        multiple: vb / va,
        period: `${ya}-${yb}`,
      });
    }
  }
  return out;
}

function derivedMatches(claim: NumericClaim, p: PairDerivation): boolean {
  const gran = 10 ** -claim.decimals;
  const tol = gran / 2 + 1e-9;
  if (claim.kind === 'percent') return Math.abs(p.cagr - claim.value) < tol || Math.abs(p.growth - claim.value) < tol;
  if (claim.kind === 'multiplier') return Math.abs(p.multiple - claim.value) < tol;
  return false;
}

/** A derived Fact is only usable when every input fact is present in the set and a formula is recorded. */
function derivedFactUsable(f: Fact, byId: ReadonlyMap<string, Fact>): boolean {
  if (f.factType !== 'derived') return true;
  if (!f.derivation || !f.derivation.formula) return false;
  return f.derivation.inputFactIds.every((id) => byId.has(id));
}

// ------------------------------------------------------------------ context

interface ClaimContext {
  periods: PeriodMention[];
  geographies: string[];
}

const CONTEXT_REACH = 80;

function sentenceBounds(s: string, start: number, end: number): [number, number] {
  let a = start;
  while (a > 0) {
    const prev = s[a - 1]!;
    if (prev === '\n') break;
    if (/[.!?]/.test(prev) && /\s/.test(s[a] ?? '') && s.slice(Math.max(0, a - 4), a) !== 'U.S.') break;
    a--;
  }
  let b = end;
  while (b < s.length) {
    const ch = s[b]!;
    if (ch === '\n') break;
    if (/[.!?]/.test(ch) && (b + 1 >= s.length || /\s/.test(s[b + 1]!)) && s.slice(Math.max(0, b - 3), b + 1) !== 'U.S.') break;
    b++;
  }
  return [a, b];
}

function gap(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return b.start >= a.end ? b.start - a.end : a.start >= b.end ? a.start - b.end : 0;
}

function buildContexts(text: string, claims: readonly NumericClaim[], extraGeo: readonly string[]): Map<NumericClaim, ClaimContext> {
  const masked = maskIgnorable(text);
  const result = new Map<NumericClaim, ClaimContext>();
  const bySentence = new Map<string, NumericClaim[]>();
  const bounds = new Map<NumericClaim, [number, number]>();
  for (const c of claims) {
    const b = sentenceBounds(masked, c.start, c.end);
    bounds.set(c, b);
    const key = `${b[0]}:${b[1]}`;
    bySentence.set(key, [...(bySentence.get(key) ?? []), c]);
  }
  for (const group of bySentence.values()) {
    const [sa, sb] = bounds.get(group[0]!)!;
    const sentence = masked.slice(sa, sb);
    const rel = group.map((c) => ({ c, start: c.start - sa, end: c.end - sa }));
    for (const r of rel) result.set(r.c, { periods: [], geographies: [] });
    const periods = findPeriods(sentence, rel.map((r) => [r.start, r.end] as [number, number]));
    const geos = findGeographyMentions(sentence, extraGeo);
    const hasGlobal = [...sentence.matchAll(/\b(global|worldwide)\b/gi)].map((m) => ({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      name: 'Global',
    }));
    const assign = <T extends { start: number; end: number }>(items: T[], push: (r: (typeof rel)[number], item: T) => void) => {
      for (const it of items) {
        let best = rel[0]!;
        for (const r of rel) if (gap(r, it) < gap(best, it)) best = r;
        if (gap(best, it) <= CONTEXT_REACH) push(best, it);
      }
    };
    assign(periods, (r, p) => result.get(r.c)!.periods.push(p));
    assign([...geos, ...hasGlobal], (r, g) => result.get(r.c)!.geographies.push(g.name));
  }
  return result;
}

function parsePeriod(p: string): [number, number] | undefined {
  const m = /^(\d{4})(?:-(\d{4}))?$/.exec(p);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2] ?? m[1])];
}

function periodCompatible(ctx: ClaimContext, factPeriod: string | undefined): boolean {
  if (!factPeriod || ctx.periods.length === 0) return true;
  const fp = parsePeriod(factPeriod);
  if (!fp) return true;
  const [f0, f1] = fp;
  const isRange = f0 !== f1;
  const mentions = ctx.periods.map((p) => parsePeriod(p.period)!).filter(Boolean);
  const ranges = mentions.filter(([a, b]) => a !== b);
  const singles = mentions.filter(([a, b]) => a === b).map(([a]) => a);
  if (ranges.length > 0) {
    if (isRange) return ranges.some(([a, b]) => a === f0 && b === f1);
    return ranges.some(([a, b]) => f0 >= a && f0 <= b);
  }
  if (isRange) return singles.every((y) => y >= f0 && y <= f1);
  return singles.includes(f0);
}

function normGeo(g: string, extra: readonly string[]): string {
  return (findGeographies(g, extra)[0] ?? g).toLowerCase();
}

function geographyCompatible(ctx: ClaimContext, factGeo: string | undefined, extra: readonly string[]): boolean {
  if (!factGeo || ctx.geographies.length === 0) return true;
  const g = normGeo(factGeo, extra);
  return ctx.geographies.some((x) => x.toLowerCase() === g);
}

// -------------------------------------------------------------------- check

function rank(f: Fact): number {
  return (f.verificationStatus === 'verified' ? 0 : 2) + (f.factType === 'observed' ? 0 : 1);
}

function describe(f: Fact): string {
  return `${f.metric} ${f.value} ${f.unit}${f.period ? ` (${f.period})` : ''}${f.geography ? ` [${f.geography}]` : ''}`;
}

export const checkClaims: ClaimChecker = (text: string, facts: readonly Fact[]): ClaimCheckResult => {
  const issues: ValidationIssue[] = [];
  const mappings: ClaimMapping[] = [];
  const claims = extractNumericClaims(text);
  if (claims.length === 0) return { issues, mappings };

  const extraGeo = [...new Set(facts.map((f) => f.geography).filter((g): g is string => !!g))];
  const contexts = buildContexts(text, claims, extraGeo);
  const byId = new Map(facts.map((f) => [f.id, f]));
  const conflictIds = new Set(findConflicts(facts).flatMap((g) => g.map((f) => f.id)));
  for (const f of facts) if (f.verificationStatus === 'conflicting') conflictIds.add(f.id);
  const pairs = derivedPairs(facts);

  const unsupported = (claim: NumericClaim, note: string) => {
    mappings.push({ claim: claim.raw, status: 'unsupported', note });
    issues.push({
      code: 'UNSUPPORTED_NUMERIC_CLAIM',
      severity: 'hard_fail',
      message: `Numeric claim "${claim.raw}" is not supported by any fact (${note}).`,
      detail: { claim: claim.raw, kind: claim.kind },
    });
  };
  const mismatch = (claim: NumericClaim, f: Fact, why: string) => {
    mappings.push({ claim: claim.raw, status: 'unsupported', factId: f.id, note: `context mismatch: ${why}` });
    issues.push({
      code: 'FACT_CONTEXT_MISMATCH',
      severity: 'hard_fail',
      message: `Claim "${claim.raw}" matches fact ${describe(f)} by value but its context differs (${why}).`,
      detail: { claim: claim.raw, factId: f.id, why },
    });
  };
  const unverifiedUse = (claim: NumericClaim, used: Fact[]) => {
    issues.push({
      code: 'UNVERIFIED_FACT_USED',
      severity: 'review',
      message: `Claim "${claim.raw}" relies on unverified fact(s): ${used.map(describe).join('; ')}.`,
      detail: { claim: claim.raw, factIds: used.map((f) => f.id) },
    });
  };

  for (const claim of claims) {
    const ctx = contexts.get(claim) ?? { periods: [], geographies: [] };
    const direct = facts.filter((f) => valueMatches(claim, f));
    const usable = direct.filter((f) => derivedFactUsable(f, byId));

    if (usable.length > 0) {
      const compatible = usable.filter((f) => periodCompatible(ctx, f.period) && geographyCompatible(ctx, f.geography, extraGeo));
      if (compatible.length === 0) {
        const f = [...usable].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))[0]!;
        const why = !periodCompatible(ctx, f.period)
          ? `text names ${ctx.periods.map((p) => p.period).join(', ')} but fact period is ${f.period}`
          : `text names ${ctx.geographies.join(', ')} but fact geography is ${f.geography}`;
        mismatch(claim, f, why);
        continue;
      }
      const conflicted = compatible.filter((f) => conflictIds.has(f.id));
      if (conflicted.length > 0) {
        const f = conflicted[0]!;
        const group = findConflicts(facts).find((g) => g.some((x) => x.id === f.id)) ?? conflicted;
        mappings.push({
          claim: claim.raw,
          status: 'conflicting',
          factId: f.id,
          note: `conflicting values for the same metric/period/geography: ${group.map((x) => `${x.value} ${x.unit}`).join(' vs ')}`,
        });
        issues.push({
          code: 'CONFLICTING_FACT',
          severity: 'hard_fail',
          message: `Claim "${claim.raw}" touches conflicting facts: ${group.map(describe).join(' vs ')}. Resolve the conflict before using it.`,
          detail: { claim: claim.raw, factIds: group.map((x) => x.id) },
        });
        continue;
      }
      const f = [...compatible].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))[0]!;
      if (f.factType === 'derived') {
        const inputs = f.derivation!.inputFactIds.map((id) => byId.get(id)!).filter(Boolean);
        mappings.push({ claim: claim.raw, status: 'derived', factId: f.id, note: `derived via ${f.derivation!.formula}` });
        const weak = [f, ...inputs].filter((x) => x.verificationStatus === 'unverified');
        if (weak.length > 0) unverifiedUse(claim, weak);
      } else {
        mappings.push({ claim: claim.raw, status: 'supported', factId: f.id });
        if (f.verificationStatus === 'unverified') unverifiedUse(claim, [f]);
      }
      continue;
    }

    // Derived from two market-size facts (CAGR, total growth, multiple): inputs, formula and period must all exist.
    if (claim.kind === 'percent' || claim.kind === 'multiplier') {
      const valueHits = pairs.filter((p) => derivedMatches(claim, p));
      if (valueHits.length > 0) {
        const ok = valueHits.filter((p) => periodCompatible(ctx, p.period) && geographyCompatible(ctx, p.end.geography, extraGeo));
        if (ok.length === 0) {
          const p = valueHits[0]!;
          mismatch(claim, p.end, `derived over ${p.period} but text names ${ctx.periods.map((x) => x.period).join(', ') || ctx.geographies.join(', ')}`);
          continue;
        }
        const p = [...ok].sort((a, b) => rank(a.start) + rank(a.end) - (rank(b.start) + rank(b.end)) || a.period.localeCompare(b.period))[0]!;
        if (conflictIds.has(p.start.id) || conflictIds.has(p.end.id)) {
          mappings.push({ claim: claim.raw, status: 'conflicting', factId: p.end.id, note: 'derivation inputs are conflicting facts' });
          issues.push({
            code: 'CONFLICTING_FACT',
            severity: 'hard_fail',
            message: `Claim "${claim.raw}" is derived from conflicting facts (${describe(p.start)}, ${describe(p.end)}).`,
            detail: { claim: claim.raw, factIds: [p.start.id, p.end.id] },
          });
          continue;
        }
        mappings.push({
          claim: claim.raw,
          status: 'derived',
          factId: p.end.id,
          note: `derived from ${p.start.id} (${p.start.period}) and ${p.end.id} (${p.end.period}) over ${p.years} years`,
        });
        const weak = [p.start, p.end].filter((x) => x.verificationStatus === 'unverified');
        if (weak.length > 0) unverifiedUse(claim, weak);
        continue;
      }
    }

    unsupported(claim, direct.length > 0 ? 'matching derived fact lacks its inputs' : 'no matching fact');
  }

  return { issues, mappings };
};
