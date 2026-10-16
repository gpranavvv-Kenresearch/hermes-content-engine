export { classifyUrl, validateFetchedSource, hostMatchesDomain } from './source-validator.js';
export type { UrlClassification, FetchedUrls, SourceValidation } from './source-validator.js';
export {
  createSafeFetcher,
  SourceBlockedError,
  FetchProtocolError,
  USER_AGENT,
  MAX_REDIRECTS,
  MAX_BODY_BYTES,
} from './fetcher.js';
export type { SafeFetcherOptions, FetchImpl } from './fetcher.js';
export { extractContent, extractTables } from './content-extractor.js';
export type { ExtractedContent, ExtractedTable, ExtractionMethod } from './content-extractor.js';
export {
  extractFacts,
  findConflicts,
  markConflicts,
  computeCagr,
  deriveCagrFact,
  findGeographies,
  marketDefinitionFromTitle,
  CAGR_FORMULA,
} from './fact-extractor.js';
export type { ExtractFactsInput } from './fact-extractor.js';
export { extractNotes } from './note-extractor.js';
export type { ExtractNotesInput } from './note-extractor.js';
export { checkClaims, extractNumericClaims } from './claim-verifier.js';
export type { NumericClaim, ClaimKind } from './claim-verifier.js';
export {
  TavilySearchProvider,
  ExaSearchProvider,
  allowlistedSearch,
  loadKeysFromEnv,
  KeyPool,
} from './search-providers.js';
export type {
  TavilyLike,
  ExaLike,
  ProviderOptions,
  AllowlistedSearchOptions,
  AllowlistedSearchResult,
  DiscardedHit,
} from './search-providers.js';
