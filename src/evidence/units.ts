/**
 * Shared unit helpers for fact extraction and claim verification.
 * Supported scales: trillion, billion, million (words and tn/bn/mn/B/M).
 * crore/lakh/thousand are deliberately NOT supported (ambiguous across
 * locales); numbers using them are never extracted or matched.
 */

export type Scale = 'trillion' | 'billion' | 'million';

export const SCALE_MULTIPLIER: Record<Scale, number> = {
  trillion: 1e12,
  billion: 1e9,
  million: 1e6,
};

/**
 * Maps a printed scale word to a canonical scale. Single letters are only
 * accepted in upper case ("B", "M") so that "m" (metres/minutes) and "b" never
 * count as scales.
 */
export function normalizeScale(word: string): Scale | undefined {
  if (word === 'B' || word === 'Bn' || word === 'BN') return 'billion';
  if (word === 'M' || word === 'Mn' || word === 'MN') return 'million';
  if (word === 'T' || word === 'Tn' || word === 'TN') return 'trillion';
  switch (word.toLowerCase()) {
    case 'trillion':
    case 'tn':
      return 'trillion';
    case 'billion':
    case 'bn':
      return 'billion';
    case 'million':
    case 'mn':
      return 'million';
    default:
      return undefined;
  }
}

const ISO_CURRENCIES = [
  'USD', 'INR', 'EUR', 'GBP', 'JPY', 'CNY', 'AUD', 'CAD', 'SGD', 'AED', 'SAR', 'KRW', 'BRL', 'ZAR', 'IDR', 'THB', 'MYR',
  'VND', 'PHP', 'NGN', 'EGP', 'KES', 'MXN', 'CHF', 'SEK', 'NOK', 'DKK', 'RUB', 'TRY', 'PKR', 'BDT', 'NZD', 'HKD', 'TWD',
] as const;

export const ISO_CURRENCY_SET: ReadonlySet<string> = new Set(ISO_CURRENCIES);

const SYMBOL_CURRENCY: Record<string, string> = {
  $: 'USD',
  'US$': 'USD',
  '₹': 'INR',
  Rs: 'INR',
  'Rs.': 'INR',
  '€': 'EUR',
  '£': 'GBP',
};

const WORD_CURRENCY: Record<string, string> = {
  dollar: 'USD',
  dollars: 'USD',
  'us dollar': 'USD',
  'us dollars': 'USD',
  'u.s. dollars': 'USD',
  rupee: 'INR',
  rupees: 'INR',
  euro: 'EUR',
  euros: 'EUR',
  pound: 'GBP',
  pounds: 'GBP',
};

/** Currency alternation for regexes, longest first. */
export const CURRENCY_PREFIX_PATTERN = `US\\$|${ISO_CURRENCIES.join('|')}|Rs\\.?|₹|€|£|\\$`;
export const CURRENCY_WORD_PATTERN = 'U\\.S\\. dollars?|US dollars?|dollars?|rupees?|euros?|pounds?';

export function normalizeCurrency(token: string): string | undefined {
  if (ISO_CURRENCY_SET.has(token)) return token;
  const sym = SYMBOL_CURRENCY[token];
  if (sym) return sym;
  return WORD_CURRENCY[token.toLowerCase()];
}

export interface ParsedUnit {
  currency?: string;
  scale?: Scale;
  percent: boolean;
}

/** Parses fact units such as "USD billion", "INR million", "percent". */
export function parseFactUnit(unit: string): ParsedUnit {
  const parts = unit.trim().split(/\s+/);
  const out: ParsedUnit = { percent: false };
  for (const p of parts) {
    if (/^(percent|%|pct)$/i.test(p)) out.percent = true;
    else if (ISO_CURRENCY_SET.has(p.toUpperCase())) out.currency = p.toUpperCase();
    else {
      const s = normalizeScale(p);
      if (s) out.scale = s;
    }
  }
  return out;
}

/** Value expressed in base units (e.g. USD billion 4.2 -> 4.2e9). Percent values are returned as printed. */
export function toBaseValue(value: number, unit: string): number {
  const u = parseFactUnit(unit);
  return u.scale ? value * SCALE_MULTIPLIER[u.scale] : value;
}

export function makeMoneyUnit(currency: string, scale: Scale): string {
  return `${currency} ${scale}`;
}

/** Number of decimals printed in a numeric literal ("1,234.50" -> 2). */
export function decimalsOf(printed: string): number {
  const m = /\.(\d+)/.exec(printed);
  return Math.min(m?.[1]?.length ?? 0, 6);
}

export function parseNumber(printed: string): number {
  return Number(printed.replace(/,/g, ''));
}

/** Granularity (smallest printed step) of a number printed with `decimals` decimals in the given unit. */
export function granularity(decimals: number, unit: string): number {
  const u = parseFactUnit(unit);
  return 10 ** -decimals * (u.scale ? SCALE_MULTIPLIER[u.scale] : 1);
}

/**
 * Does a claimed value agree with a fact, in base units? A claim may be
 * coarser than the fact (fact 4.23 supports "4.2") but never finer (fact 4.2
 * does not support "4.23") unless the two are numerically identical.
 */
export function matchesWithinPrecision(
  claimBase: number,
  claimGranularity: number,
  factBase: number,
  factGranularity: number,
): boolean {
  const tol = Math.max(Math.abs(factBase), Math.abs(claimBase), 1) * 1e-12;
  if (Math.abs(claimBase - factBase) <= tol) return true;
  if (claimGranularity < factGranularity * (1 - 1e-9)) return false;
  const half = claimGranularity / 2;
  // factBase must round to the claimed value at the claim's granularity.
  return Math.abs(claimBase - factBase) < half - tol || Math.abs(Math.abs(claimBase - factBase) - half) <= tol;
}
