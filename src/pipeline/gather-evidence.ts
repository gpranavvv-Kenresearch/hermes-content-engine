import type { LoadedConfig } from '../config/index.js';
import type { Fetcher } from '../contracts.js';
import { EngineError } from '../errors.js';
import { classifyUrl, createSafeFetcher, extractContent, extractFacts, extractNotes, validateFetchedSource } from '../evidence/index.js';
import { FactSetSchema, type FactSet, type SourceRecord } from '../schemas/index.js';
import { shortHash } from '../utils/hash.js';

export interface GatherEvidenceInput {
  /** A Ken Research (or approved government) report page. */
  url: string;
  config: LoadedConfig;
  /** Injectable for tests. Default: the redirect-validating safe fetcher for purpose 'fact'. */
  fetcher?: Fetcher;
  now?: () => Date;
}

export interface GatherEvidenceResult {
  factSet: FactSet;
  source: SourceRecord;
  extractionMethod: string;
}

/**
 * Fetches ONE allowlisted report page and turns it into claim-level facts.
 * Order of defence:
 *  1. the requested URL must already pass the 'fact' source policy (nothing is
 *     fetched otherwise);
 *  2. the safe fetcher validates every redirect hop before following it;
 *  3. the FINAL url and the page's canonical url are validated again here, so a
 *     canonical tag pointing at a disallowed host fails the whole source.
 * Regex only proposes facts; nothing here calls an LLM.
 */
export async function gatherEvidence(input: GatherEvidenceInput): Promise<GatherEvidenceResult> {
  const { config } = input;
  const now = input.now ?? (() => new Date());
  const policy = config.sourcePolicy;

  const pre = classifyUrl(input.url, 'fact', policy);
  if (!pre.allowed) {
    throw new EngineError(`Refusing to fetch "${input.url}" for facts: ${pre.reason}`, 'fatal', 'SOURCE_BLOCKED', {
      detail: { url: input.url, reason: pre.reason },
    });
  }

  const fetcher = input.fetcher ?? createSafeFetcher({ policy, purpose: 'fact' });
  const page = await fetcher(input.url);
  if (page.status < 200 || page.status >= 300) {
    throw new EngineError(
      `Fetching "${input.url}" returned HTTP ${page.status}`,
      page.status >= 500 || page.status === 429 ? 'retryable' : 'fatal',
      'HTTP_ERROR',
      { detail: { url: input.url, status: page.status } },
    );
  }

  const content = await extractContent(page.html, page.finalUrl);
  const validation = validateFetchedSource(
    {
      requestedUrl: page.requestedUrl,
      finalUrl: page.finalUrl,
      ...(content.canonicalUrl ? { canonicalUrl: content.canonicalUrl } : {}),
    },
    'fact',
    policy,
    { now: now() },
  );
  if (!validation.allowed) {
    throw new EngineError(`Source rejected after fetch: ${validation.record.reason}`, 'fatal', 'SOURCE_BLOCKED', {
      detail: { record: validation.record },
    });
  }

  const retrievedAt = now().toISOString();
  const facts = extractFacts({
    text: content.text,
    title: content.title,
    url: page.finalUrl,
    retrievedAt,
    ...(content.publishedAt ? { publishedAt: content.publishedAt } : {}),
    policy,
  });

  const notes = extractNotes({ text: content.text, url: page.finalUrl, competitors: config.competitors });

  const factSet = FactSetSchema.parse({
    itemId: `item_${shortHash(content.canonicalUrl ?? page.finalUrl, 12)}`,
    reportUrl: page.finalUrl,
    facts,
    notes,
    createdAt: retrievedAt,
  });
  return { factSet, source: validation.record, extractionMethod: content.method };
}
