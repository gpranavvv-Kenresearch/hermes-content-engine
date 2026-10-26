import { gatherEvidence } from '../../../src/pipeline/gather-evidence.js';
import { extractContent } from '../../../src/evidence/content-extractor.js';
import type { LoadedConfig } from '../../../src/config/index.js';
import type { Fact, SourceNote } from '../../../src/schemas/index.js';
import { createSafeFetcher } from '../../../src/evidence/fetcher.js';
import { selectBriefFacts } from '../../../src/strategy/brief-builder.js';

export interface BlogEvidence {
  pageLoaded: boolean;
  /** The URL the report resolved to. Ken Research redirects some report URLs on purpose; the article uses this one. */
  finalUrl: string;
  redirected: boolean;
  error?: string;
  /** True when the page failed for a temporary reason (timeout, dropped connection, 5xx, 429). The row should be retried soon, not parked. */
  transient?: boolean;
  verifiedFigures: number;
  notes: number;
  /** Plain text of facts, notes and the report page, for the figures cross-check. */
  evidenceText: string;
  /**
   * The report page's own text (Ken Research's proprietary data, tables included), trimmed. The extractor only turns a few
   * statements into "verified facts"; ChatGPT reads the whole page, so the supervisor must be able to read it too.
   */
  pageText: string;
  /** What the supervisor reads at the evidence gate. */
  summary: string;
}

type Fetcher = NonNullable<Parameters<typeof gatherEvidence>[0]['fetcher']>;

const PAGE_TEXT_LIMIT = 45_000;

const TRANSIENT_RE = /timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up|network|HTTP 5\d\d|HTTP 429/i;
export function isTransientFetchError(message: string): boolean {
  return TRANSIENT_RE.test(message);
}

/** A report page that is slow once should not cost a whole run: retry temporary failures a few times before giving up. */
async function retryTransient<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientFetchError((error as Error).message ?? '') || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

const isSiteRoot = (url: string): boolean => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') === '';
  } catch {
    return false;
  }
};

const factLine = (f: Fact): string =>
  `${f.metric}: ${f.value}${f.unit ? ` ${f.unit}` : ''}${f.currency ? ` ${f.currency}` : ''}${f.period ? ` (${f.period})` : ''}${f.geography ? ` ${f.geography}` : ''}`;

function pad(f: Fact): string {
  // The article may print the number with the source's precision or rounded; list both so the cross-check can match.
  const forms = new Set<string>([String(f.value), f.value.toFixed(f.precision ?? 1), f.value.toFixed(0), f.value.toFixed(2)]);
  return [...forms].join(' ');
}

export async function gatherBlogEvidence(
  input: { url: string; title: string },
  deps: { config: LoadedConfig; fetcher?: Fetcher; now?: () => Date; retryDelayMs?: number },
): Promise<BlogEvidence> {
  const failed = (error: string): BlogEvidence => ({
    pageLoaded: false, finalUrl: input.url, redirected: false, error, transient: isTransientFetchError(error), verifiedFigures: 0, notes: 0, evidenceText: '', pageText: '',
    summary: `The report page did not load: ${error}`,
  });
  try {
    // Keep the fetched page so its text can be given to the supervisor without a second request.
    let page: { html: string; finalUrl: string } | undefined;
    const base = deps.fetcher ?? createSafeFetcher({ policy: deps.config.sourcePolicy, purpose: 'fact' });
    const capturing: Fetcher = async (url, options) => {
      const res = await base(url, options);
      page = { html: res.html, finalUrl: res.finalUrl };
      return res;
    };
    const got = await retryTransient(
      () => gatherEvidence({
        url: input.url,
        config: deps.config,
        fetcher: capturing,
        ...(deps.now ? { now: deps.now } : {}),
      }),
      3,
      deps.retryDelayMs ?? 3000,
    );
    const finalUrl = got.source.finalUrl || input.url;
    // A redirect to another report page is fine (the final URL is used). A redirect to the site root means no report.
    if (isSiteRoot(finalUrl)) return failed(`the URL redirected to the site root (${finalUrl}), not a report page`);
    const facts: Fact[] = got.factSet.facts;
    const notes: SourceNote[] = got.factSet.notes;
    const verified = selectBriefFacts(facts);
    const redirected = finalUrl.replace(/\/+$/, '') !== input.url.replace(/\/+$/, '');
    let pageText = '';
    if (page) {
      try {
        const content = await extractContent(page.html, page.finalUrl);
        pageText = (content.markdown ?? content.text).replace(/\n{3,}/g, '\n\n').trim().slice(0, PAGE_TEXT_LIMIT);
      } catch {
        pageText = '';
      }
    }
    const evidenceText = [...facts.map((f) => `${factLine(f)} ${pad(f)}`), ...notes.map((n) => n.text), pageText].join('\n');
    const summary = [
      `Report page loaded${redirected ? ` after a redirect (requested ${input.url}, resolved to ${finalUrl}; the article will use the resolved URL)` : ''}.`,
      `Row title: ${input.title}`,
      `${verified.length} verified figure(s) from 2024 or later, ${notes.length} source note(s).`,
      verified.length ? `Figures:\n${verified.slice(0, 14).map((f) => `- ${factLine(f)}`).join('\n')}` : 'No verified figures on the page; the article will rely on ChatGPT research and government sources.',
      notes.length ? `Notes:\n${notes.slice(0, 8).map((n) => `- ${n.text.slice(0, 220)}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    return { pageLoaded: true, finalUrl, redirected, verifiedFigures: verified.length, notes: notes.length, evidenceText, pageText, summary };
  } catch (error) {
    return failed((error as Error).message);
  }
}
