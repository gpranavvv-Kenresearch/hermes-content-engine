import { sourcePolicy as defaultPolicy } from '../config/source-policy.config.js';
import { FactSchema, type Fact, type SourcePolicy } from '../schemas/index.js';
import { shortHash } from '../utils/hash.js';
import { COUNTRIES, GEOGRAPHY_ALIASES, REGIONS } from './geography.data.js';
import { classifyUrl } from './source-validator.js';
import {
  CURRENCY_PREFIX_PATTERN,
  CURRENCY_WORD_PATTERN,
  decimalsOf,
  makeMoneyUnit,
  normalizeCurrency,
  normalizeScale,
  parseFactUnit,
  parseNumber,
  toBaseValue,
  type Scale,
} from './units.js';

/**
 * Regex PROPOSES fact candidates; there is no LLM. Supported metrics:
 *  - market_size: currency + amount + scale (billion/million/trillion, bn/mn, B/M)
 *  - cagr: a percentage next to "CAGR" / "compound annual growth"
 * Other scales (crore, lakh, thousand) and money without a scale are ignored.
 */

export interface ExtractFactsInput {
  text: string;
  title: string;
  url: string;
  retrievedAt: string;
  publishedAt?: string;
  /** Extra geography names (e.g. markets not in the built-in list). */
  extraGeographies?: string[];
  policy?: SourcePolicy;
}

// ---------------------------------------------------------------- geography

const geoCache = new Map<string, { names: string[]; re: RegExp }>();

function geoMatcher(extra: readonly string[]): { names: string[]; re: RegExp } {
  const key = [...extra].sort().join('\u0001');
  let m = geoCache.get(key);
  if (!m) {
    const names = [...new Set([...COUNTRIES, ...REGIONS, ...extra])].sort((a, b) => b.length - a.length || a.localeCompare(b));
    const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    m = { names, re: new RegExp(`(?<![A-Za-z])(${alt})(?![A-Za-z])`, 'gi') };
    geoCache.set(key, m);
  }
  return m;
}

const ALIAS_RE = new RegExp(
  `(?<![A-Za-z.])(${Object.keys(GEOGRAPHY_ALIASES).map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-z])`,
  'g',
);

export interface GeographyMention {
  start: number;
  end: number;
  name: string;
}

/** Geography mentions with offsets, canonical names, ordered by position. */
export function findGeographyMentions(text: string, extra: readonly string[] = []): GeographyMention[] {
  const { names, re } = geoMatcher(extra);
  const found: GeographyMention[] = [];
  const canon = new Map(names.map((n) => [n.toLowerCase(), n]));
  for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
    const n = canon.get(m[1]!.toLowerCase());
    const start = m.index ?? 0;
    if (n) found.push({ start, end: start + m[0].length, name: GEOGRAPHY_ALIASES[n] ?? n });
  }
  for (const m of text.matchAll(new RegExp(ALIAS_RE.source, ALIAS_RE.flags))) {
    const n = GEOGRAPHY_ALIASES[m[1]!];
    const start = m.index ?? 0;
    if (n) found.push({ start, end: start + m[0].length, name: n });
  }
  return found.sort((a, b) => a.start - b.start);
}

/** Distinct geographies mentioned in `text`, in order of first appearance, canonical names. */
export function findGeographies(text: string, extra: readonly string[] = []): string[] {
  return [...new Set(findGeographyMentions(text, extra).map((f) => f.name))];
}

function slugText(url: string): string {
  try {
    return new URL(url).pathname.replace(/[-_/]+/g, ' ');
  } catch {
    return '';
  }
}

/** Derives the market definition from a page title ("X Widget Market Outlook to 2030 | Site" -> "Widget Market"). */
export function marketDefinitionFromTitle(title: string, extraGeographies: readonly string[] = []): string | undefined {
  const head = title.split(/\s[|–—-]\s/)[0]?.trim() ?? '';
  const m = /^(.*?\bmarket)\b/i.exec(head);
  if (!m) return undefined;
  let def = m[1]!.trim().replace(/^the\s+/i, '');
  const { names } = geoMatcher(extraGeographies);
  const lower = def.toLowerCase();
  const prefix = ['global', 'worldwide', ...names.map((n) => n.toLowerCase())]
    .filter((n) => lower.startsWith(`${n} `))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix) def = def.slice(prefix.length).trim();
  return def.length > 0 && !/^market$/i.test(def) ? def : undefined;
}

// ------------------------------------------------------------------ periods

export interface PeriodMention {
  start: number;
  end: number;
  period: string;
}

const RANGE_RE = /\b((?:19|20)\d{2})\s*(-|–|—|to|through|until)\s*((?:19|20)\d{2}|\d{2})[EFef]?\b/gi;
const BETWEEN_RE = /\bbetween\s+((?:19|20)\d{2})\s+and\s+((?:19|20)\d{2})[EFef]?\b/gi;
const YEAR_RE =/\b(?:FY\s?)?((?:19|20)\d{2})[EFef]?\b/g;

function fullYear(startYear: string, end: string): string {
  return end.length === 2 ? `${startYear.slice(0, 2)}${end}` : end;
}

export function findPeriods(sentence: string, masked: Array<[number, number]>): PeriodMention[] {
  const inMask = (s: number, e: number) => masked.some(([ms, me]) => s < me && e > ms);
  const out: PeriodMention[] = [];
  const pushRange = (s: number, e: number, y0: string, y1: string) => {
    if (inMask(s, e) || Number(y1) <= Number(y0) || Number(y1) - Number(y0) > 60) return;
    if (out.some((r) => s < r.end && e > r.start)) return;
    out.push({ start: s, end: e, period: `${y0}-${y1}` });
  };
  for (const m of sentence.matchAll(BETWEEN_RE)) {
    pushRange(m.index ?? 0, (m.index ?? 0) + m[0].length, m[1]!, m[2]!);
  }
  for (const m of sentence.matchAll(RANGE_RE)) {
    const sep = m[2]!;
    const isDash = sep === '-' || sep === '–' || sep === '—';
    if (m[3]!.length === 2 && !isDash) continue;
    pushRange(m.index ?? 0, (m.index ?? 0) + m[0].length, m[1]!, fullYear(m[1]!, m[3]!));
  }
  for (const m of sentence.matchAll(YEAR_RE)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    if (inMask(s, e) || out.some((r) => s < r.end && e > r.start)) continue;
    out.push({ start: s, end: e, period: m[1]! });
  }
  return out.sort((a, b) => a.start - b.start);
}

// --------------------------------------------------------------- candidates

type Metric = 'market_size' | 'cagr';

interface Candidate {
  metric: Metric;
  start: number;
  end: number;
  value: number;
  unit: string;
  currency?: string;
  precision: number;
}

const MONEY_PREFIX_RE = new RegExp(
  `(?<![A-Za-z$])(${CURRENCY_PREFIX_PATTERN})\\s?(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s?([A-Za-z]+)\\b`,
  'g',
);
const MONEY_SUFFIX_RE = new RegExp(
  `(?<![\\w.,])(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)\\s?([A-Za-z]+)\\s+(${CURRENCY_WORD_PATTERN}|${CURRENCY_PREFIX_PATTERN.replace('|\\$', '')})\\b`,
  'gi',
);
const SIZE_TRIGGER_RE =
  /(valued|valuation|worth|reach|size|stood|estimated|projected|forecast|expected|anticipated|touch|surpass|cross|generat|revenue|grow to|rise to|climb|expand to|be at|was at|is at|stand at|reported)/i;
const MARKET_WORD_RE = /\b(market|industry|sector)\b/i;
const CAGR_TERM_RE = /\b(CAGR|compound(?:ed)? annual growth(?: rate)?|compound annual growth)\b/gi;
const PERCENT_RE = /(\d+(?:\.\d+)?)\s?(?:%|percent\b|per cent\b)/gi;

function moneyCandidates(sentence: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of sentence.matchAll(MONEY_PREFIX_RE)) {
    const currency = normalizeCurrency(m[1]!);
    const scale = normalizeScale(m[3]!);
    if (!currency || !scale) continue;
    const s = m.index ?? 0;
    out.push({
      metric: 'market_size',
      start: s,
      end: s + m[0].length,
      value: parseNumber(m[2]!),
      unit: makeMoneyUnit(currency, scale),
      currency,
      precision: decimalsOf(m[2]!),
    });
  }
  for (const m of sentence.matchAll(MONEY_SUFFIX_RE)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    if (out.some((o) => s < o.end && e > o.start)) continue;
    const scaleWord = m[2]!;
    const scale: Scale | undefined = normalizeScale(scaleWord);
    const currency = normalizeCurrency(m[3]!) ?? normalizeCurrency(m[3]!.toUpperCase());
    if (!currency || !scale) continue;
    out.push({
      metric: 'market_size',
      start: s,
      end: e,
      value: parseNumber(m[1]!),
      unit: makeMoneyUnit(currency, scale),
      currency,
      precision: decimalsOf(m[1]!),
    });
  }
  return out;
}

// "add USD 75.8 Mn of annual revenue", "an additional USD 40 Mn": a CHANGE in the market, not its size.
const INCREMENT_RE = /\b(add(?:s|ed|ing)?|incremental|additional|increase of|increment of)\b[^.]{0,25}$/i;
// The text between two amounts of a "from USD A in 2025 to USD B by 2031" pair.
const FROM_TO_BRIDGE_RE = /^\s*(?:(?:in|by|during|for)\s+)?(?:FY\s?)?(?:19|20)\d{2}[EFef]?\s+(?:to|and|through|until)\s*$/i;

function sizeContextOk(sentence: string, c: Candidate, prevEnd: number, prevAccepted: boolean): boolean {
  if (!MARKET_WORD_RE.test(sentence)) return false;
  const before = sentence.slice(Math.max(prevEnd, c.start - 90), c.start);
  if (INCREMENT_RE.test(before)) return false;
  // Second half of "expand from USD A in 2025 to USD B by 2031": B is a market size too.
  if (prevAccepted && FROM_TO_BRIDGE_RE.test(sentence.slice(prevEnd, c.start))) return true;
  const after = sentence.slice(c.end, c.end + 20);
  return SIZE_TRIGGER_RE.test(before) || /^\s*(market|industry|sector)/i.test(after);
}

function cagrCandidates(sentence: string): Candidate[] {
  const terms = [...sentence.matchAll(CAGR_TERM_RE)].map((m) => ({ s: m.index ?? 0, e: (m.index ?? 0) + m[0].length }));
  if (terms.length === 0) return [];
  const out: Candidate[] = [];
  for (const m of sentence.matchAll(PERCENT_RE)) {
    const s = m.index ?? 0;
    const e = s + m[0].length;
    let best = Infinity;
    for (const t of terms) {
      const gap = s >= t.e ? s - t.e : t.s >= e ? t.s - e : 0;
      best = Math.min(best, gap);
    }
    if (best > 60) continue;
    out.push({ metric: 'cagr', start: s, end: e, value: parseNumber(m[1]!), unit: 'percent', precision: decimalsOf(m[1]!) });
  }
  return out;
}

// ---------------------------------------------------------------- sentences

export function splitSentences(text: string): string[] {
  const protectedText = text
    .replace(/\bU\.S\./g, 'U\u0001S\u0001')
    .replace(/\b(approx|vs|etc|Inc|Ltd|No)\./g, '$1\u0001');
  return protectedText
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'(“])/)
    .map((s) => s.replace(/\u0001/g, '.').trim())
    .filter((s) => s.length > 0);
}

function quoteFor(sentence: string, c: Candidate): string {
  if (sentence.length <= 400) return sentence;
  const from = Math.max(0, c.start - 180);
  return sentence.slice(from, Math.min(sentence.length, c.end + 180)).trim();
}

interface SizePair {
  cagr: Candidate;
  period: string;
  consistent: boolean;
}

/**
 * Detects exactly two market sizes with distinct single-year periods plus one
 * CAGR in the same sentence. `consistent` is true when the stated CAGR equals
 * the CAGR computed from the two sizes (tolerance 0.15 percentage points, which
 * covers rounding of the printed sizes).
 */
function findSizePair(cands: readonly Candidate[], assigned: Map<Candidate, PeriodMention[]>): SizePair | undefined {
  const sizes = cands.filter((c) => c.metric === 'market_size');
  const cagrs = cands.filter((c) => c.metric === 'cagr');
  if (sizes.length !== 2 || cagrs.length !== 1) return undefined;
  const [a, b] = sizes as [Candidate, Candidate];
  const pa = assigned.get(a) ?? [];
  const pb = assigned.get(b) ?? [];
  if (pa.length !== 1 || pb.length !== 1) return undefined;
  const ya = pa[0]!.period;
  const yb = pb[0]!.period;
  if (!/^\d{4}$/.test(ya) || !/^\d{4}$/.test(yb) || Number(yb) <= Number(ya) || a.unit !== b.unit) return undefined;
  const cagr = cagrs[0]!;
  const computed = computeCagr(a.value, b.value, Number(yb) - Number(ya));
  return { cagr, period: `${ya}-${yb}`, consistent: computed !== undefined && Math.abs(computed - cagr.value) <= 0.15 };
}

// --------------------------------------------------------------- main entry

interface Proposed {
  fact: Fact;
  ambiguous: boolean;
}

function factId(f: Pick<Fact, 'metric' | 'period' | 'geography' | 'value' | 'unit' | 'sourceUrl'>): string {
  return `fact_${shortHash({ m: f.metric, p: f.period ?? null, g: f.geography ?? null, v: f.value, u: f.unit, s: f.sourceUrl })}`;
}

export function extractFacts(input: ExtractFactsInput): Fact[] {
  const policy = input.policy ?? defaultPolicy;
  const extraGeo = input.extraGeographies ?? [];
  const sourceType = classifyUrl(input.url, 'fact', policy);
  const hostTrusted = sourceType.allowed;

  const titleGeos = findGeographies(input.title, extraGeo);
  const slugGeos = findGeographies(slugText(input.url), extraGeo);
  const definition = marketDefinitionFromTitle(input.title, extraGeo);

  const proposals: Proposed[] = [];
  const seen = new Set<string>();

  for (const sentence of splitSentences(input.text)) {
    const money = moneyCandidates(sentence).sort((a, b) => a.start - b.start);
    const cands: Candidate[] = [];
    let prevEnd = 0;
    let prevAccepted = false;
    for (const c of money) {
      const accepted = sizeContextOk(sentence, c, prevEnd, prevAccepted);
      if (accepted) cands.push(c);
      prevEnd = c.end;
      prevAccepted = accepted;
    }
    cands.push(...cagrCandidates(sentence));
    if (cands.length === 0) continue;
    cands.sort((a, b) => a.start - b.start);

    const periods = findPeriods(sentence, cands.map((c) => [c.start, c.end]));
    const sentenceGeos = findGeographies(sentence, extraGeo);
    const hasGlobal = /\b(global|worldwide)\b/i.test(sentence);

    const gap = (c: { start: number; end: number }, p: { start: number; end: number }) =>
      p.start >= c.end ? p.start - c.end : c.start >= p.end ? c.start - p.end : 0;
    // Each period belongs to the nearest candidate; ties go to the earlier one.
    const assigned = new Map<Candidate, PeriodMention[]>(cands.map((c) => [c, []]));
    for (const p of periods) {
      let best = cands[0]!;
      for (const c of cands) if (gap(c, p) < gap(best, p)) best = c;
      assigned.get(best)!.push(p);
    }

    // "from USD A in Y1 to USD B by Y2 ... CAGR of r%": the CAGR spans Y1-Y2, and it is only
    // trusted when r matches the CAGR computed from A and B (an internal consistency check).
    const pair = findSizePair(cands, assigned);

    cands.forEach((c) => {
      const mine = assigned.get(c)!;
      let period: PeriodMention | undefined;
      let ambiguous = false;
      if (mine.length === 1) {
        period = mine[0];
      } else if (mine.length > 1) {
        period = [...mine].sort((a, b) => gap(c, a) - gap(c, b))[0];
        ambiguous = true;
      }
      if (pair && c === pair.cagr && mine.length === 0) {
        period = { start: 0, end: 0, period: pair.period };
        ambiguous = !pair.consistent;
      }

      let geography: string | undefined;
      if (sentenceGeos.length === 1) geography = sentenceGeos[0];
      else if (sentenceGeos.length > 1) geography = sentenceGeos.find((g) => titleGeos.includes(g)) ?? sentenceGeos[0];
      else if (hasGlobal) geography = 'Global';
      else geography = titleGeos[0] ?? slugGeos[0];

      const draft = {
        id: '',
        metric: c.metric,
        value: c.value,
        unit: c.unit,
        factType: 'observed' as const,
        sourceUrl: input.url,
        sourceTitle: input.title,
        sourceRetrievedAt: input.retrievedAt,
        sourceQuote: quoteFor(sentence, c),
        verificationStatus: 'unverified' as const,
        precision: c.precision,
        ...(c.currency ? { currency: c.currency } : {}),
        ...(period ? { period: period.period } : {}),
        ...(geography ? { geography } : {}),
        ...(definition ? { marketDefinition: definition } : {}),
        ...(input.publishedAt ? { sourcePublishedAt: input.publishedAt } : {}),
      };
      draft.id = factId(draft);
      const parsed = FactSchema.safeParse(draft);
      if (!parsed.success || seen.has(draft.id)) return;
      seen.add(draft.id);
      proposals.push({ fact: parsed.data, ambiguous });
    });
  }

  const facts = proposals.map(({ fact, ambiguous }): Fact => {
    const complete = fact.period !== undefined && (fact.metric !== 'market_size' || fact.currency !== undefined);
    return hostTrusted && complete && !ambiguous ? { ...fact, verificationStatus: 'verified' } : fact;
  });
  return markConflicts(facts);
}

// ---------------------------------------------------------------- conflicts

function conflictKey(f: Fact): string | undefined {
  if (!f.period) return undefined;
  return [f.metric, f.period, f.geography?.toLowerCase() ?? '', f.currency ?? parseFactUnit(f.unit).currency ?? ''].join('|');
}

/** Groups of facts that share metric + period + geography (+ currency) but disagree on value. */
export function findConflicts(facts: readonly Fact[]): Fact[][] {
  const groups = new Map<string, Fact[]>();
  for (const f of facts) {
    const k = conflictKey(f);
    if (!k) continue;
    const g = groups.get(k) ?? [];
    g.push(f);
    groups.set(k, g);
  }
  const conflicts: Fact[][] = [];
  for (const g of groups.values()) {
    const first = g[0]!;
    const base = toBaseValue(first.value, first.unit);
    const disagree = g.some((f) => {
      const b = toBaseValue(f.value, f.unit);
      return Math.abs(b - base) > Math.max(Math.abs(b), Math.abs(base)) * 1e-9;
    });
    if (disagree) conflicts.push(g);
  }
  return conflicts;
}

/** Returns facts with every member of a conflicting group marked 'conflicting'. */
export function markConflicts(facts: readonly Fact[]): Fact[] {
  const ids = new Set(findConflicts(facts).flatMap((g) => g.map((f) => f.id)));
  return facts.map((f) => (ids.has(f.id) ? { ...f, verificationStatus: 'conflicting' as const } : f));
}

// ------------------------------------------------------------------- derived

/** CAGR in percent: ((end / start) ^ (1 / years) - 1) * 100. Returns undefined for invalid input. */
export function computeCagr(startValue: number, endValue: number, years: number): number | undefined {
  if (!(startValue > 0) || !(endValue > 0) || !(years > 0) || !Number.isFinite(years)) return undefined;
  return ((endValue / startValue) ** (1 / years) - 1) * 100;
}

export const CAGR_FORMULA = 'CAGR = ((end_value / start_value) ^ (1 / years) - 1) * 100';

/**
 * Builds a derived CAGR fact from two market_size facts (same currency and
 * geography, single-year periods, end after start). Returns null when the
 * inputs cannot support it. The result is 'verified' only when both inputs are.
 */
export function deriveCagrFact(startFact: Fact, endFact: Fact): Fact | null {
  if (startFact.metric !== 'market_size' || endFact.metric !== 'market_size') return null;
  const y0 = /^(\d{4})$/.exec(startFact.period ?? '')?.[1];
  const y1 = /^(\d{4})$/.exec(endFact.period ?? '')?.[1];
  if (!y0 || !y1 || Number(y1) <= Number(y0)) return null;
  const u0 = parseFactUnit(startFact.unit);
  const u1 = parseFactUnit(endFact.unit);
  if (!u0.currency || u0.currency !== u1.currency) return null;
  if ((startFact.geography ?? '').toLowerCase() !== (endFact.geography ?? '').toLowerCase()) return null;
  const years = Number(y1) - Number(y0);
  const cagr = computeCagr(toBaseValue(startFact.value, startFact.unit), toBaseValue(endFact.value, endFact.unit), years);
  if (cagr === undefined) return null;
  const value = Math.round(cagr * 100) / 100;
  const retrievedAt =
    Date.parse(startFact.sourceRetrievedAt) >= Date.parse(endFact.sourceRetrievedAt) ? startFact.sourceRetrievedAt : endFact.sourceRetrievedAt;
  const draft = {
    id: '',
    metric: 'cagr',
    value,
    unit: 'percent',
    period: `${y0}-${y1}`,
    factType: 'derived' as const,
    derivation: { formula: CAGR_FORMULA, inputFactIds: [startFact.id, endFact.id] },
    precision: 2,
    sourceUrl: endFact.sourceUrl,
    sourceTitle: endFact.sourceTitle,
    sourceRetrievedAt: retrievedAt,
    verificationStatus:
      startFact.verificationStatus === 'verified' && endFact.verificationStatus === 'verified' ? ('verified' as const) : ('unverified' as const),
    ...(startFact.geography ? { geography: startFact.geography } : {}),
    ...(endFact.marketDefinition ? { marketDefinition: endFact.marketDefinition } : {}),
  };
  draft.id = `fact_${shortHash({ d: 'cagr', i: draft.derivation.inputFactIds, v: value })}`;
  const parsed = FactSchema.safeParse(draft);
  return parsed.success ? parsed.data : null;
}
