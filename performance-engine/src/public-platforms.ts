import { JSDOM } from 'jsdom';
import { CollectionError, emptyMetrics, metricNames, type Account, type Adapter, type Collection, type Metrics, type Platform, type Post } from './contracts.js';
import { parsePostUrl } from './urls.js';

export interface PublicPage { url: string; status: number; html: string; }
export type FetchPublicPage = (url: string) => Promise<PublicPage>;
export type FetchPublicJson = (url: string) => Promise<unknown>;

const HOSTS: Record<Platform, RegExp> = {
  x: /^(?:www\.)?(?:x\.com|twitter\.com)$/i,
  facebook: /^(?:www\.|m\.|web\.)?facebook\.com$/i,
  linkedin: /^(?:www\.)?linkedin\.com$/i,
  tumblr: /^(?:www\.)?(?:tumblr\.com|[a-z0-9-]+\.tumblr\.com)$/i,
};

const safeCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export function parseVisibleCount(value: string): number | null {
  const normalized = value.trim().replace(/,/g, '').toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*([kmb])?$/.exec(normalized);
  if (!match) return null;
  const scale = match[2] === 'k' ? 1_000 : match[2] === 'm' ? 1_000_000 : match[2] === 'b' ? 1_000_000_000 : 1;
  const result = Math.round(Number(match[1]) * scale);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

const defaultPage: FetchPublicPage = async rawUrl => {
  let response: Response;
  try {
    response = await fetch(rawUrl, { redirect: 'follow', signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36', accept: 'text/html,application/xhtml+xml' } });
  } catch { throw new CollectionError('retry', 'Public page request failed or timed out.'); }
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    throw new CollectionError(response.status === 429 || response.status >= 500 ? 'retry' : response.status === 404 || response.status === 410 ? 'unavailable' : 'blocked', `Public page returned HTTP ${response.status}.`, retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined);
  }
  const platform = parsePostUrl(rawUrl).platform;
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== 'https:' || !HOSTS[platform].test(finalUrl.hostname)) throw new CollectionError('blocked', 'Public post redirected outside the expected platform.');
  const type = response.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('text/html')) throw new CollectionError('unavailable', 'Public post did not return an HTML page.');
  const html = await response.text();
  if (html.length > 12_000_000) throw new CollectionError('unavailable', 'Public page exceeded the safe extraction limit.');
  return { url: response.url, status: response.status, html };
};

const defaultJson: FetchPublicJson = async url => {
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Mozilla/5.0' } }); }
  catch { throw new CollectionError('retry', 'Public data service failed or timed out.'); }
  if (!response.ok) throw new CollectionError(response.status === 429 || response.status >= 500 ? 'retry' : response.status === 404 ? 'unavailable' : 'blocked', `Public data service returned HTTP ${response.status}.`);
  try { return await response.json(); } catch { throw new CollectionError('retry', 'Public data service returned invalid JSON.'); }
};

const renderedPage: FetchPublicPage = async rawUrl => {
  let browser: Awaited<ReturnType<(typeof import('playwright'))['chromium']['launch']>> | undefined;
  try {
    const { chromium } = await import('playwright');
    try { browser = await chromium.launch({ headless: true }); }
    catch { browser = await chromium.launch({ headless: true, channel: process.env.PE_BROWSER_CHANNEL?.trim() || 'chrome' }); }
    const context = await browser.newContext();
    const page = await context.newPage();
    const response = await page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(1_500);
    const finalUrl = page.url(); const platform = parsePostUrl(rawUrl).platform; const final = new URL(finalUrl);
    if (final.protocol !== 'https:' || !HOSTS[platform].test(final.hostname)) throw new CollectionError('blocked', 'Rendered public post redirected outside the expected platform.');
    const html = await page.content();
    if (html.length > 12_000_000) throw new CollectionError('unavailable', 'Rendered public page exceeded the safe extraction limit.');
    return { url: finalUrl, status: response?.status() ?? 200, html };
  } catch (error) {
    if (error instanceof CollectionError) throw error;
    throw new CollectionError('unavailable', 'Fresh public browser could not expose this post.');
  } finally { await browser?.close(); }
};

function objects(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) for (const child of value) objects(child, output);
  else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>; output.push(record);
    for (const child of Object.values(record)) objects(child, output);
  }
  return output;
}

const asText = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const isoDate = (value: unknown): string | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const ms = typeof value === 'number' && value < 10_000_000_000 ? value * 1000 : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
};
const labelMetric = (label: string): keyof Metrics | undefined => {
  const value = label.toLowerCase();
  if (/impression/.test(value)) return 'impressions';
  if (/\breach\b/.test(value)) return 'reach';
  if (/view|watch/.test(value)) return 'views';
  if (/reaction/.test(value)) return 'reactions';
  if (/\blike/.test(value)) return 'likes';
  if (/comment|repl(?:y|ies)/.test(value)) return 'comments';
  if (/repost|retweet|\bshare/.test(value)) return 'shares';
  if (/\bquote/.test(value)) return 'quotes';
  if (/bookmark|\bsave/.test(value)) return 'saves';
  if (/\bnote/.test(value)) return 'notes';
  return undefined;
};

function setMetric(metrics: Metrics, definitions: Record<string, string>, key: keyof Metrics | undefined, value: unknown, definition: string): void {
  if (!key || metrics[key] !== null) return;
  const n = typeof value === 'string' ? parseVisibleCount(value) : safeCount(value);
  if (n !== null) { metrics[key] = n; definitions[key] = definition; }
}

export function extractPublicHtml(platform: Platform, page: PublicPage): Collection {
  const dom = new JSDOM(page.html, { url: page.url }); const document = dom.window.document;
  const metrics = emptyMetrics(); const definitions: Record<string, string> = {};
  let text: string | undefined; let publishedAt: string | undefined;
  const jsonLd: unknown[] = [];
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')]) {
    try { jsonLd.push(JSON.parse(script.textContent ?? '')); } catch { /* malformed page data is ignored */ }
  }
  for (const item of objects(jsonLd)) {
    text ??= asText(item.articleBody) ?? asText(item.text) ?? asText(item.description) ?? asText(item.headline);
    publishedAt ??= isoDate(item.datePublished) ?? isoDate(item.uploadDate) ?? isoDate(item.dateCreated);
    const type = item['@type'];
    const interaction = item.interactionType;
    const interactionLabel = typeof interaction === 'string' ? interaction : asText((interaction as Record<string, unknown> | undefined)?.['@type']);
    const label = interactionLabel ?? (typeof type === 'string' ? type : undefined) ?? asText(item.name) ?? '';
    setMetric(metrics, definitions, labelMetric(label), item.userInteractionCount ?? item.interactionCount ?? item.count, `Public JSON-LD interaction statistic (${label || 'unlabeled'}).`);
  }
  const meta = (selector: string) => asText(document.querySelector(selector)?.getAttribute('content'));
  text ??= meta('meta[property="og:description"]') ?? meta('meta[name="description"]');
  publishedAt ??= isoDate(meta('meta[property="article:published_time"]')) ?? isoDate(document.querySelector('time[datetime]')?.getAttribute('datetime'));
  const selectors: Record<Platform, string[]> = {
    linkedin: ['[data-test-id="main-feed-activity-card__commentary"]', '.feed-shared-update-v2__description', '.feed-shared-text', 'article'],
    facebook: ['[data-ad-preview="message"]', '[data-testid="post_message"]', 'article'],
    tumblr: ['[data-testid="post-content"]', 'article'],
    x: ['article [data-testid="tweetText"]', 'article'],
  };
  for (const selector of selectors[platform]) { const value = asText(document.querySelector(selector)?.textContent); if (value) { text ??= value; break; } }
  const candidates = [...document.querySelectorAll('[aria-label], [title], [data-count]')].slice(0, 5000);
  for (const element of candidates) {
    const label = element.getAttribute('aria-label') ?? element.getAttribute('title') ?? '';
    const match = /(?:^|\s)(\d[\d,.]*\s*[kmb]?)(?:\s+)(views?|impressions?|reach|likes?|reactions?|comments?|replies|shares?|reposts?|retweets?|quotes?|bookmarks?|saves?|notes?)(?:\b|$)/i.exec(label)
      ?? /(?:views?|impressions?|reach|likes?|reactions?|comments?|replies|shares?|reposts?|retweets?|quotes?|bookmarks?|saves?|notes?)\D{0,8}(\d[\d,.]*\s*[kmb]?)/i.exec(label);
    if (!match) continue;
    const metricLabel = match[2] ?? label;
    setMetric(metrics, definitions, labelMetric(metricLabel), match[1], `Visible public-page label: ${label.slice(0, 120)}`);
  }
  const body = (document.body?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 500_000);
  for (const match of body.matchAll(/(\d[\d,.]*\s*[kmb]?)\s+(views?|impressions?|likes?|reactions?|comments?|replies|shares?|reposts?|retweets?|quotes?|notes?)\b/gi)) setMetric(metrics, definitions, labelMetric(match[2]!), match[1], `Visible public-page text label: ${match[2]}.`);
  const available = metricNames.filter(key => metrics[key] !== null);
  const labeledText = candidates.map(element => element.getAttribute('aria-label') ?? element.getAttribute('title') ?? '').join(' ');
  const loginPrompt = platform === 'linkedin' && /(?:to view or add a comment|sign in|join now)/i.test(`${body} ${labeledText}`);
  if (!available.length && loginPrompt) definitions.visibility = 'LinkedIn public page showed a sign-in prompt and no numeric interaction counters; absent counters remain unknown.';
  return {
    metrics, definitions, scope: 'unknown', source: `${platform}-public-page`, publishedAt, text,
    raw: { requestedPlatform: platform, finalUrl: page.url, httpStatus: page.status, extraction: 'public HTML, JSON-LD and visible labels', availableMetrics: available, textFound: Boolean(text), publishedAt: publishedAt ?? null, publicLoginPrompt: loginPrompt },
  };
}

function xCollection(post: Post, raw: unknown): Collection {
  const root = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  if (root.code !== undefined && root.code !== 200) throw new CollectionError(root.code === 404 ? 'unavailable' : 'retry', `FxTwitter returned code ${String(root.code)}.`);
  const tweet = root.tweet && typeof root.tweet === 'object' ? root.tweet as Record<string, unknown> : undefined;
  if (!tweet) throw new CollectionError('unavailable', 'FxTwitter did not return the requested public post.');
  const returnedId = String(tweet.id ?? tweet.id_str ?? post.postId);
  if (returnedId !== post.postId) throw new CollectionError('blocked', 'Public X response did not match the requested post ID.');
  const metrics = emptyMetrics(); const definitions: Record<string, string> = {};
  setMetric(metrics, definitions, 'likes', tweet.likes, 'FxTwitter public tweet.likes.');
  setMetric(metrics, definitions, 'comments', tweet.replies, 'FxTwitter public tweet.replies.');
  setMetric(metrics, definitions, 'shares', tweet.retweets, 'FxTwitter public tweet.retweets; quotes excluded.');
  setMetric(metrics, definitions, 'quotes', tweet.quotes, 'FxTwitter public tweet.quotes.');
  setMetric(metrics, definitions, 'views', tweet.views, 'FxTwitter public tweet.views.');
  setMetric(metrics, definitions, 'saves', tweet.bookmarks, 'FxTwitter public tweet.bookmarks when exposed.');
  return { metrics, definitions, scope: 'unknown', source: 'x-public-fxtwitter', raw: { service: 'FxTwitter', tweetId: returnedId, availableMetrics: metricNames.filter(k => metrics[k] !== null) }, publishedAt: isoDate(tweet.created_at), text: asText(tweet.text) };
}

export class PublicUrlAdapters implements Adapter {
  constructor(private readonly getPage: FetchPublicPage = defaultPage, private readonly getJson: FetchPublicJson = defaultJson, private readonly getRenderedPage: FetchPublicPage | undefined = process.env.PE_PUBLIC_BROWSER === '1' ? renderedPage : undefined) {}
  async collect(post: Post, _account?: Account): Promise<Collection> {
    const identity = parsePostUrl(post.url, post.platform);
    if (identity.postId !== post.postId) throw new CollectionError('blocked', 'Stored post identity does not match its public URL.');
    if (post.platform === 'x' && identity.accountHint) {
      try { return xCollection(post, await this.getJson(`https://api.fxtwitter.com/${encodeURIComponent(identity.accountHint)}/status/${encodeURIComponent(post.postId)}`)); }
      catch (error) {
        if (error instanceof CollectionError && error.kind === 'blocked') throw error;
        // X repository pattern is primary; the public post HTML remains a no-key fallback.
      }
    }
    let result = extractPublicHtml(post.platform, await this.getPage(post.url));
    if (this.getRenderedPage && metricNames.every(key => result.metrics[key] === null)) {
      try {
        const rendered = extractPublicHtml(post.platform, await this.getRenderedPage(post.url));
        if (metricNames.some(key => rendered.metrics[key] !== null) || rendered.publishedAt || rendered.text) result = rendered;
      } catch { /* direct public metadata remains usable when optional rendering fails */ }
    }
    if (!result.publishedAt && !result.text && metricNames.every(key => result.metrics[key] === null)) throw new CollectionError('unavailable', 'The public page exposed no post data; it may require login or block automated visitors.');
    return result;
  }
}

export class UniversalAdapters implements Adapter {
  constructor(private readonly publicAdapter: Adapter, private readonly nativeAdapter?: Adapter, private readonly nativeFallback = false) {}
  async collect(post: Post, account?: Account): Promise<Collection> {
    let publicResult: Collection;
    try { publicResult = await this.publicAdapter.collect(post, account); }
    catch (publicError) {
      if (!this.nativeFallback || !this.nativeAdapter || !account) throw publicError;
      try { return await this.nativeAdapter.collect(post, account); }
      catch { throw publicError; }
    }
    if (!this.nativeFallback || !this.nativeAdapter || !account) return publicResult;
    try {
      const nativeResult = await this.nativeAdapter.collect(post, account);
      const metrics = emptyMetrics();
      for (const key of metricNames) metrics[key] = nativeResult.metrics[key] ?? publicResult.metrics[key];
      return {
        metrics,
        definitions: { ...publicResult.definitions, ...nativeResult.definitions },
        scope: nativeResult.scope,
        source: `${publicResult.source}+${nativeResult.source}`,
        raw: { public: publicResult.raw, native: nativeResult.raw },
        publishedAt: nativeResult.publishedAt ?? publicResult.publishedAt,
        text: nativeResult.text ?? publicResult.text,
        accountId: nativeResult.accountId ?? account.id,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Official analytics fallback failed.';
      return { ...publicResult, source: `${publicResult.source}+native-unavailable`, definitions: { ...publicResult.definitions, nativeFallback: reason } };
    }
  }
}
