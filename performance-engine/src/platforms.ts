import { Account, CollectionError, emptyMetrics, type Adapter, type Collection, type FetchJson, type Metrics, type Post } from './contracts.js';
import { requireNativePostId } from './urls.js';

export const fetchJson: FetchJson = async (url, init) => {
  let res: Response;
  try { res = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(30000), redirect: 'error' }); }
  catch { throw new CollectionError('retry', 'Platform request failed or timed out.'); }
  if (!res.ok) {
    const retry = res.headers.get('retry-after');
    const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : undefined;
    throw new CollectionError(res.status === 429 || res.status >= 500 ? 'retry' : res.status === 404 || res.status === 410 ? 'unavailable' : 'blocked', `Platform returned HTTP ${res.status}; check access/permissions for blocked responses.`, seconds);
  }
  try { const data = await res.json(); if ((data as any)?.error) throw new CollectionError('blocked', 'Platform reported an API error; verify permissions and metric names.'); return data; }
  catch (e) { if (e instanceof CollectionError) throw e; throw new CollectionError('retry', 'Platform response was not valid JSON.'); }
};
const count = (n: unknown): number | null => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
const str = (n: unknown): string | undefined => typeof n === 'string' && n.length > 0 ? n : undefined;
const token = (a: Account, env: NodeJS.ProcessEnv): string => {
  const value = a.tokenEnv ? env[a.tokenEnv]?.trim() : '';
  if (!value) throw new CollectionError('blocked', `Missing configured analytics credential${a.tokenEnv ? ` (${a.tokenEnv})` : ''}.`);
  return value;
};
function collection(source: string, raw: unknown, metrics: Metrics, definitions: Record<string, string>, scope: Collection['scope'] = 'all'): Collection { return { source, raw, metrics, definitions, scope }; }

export class NativeAdapters implements Adapter {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly get: FetchJson = fetchJson) {}
  async collect(post: Post, account?: Account): Promise<Collection> {
    if (!account) throw new CollectionError('blocked', 'Official analytics collection requires a configured account.');
    if (post.platform !== account.platform || post.accountId !== account.id) throw new CollectionError('blocked', 'Post/account identity does not match the configured analytics account.');
    switch (post.platform) {
      case 'x': return this.x(post, account);
      case 'facebook': return this.facebook(post, account);
      case 'linkedin': return this.linkedin(post, account);
      case 'tumblr': return this.tumblr(post, account);
    }
  }
  private async x(post: Post, account: Account): Promise<Collection> {
    const url = new URL(`https://api.x.com/2/tweets/${requireNativePostId(post.postId)}`);
    url.searchParams.set('tweet.fields', 'public_metrics,created_at,author_id');
    const raw = await this.get(url.href, { headers: { Authorization: `Bearer ${token(account, this.env)}` } });
    const d = raw.data;
    if (!d || d.id !== post.postId) throw new CollectionError('unavailable', 'X did not return the requested post.');
    if (account.nativeId && d.author_id !== account.nativeId) throw new CollectionError('blocked', 'X returned a different author than the configured account.');
    const m = emptyMetrics(); const p = d.public_metrics ?? {};
    m.impressions = count(p.impression_count); m.likes = count(p.like_count); m.comments = count(p.reply_count); m.shares = count(p.retweet_count); m.quotes = count(p.quote_count); m.saves = count(p.bookmark_count);
    return { ...collection('x-api-public', raw, m, { impressions: 'public_metrics.impression_count; combined organic/promoted', likes: 'like_count', comments: 'reply_count', shares: 'retweet_count; excludes quotes', quotes: 'quote_count', saves: 'bookmark_count' }), publishedAt: str(d.created_at), text: str(d.text) };
  }
  private async tumblr(post: Post, account: Account): Promise<Collection> {
    const blog = account.nativeId ?? account.handles[0];
    if (!blog || !/^[\w.-]+$/.test(blog)) throw new CollectionError('blocked', 'Configure the Tumblr blog name.');
    const url = new URL(`https://api.tumblr.com/v2/blog/${blog.endsWith('.tumblr.com') ? blog : `${blog}.tumblr.com`}/posts`);
    url.searchParams.set('id', requireNativePostId(post.postId)); url.searchParams.set('api_key', token(account, this.env)); url.searchParams.set('notes_info', 'false');
    const raw = await this.get(url.href); const d = raw.response?.posts?.find((p: any) => String(p.id_string ?? p.id) === post.postId);
    if (!d) throw new CollectionError('unavailable', 'Tumblr did not return the requested post.');
    const m = emptyMetrics(); m.notes = count(d.note_count);
    return { ...collection('tumblr-api', raw, m, { notes: 'Tumblr note_count; aggregate notes, not a separate like/share breakdown' }), publishedAt: typeof d.timestamp === 'number' ? new Date(d.timestamp * 1000).toISOString() : undefined };
  }
  private async facebook(post: Post, account: Account): Promise<Collection> {
    if (!/^v\d+\.\d+$/.test(account.apiVersion ?? '')) throw new CollectionError('blocked', 'Configure the supported Facebook Graph API version.');
    const id = requireNativePostId(post.nativePostId ?? post.postId);
    const node = id.includes('_') ? id : account.nativeId && /^\d+$/.test(account.nativeId) ? `${account.nativeId}_${id}` : id;
    const base = `https://graph.facebook.com/${account.apiVersion}/${node}`;
    const headers = { Authorization: `Bearer ${token(account, this.env)}` };
    const url = new URL(base); url.searchParams.set('fields', 'id,created_time,from,shares,reactions.limit(0).summary(true),comments.limit(0).summary(true)');
    const raw = await this.get(url.href, { headers });
    if (account.nativeId && raw.from?.id && raw.from.id !== account.nativeId) throw new CollectionError('blocked', 'Facebook post owner differs from configured account.');
    const m = emptyMetrics(); m.reactions = count(raw.reactions?.summary?.total_count); m.comments = count(raw.comments?.summary?.total_count); m.shares = count(raw.shares?.count);
    const definitions: Record<string, string> = { reactions: 'reactions.summary.total_count; all reaction types', comments: 'comments.summary.total_count', shares: 'shares.count; omitted value remains unknown' };
    let insightRaw: unknown = null; const names = Object.values(account.facebookInsights);
    if (names.length) {
      const insights = new URL(`${base}/insights`); insights.searchParams.set('metric', names.join(','));
      try {
        insightRaw = await this.get(insights.href, { headers });
        for (const [field, metric] of Object.entries(account.facebookInsights)) {
          const d = (insightRaw as any)?.data?.find((x: any) => x.name === metric);
          const values = d?.values;
          if (Array.isArray(values) && values.length === 1) { m[field as keyof Metrics] = count(values[0]?.value); definitions[field] = `Facebook configured insight ${metric}; ${d.period ?? 'unspecified period'}`; }
        }
      } catch (e) { if (!(e instanceof CollectionError) || e.kind === 'retry') throw e; definitions.insights = 'Configured insights unavailable; only basic interaction counts collected.'; }
    }
    return { ...collection('facebook-graph', { post: raw, insights: insightRaw }, m, definitions), publishedAt: str(raw.created_time) };
  }
  private async linkedin(post: Post, account: Account): Promise<Collection> {
    if (!/^\d{6}$/.test(account.apiVersion ?? '')) throw new CollectionError('blocked', 'Configure an active LinkedIn API version (YYYYMM).');
    const urn = post.nativeUrn;
    if (!urn || !/^urn:li:(ugcPost|share):\d+$/.test(urn)) throw new CollectionError('blocked', 'LinkedIn analytics needs the exact share/ugcPost URN. Supply it from the publisher or import; activity IDs are not assumed to be share IDs.');
    const headers = { Authorization: `Bearer ${token(account, this.env)}`, 'Linkedin-Version': account.apiVersion!, 'X-Restli-Protocol-Version': '2.0.0' };
    const m = emptyMetrics();
    if (account.kind === 'organization') {
      const org = account.nativeId;
      if (!org || !/^\d+$/.test(org)) throw new CollectionError('blocked', 'Configure numeric LinkedIn organization ID.');
      const query = urn.includes(':share:') ? 'shares' : 'ugcPosts';
      const url = `https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${encodeURIComponent(`urn:li:organization:${org}`)}&${query}=List(${encodeURIComponent(urn)})`;
      const raw = await this.get(url, { headers });
      const e = raw.elements?.find((x: any) => (x.share ?? x.ugcPost) === urn);
      if (!e) throw new CollectionError('unavailable', 'No per-post organization statistics returned; zero values were not inferred.');
      const s = e.totalShareStatistics ?? {};
      m.impressions = count(s.impressionCount); m.reach = count(s.uniqueImpressionsCount); m.likes = count(s.likeCount); m.comments = count(s.commentCount); m.shares = count(s.shareCount); m.clicks = count(s.clickCount);
      return collection('linkedin-organization', raw, m, { impressions: 'impressionCount', reach: 'uniqueImpressionsCount', likes: 'likeCount', comments: 'commentCount', shares: 'shareCount', clicks: 'clickCount' }, 'organic');
    }
    const raw: Record<string, unknown> = {}; const definitions: Record<string, string> = {};
    const queryTypes = [
      ['impressions', 'IMPRESSION', false], ['reach', 'MEMBERS_REACHED', false], ['reactions', 'REACTION', false],
      ['comments', 'COMMENT', false], ['shares', 'RESHARE', false], ['saves', 'POST_SAVE', true], ['clicks', 'LINK_CLICKS', true],
    ] as const;
    for (const [field, queryType, optional] of queryTypes) {
      const tag = urn.includes(':share:') ? 'share' : 'ugc';
      const url = `https://api.linkedin.com/rest/memberCreatorPostAnalytics?q=entity&entity=(${tag}:${encodeURIComponent(urn)})&queryType=${queryType}&aggregation=TOTAL`;
      try {
        const response = await this.get(url, { headers }); raw[field] = response;
        const elements = response.elements;
        if (Array.isArray(elements) && elements.length === 1) { m[field] = count(elements[0]?.count); definitions[field] = `memberCreatorPostAnalytics ${queryType}, TOTAL`; }
      } catch (error) {
        if (!optional) throw error;
        definitions[field] = `memberCreatorPostAnalytics ${queryType} was not available for this member/app; value remains unknown.`;
      }
    }
    return collection('linkedin-member', raw, m, definitions, 'unknown');
  }
}
