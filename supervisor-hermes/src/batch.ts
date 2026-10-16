import type { RowResult } from './types.js';

export interface BatchOptions<P extends { rowIndex: number }> {
  count: number;
  /** Failed rows in a row that end the batch. */
  maxFailures: number;
  /** Rows with no usable evidence that are tolerated before giving up. */
  maxSkips: number;
  next(): P | null;
  process(pick: P): Promise<RowResult>;
  onSkip?(pick: P, result: RowResult): Promise<void>;
  /** A fixed --row: process that one row only. */
  fixedRow?: boolean;
}

export interface BatchSummary {
  approved: number;
  skipped: number;
  failures: number;
  results: RowResult[];
  /** No row was left to pick. */
  exhausted: boolean;
}

/** The loop shared by the CLI and its tests. A skipped row (no usable evidence) is not a failure. */
export async function runBatch<P extends { rowIndex: number }>(options: BatchOptions<P>): Promise<BatchSummary> {
  const summary: BatchSummary = { approved: 0, skipped: 0, failures: 0, results: [], exhausted: false };
  while (summary.approved < options.count && summary.failures < options.maxFailures && summary.skipped < options.maxSkips) {
    const pick = options.next();
    if (!pick) {
      summary.exhausted = true;
      break;
    }
    const result = await options.process(pick);
    summary.results.push(result);
    if (result.status === 'approved') {
      summary.approved++;
      summary.failures = 0;
    } else if (result.noEvidence) {
      summary.skipped++;
      await options.onSkip?.(pick, result);
    } else {
      summary.failures++;
    }
    if (options.fixedRow) break;
  }
  return summary;
}

const normUrl = (s: string): string => s.trim().replace(/\/+$/, '').toLowerCase();

/** 1-based row numbers whose cells hold a URL that an earlier run found unusable. */
export function excludeSkippedRows(rows: readonly (readonly string[])[], skippedUrls: readonly string[]): Set<number> {
  const urls = new Set(skippedUrls.map(normUrl));
  const out = new Set<number>();
  rows.forEach((row, index) => {
    if (index > 0 && row.some((cell) => urls.has(normUrl(cell)))) out.add(index + 1);
  });
  return out;
}
