import { CollectionError, type Platform } from './contracts.js';

export interface PostIdentity { platform: Platform; postId: string; accountHint: string | null; canonicalUrl: string; publishedAt: string | null; }
function snowflakeDate(value: string, shift: bigint, epoch: bigint): string | null {
  try { const millis = Number((BigInt(value) >> shift) + epoch); const date = new Date(millis); return millis >= Date.UTC(2006, 0, 1) && millis <= Date.now() + 86400000 ? date.toISOString() : null; } catch { return null; }
}
export function parsePostUrl(raw: string, expected?: Platform): PostIdentity {
  const url = new URL(raw.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('A public HTTPS post URL is required');
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let value: PostIdentity | undefined;
  if (['x.com', 'twitter.com', 'mobile.twitter.com'].includes(host)) {
    const m = /^\/(?:([^/]+)\/status|i\/web\/status)\/(\d+)(?:\/.*)?$/.exec(url.pathname);
    if (m) value = { platform: 'x', postId: m[2]!, accountHint: m[1]?.toLowerCase() ?? null, canonicalUrl: `https://x.com/${m[1] ?? 'i/web'}/status/${m[2]}`, publishedAt: snowflakeDate(m[2]!, 22n, 1288834974657n) };
  } else if (host === 'linkedin.com') {
    const match = /(activity|ugcPost|share)[-:](\d{15,22})/i.exec(decodeURIComponent(raw));
    if (match) {
      const kind = match[1]!.toLowerCase() === 'ugcpost' ? 'ugcPost' : match[1]!.toLowerCase();
      value = { platform: 'linkedin', postId: match[2]!, accountHint: null, canonicalUrl: `https://www.linkedin.com/feed/update/urn:li:${kind}:${match[2]}/`, publishedAt: null };
    }
  } else if (host === 'lnkd.in') {
    const short = /^\/p\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
    if (short) value = { platform: 'linkedin', postId: `short:${short[1]}`, accountHint: null, canonicalUrl: `https://lnkd.in/p/${short[1]}`, publishedAt: null };
  } else if (host === 'facebook.com' || host === 'm.facebook.com' || host === 'web.facebook.com') {
    const m = /^\/([^/]+)\/posts\/([^/]+)/.exec(url.pathname);
    const id = m?.[2] ?? url.searchParams.get('story_fbid') ?? (url.pathname === '/photo.php' ? url.searchParams.get('fbid') : null);
    const account = m?.[1] ?? url.searchParams.get('id');
    if (id && /^[A-Za-z0-9_]+$/.test(id)) value = { platform: 'facebook', postId: id, accountHint: account, canonicalUrl: m ? `https://www.facebook.com/${account}/posts/${id}` : `https://www.facebook.com/permalink.php?story_fbid=${id}${account ? `&id=${account}` : ''}`, publishedAt: null };
    const shared = /^\/share\/p\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
    if (!value && shared) value = { platform: 'facebook', postId: `share:${shared[1]}`, accountHint: null, canonicalUrl: `https://www.facebook.com/share/p/${shared[1]}/`, publishedAt: null };
  } else if (host.endsWith('.tumblr.com') || host === 'tumblr.com') {
    const m = host === 'tumblr.com' ? /^\/([^/]+)\/(\d+)/.exec(url.pathname) : /^\/post\/(\d+)/.exec(url.pathname);
    const blog = host === 'tumblr.com' ? m?.[1] : host.slice(0, -11);
    const id = host === 'tumblr.com' ? m?.[2] : m?.[1];
    if (blog && id && /^[\w-]+$/.test(blog)) value = { platform: 'tumblr', postId: id, accountHint: blog.toLowerCase(), canonicalUrl: `https://${blog.toLowerCase()}.tumblr.com/post/${id}`, publishedAt: null };
  }
  if (!value || (expected && value.platform !== expected)) throw new Error(`Unsupported or mismatched post URL${expected ? ` for ${expected}` : ''}`);
  return value;
}
export function requireNativePostId(value: string): string {
  if (!/^(?:\d+_)?\d+$/.test(value)) throw new CollectionError('blocked', 'This URL needs its numeric platform post ID from the publisher or an analytics import.');
  return value;
}
