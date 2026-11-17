/** Every signal carries where it came from and when. A failed collection is UNKNOWN, never zero. */
export type SignalStatus = 'OK' | 'EMPTY' | 'THROTTLED' | 'DATA_UNAVAILABLE';

export interface Provenance {
  source: 'google-autosuggest' | 'google-trends-rss' | 'gdelt-doc';
  method: string; // exact request, so the collection can be reproduced
  collectedAt: string; // ISO timestamp
  country: string | null;
  language: string | null;
}

export interface SuggestRecord {
  seedQuery: string;
  returnedPrediction: string;
  intentClass: string;
  verifiedPrediction: true; // returned by Google, not guessed by a model
  provenance: Provenance;
}

export interface TrendItem {
  title: string;
  approxTraffic: string | null;
  publishedAt: string | null;
  news: Array<{ title: string; url: string; source: string | null }>;
  provenance: Provenance;
}

export interface GdeltArticle {
  title: string;
  url: string;
  domain: string;
  language: string | null;
  sourceCountry: string | null;
  seenAt: string | null;
  provenance: Provenance;
}

export interface Collected<T> {
  status: SignalStatus;
  items: T[];
  note?: string;
}
