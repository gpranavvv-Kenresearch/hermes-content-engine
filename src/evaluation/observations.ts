/**
 * OBSERVED metrics: things measured in the real world after publishing. These
 * are types only. The content scorer (scoring.ts) never computes, estimates or
 * fills these in, and they never enter `overall`. If no observation exists the
 * array is simply empty; absence is not a score of zero.
 */

/** Shared fields of every observation. */
export interface ObservationBase {
  /** ISO timestamp of when the measurement was taken. */
  observedAt: string;
  /** What produced the number, e.g. "perplexity-manual-check" or "search-console-export". */
  source: string;
  /** The query / prompt the observation is about. */
  query: string;
}

/** Result of one AI-search check: was the page/brand cited for this query on this engine. */
export interface CitationVisibilityObservation extends ObservationBase {
  kind: 'citationVisibility';
  /** Engine or product checked, e.g. "perplexity", "chatgpt-search", "google-ai-overview". */
  engine: string;
  /** Was one of our URLs cited in the answer. */
  cited: boolean;
  /** The cited URL (ours), if cited. */
  citedUrl?: string;
  /** Position of the citation among the answer's sources (1 = first), if the engine shows one. */
  citationPosition?: number;
  /** Free-form note, e.g. locale or logged-in state. Observations are not reproducible across runs. */
  note?: string;
}

/** One row of Search Console style data. */
export interface SearchPerformanceObservation extends ObservationBase {
  kind: 'searchPerformance';
  /** Page the row is about, if the export is per page. */
  page?: string;
  /** Inclusive reporting window, ISO dates. */
  dateRange: { start: string; end: string };
  clicks: number;
  impressions: number;
  /** clicks / impressions, 0..1, as reported by the source (not recomputed). */
  ctr: number;
  /** Average position as reported by the source. */
  position: number;
  country?: string;
  device?: string;
}

export interface ObservedMetrics {
  citationVisibility: CitationVisibilityObservation[];
  searchPerformance: SearchPerformanceObservation[];
}

export const NO_OBSERVATIONS: ObservedMetrics = { citationVisibility: [], searchPerformance: [] };
