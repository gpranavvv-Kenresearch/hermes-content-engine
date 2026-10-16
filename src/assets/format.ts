import type { Fact } from '../schemas/index.js';

/** Locale-independent number formatting (no ICU variance): thousands commas, fixed decimals. */
export function formatNumber(value: number, precision?: number): string {
  const decimals = precision ?? (Number.isInteger(value) ? 0 : Math.min(4, (String(value).split('.')[1] ?? '').length));
  const fixed = Math.abs(value).toFixed(decimals);
  const [int = '0', frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = value < 0 && Number(fixed) !== 0 ? '-' : '';
  return `${sign}${grouped}${frac ? `.${frac}` : ''}`;
}

/** The unit exactly as it should appear next to the value, e.g. "%" or "USD billion". */
export function unitLabel(fact: Pick<Fact, 'unit' | 'currency'>): string {
  const unit = fact.unit.trim();
  if (/^(percent|percentage|%)$/i.test(unit)) return '%';
  if (fact.currency && !unit.toLowerCase().includes(fact.currency.toLowerCase())) return `${fact.currency} ${unit}`;
  return unit;
}

/** "42.5 USD billion" or "12.5%". */
export function formatFactValue(fact: Pick<Fact, 'value' | 'unit' | 'currency' | 'precision'>): string {
  const num = formatNumber(fact.value, fact.precision);
  const unit = unitLabel(fact);
  return unit === '%' ? `${num}%` : `${num} ${unit}`;
}

/** "market_size" -> "Market size". */
export function metricLabel(metric: string): string {
  const spaced = metric.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
