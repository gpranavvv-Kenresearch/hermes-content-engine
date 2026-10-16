import type { Fact, ValidationIssue } from './schemas/index.js';

/**
 * Interfaces shared between modules so they can be built and tested
 * independently. Nothing here has runtime dependencies on a browser or network.
 */

// --- LLM provider (the ChatGPT browser driver implements this) -------------

export interface LlmRequest {
  prompt: string;
  /** What the call is for ("draft", "sanity-rewrite", ...), used for logs and budgets. */
  purpose: string;
  /** Hint that a long reply is expected (longer timeout, file-attach delivery). */
  expectLong?: boolean;
  /** Upper bound on generated tokens for API/local providers (the browser driver ignores it). */
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface LlmResult {
  text: string;
  /** False when the reply looks cut off (still generating, truncated, no end marker). */
  complete: boolean;
  provider: string;
  elapsedMs: number;
}

export interface LlmProvider {
  readonly id: string;
  generate(request: LlmRequest): Promise<LlmResult>;
}

// --- HTTP fetch and search --------------------------------------------------

export interface FetchResult {
  requestedUrl: string;
  /** URL after redirects. */
  finalUrl: string;
  status: number;
  html: string;
}

export type Fetcher = (url: string, options?: { signal?: AbortSignal }) => Promise<FetchResult>;

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface SearchQuery {
  query: string;
  includeDomains?: string[];
  maxResults?: number;
  /** Why the search runs. Providers may use it to enforce source policy. */
  purpose?: 'fact' | 'planning';
  signal?: AbortSignal;
}

export interface SearchProvider {
  readonly id: string;
  search(query: SearchQuery): Promise<SearchHit[]>;
}

// --- Claim checking (evidence layer implements, validation layer calls) -----

export type ClaimStatus = 'supported' | 'derived' | 'conflicting' | 'unsupported' | 'ignored';

export interface ClaimMapping {
  claim: string;
  status: ClaimStatus;
  factId?: string;
  note?: string;
}

export interface ClaimCheckResult {
  issues: ValidationIssue[];
  mappings: ClaimMapping[];
}

export type ClaimChecker = (text: string, facts: readonly Fact[]) => ClaimCheckResult;

// --- Model output format ----------------------------------------------------

export const OUTPUT_BEGIN = '<<<CE_OUTPUT>>>';
export const OUTPUT_END = '<<<CE_END>>>';
export const FACT_IDS_PREFIX = 'FACT_IDS:';
export const TEXT_MARKER = '---TEXT---';

export interface ModelOutput {
  factIds: string[];
  text: string;
  /** True when the text was salvaged from a reply that did not follow the output format. */
  salvaged?: boolean;
}

export type ParseOutcome =
  | { ok: true; output: ModelOutput }
  | { ok: false; reason: 'missing_begin' | 'missing_end' | 'missing_text' | 'empty_text' };

/** The instruction block every generation prompt must include so replies can be parsed. */
export function outputFormatInstruction(): string {
  return [
    'Reply in EXACTLY this format and nothing else outside it:',
    OUTPUT_BEGIN,
    `${FACT_IDS_PREFIX} <comma-separated ids of the facts you used, or "none">`,
    TEXT_MARKER,
    '<the final text only>',
    OUTPUT_END,
  ].join('\n');
}

/**
 * Parses a reply in the format above. Uses the LAST begin marker (the model
 * may echo the instructions first). A missing end marker means the reply was
 * truncated or still streaming, which callers must treat as incomplete.
 */
export function parseModelOutput(raw: string): ParseOutcome {
  const begin = raw.lastIndexOf(OUTPUT_BEGIN);
  if (begin < 0) return { ok: false, reason: 'missing_begin' };
  const afterBegin = raw.slice(begin + OUTPUT_BEGIN.length);
  const end = afterBegin.indexOf(OUTPUT_END);
  if (end < 0) return { ok: false, reason: 'missing_end' };
  const body = afterBegin.slice(0, end);

  const textIdx = body.indexOf(TEXT_MARKER);
  if (textIdx < 0) return { ok: false, reason: 'missing_text' };

  const header = body.slice(0, textIdx);
  const text = body.slice(textIdx + TEXT_MARKER.length).trim();
  if (text.length === 0) return { ok: false, reason: 'empty_text' };

  const idsLine = header.split('\n').map((l) => l.trim()).find((l) => l.toUpperCase().startsWith(FACT_IDS_PREFIX));
  const idsRaw = idsLine ? idsLine.slice(FACT_IDS_PREFIX.length).trim() : '';
  const factIds =
    idsRaw === '' || idsRaw.toLowerCase() === 'none'
      ? []
      : idsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  return { ok: true, output: { factIds, text } };
}

// Only lines that open with a "reply wrapper" word are dropped. A real heading such as
// "Key takeaways:" or "Three shifts shaping the market:" must survive.
const PREAMBLE_RE =
  /^(sure|certainly|okay|ok|absolutely|here|revised|updated|rewritten|final|edited|corrected|improved|below|this is|the (?:revised|updated|rewritten|final|corrected))\b.*:\s*$/i;
const LABEL_RE = /^(tweet|post|caption|draft|linkedin post|facebook post|text)\s*:\s*/i;

/**
 * Best-effort cleanup of a reply that ignored the output format: code fences,
 * echoed markers, a chatty one-line preamble ("Sure! Here's the post:"), a
 * leading label, and wrapping quotes. Returns null when nothing is left.
 * It only removes obvious wrapper noise; whether the remaining text is
 * acceptable is decided by the validators, not here.
 */
export function salvagePlainText(raw: string): string | null {
  let t = raw.trim();
  const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fence) t = fence[1]!.trim();
  t = t
    // Models often drop or add an angle bracket: <<<CE_OUTPUT>> or <<<CE_END>>>>.
    .replace(/<{2,4}CE_[A-Z_]+>{1,4}/g, '')
    .replace(new RegExp(`${OUTPUT_BEGIN}|${OUTPUT_END}|${TEXT_MARKER}`, 'g'), '')
    .replace(/^FACT_IDS:.*$/gim, '')
    .trim();
  const lines = t.split('\n');
  while (lines.length > 1 && PREAMBLE_RE.test(lines[0]!.trim()) && lines[0]!.trim().length < 140) lines.shift();
  t = lines.join('\n').trim().replace(LABEL_RE, '');
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"') && t.split('"').length === 3) t = t.slice(1, -1);
  t = t.trim();
  return t.length > 0 ? t : null;
}

/**
 * Like parseModelOutput, for providers that do not reliably follow the output
 * format (small local or free-tier models). A well-formed reply is parsed
 * normally. A reply with no markers at all, or with markers but no text marker,
 * is salvaged and flagged `salvaged: true`. A reply that STARTS the format but
 * never ends it (missing_end) is still a failure: that is a truncated reply
 * and is never salvaged.
 */
export function parseModelOutputLenient(raw: string): ParseOutcome {
  const strict = parseModelOutput(raw);
  if (strict.ok) return strict;
  if (strict.reason === 'missing_end') return strict;
  const text = salvagePlainText(raw);
  if (text === null) return { ok: false, reason: strict.reason === 'missing_begin' ? 'empty_text' : strict.reason };
  return { ok: true, output: { factIds: [], text, salvaged: true } };
}
