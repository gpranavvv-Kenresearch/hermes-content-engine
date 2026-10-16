import { Accounts, Post, hash, stableId, type Account, type Platform } from './contracts.js';
import { parsePostUrl } from './urls.js';
import { readFile } from 'node:fs/promises';

const headers = {
  x: { url: 'X Post URL', text: 'X Post', date: 'lastPostedX' },
  facebook: { url: 'FB Post URL', text: 'FB Post', date: 'lastPostedFb' },
  linkedin: { url: 'LinkedIn Post URL', text: 'LinkedIn Post', date: 'lastPostedLi' },
  tumblr: { url: 'Tumblr Post URL', text: 'Tumblr Post', date: 'lastPostedTumblr' },
} as const;
export async function loadAccounts(file = 'performance-engine/config/accounts.json'): Promise<Account[]> {
  try { const a = Accounts.parse(JSON.parse(await readFile(file, 'utf8'))).accounts; if (new Set(a.map(x => x.id)).size !== a.length) throw new Error('Duplicate analytics account IDs'); return a; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}
export function exactDate(input: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input)) return null;
  const ms = Date.parse(input); return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
export function discover(rows: readonly (readonly string[])[], accounts: Account[], now = new Date(), platform?: Platform): { posts: Post[]; skipped: Array<{ row: number; platform: Platform; reason: string }> } {
  const names = rows[0]?.map(s => s.trim().toLowerCase()) ?? [];
  const index = (name: string) => names.indexOf(name.toLowerCase());
  const at = (row: readonly string[], name: string) => row[index(name)]?.trim() ?? '';
  const posts: Post[] = []; const skipped: Array<{ row: number; platform: Platform; reason: string }> = [];
  for (let r = 1; r < rows.length; r++) for (const p of Object.keys(headers) as Platform[]) {
    if (platform && platform !== p) continue;
    const row = rows[r]!; const spec = headers[p]; const url = at(row, spec.url);
    if (!url) continue;
    try {
      const identity = parsePostUrl(url, p);
      const directAccount = at(row, `${p} Account ID`);
      const candidates = accounts.filter(a => a.platform === p && (directAccount ? a.id === directAccount : identity.accountHint ? a.handles.some(h => h.toLowerCase().replace(/^@/, '') === identity.accountHint!.toLowerCase()) || a.nativeId === identity.accountHint : a.matchUnknown));
      const account = candidates.length === 1 ? candidates[0] : undefined;
      const explicitDate = exactDate(at(row, `${p} Published At`)) ?? exactDate(at(row, spec.date));
      const publishedAt = explicitDate ?? identity.publishedAt;
      const text = at(row, spec.text);
      const native = /urn:li:(ugcPost|share):\d+/.exec(decodeURIComponent(url))?.[0];
      const post = Post.parse({ id: stableId(p, identity.postId, identity.accountHint ?? ''), platform: p, accountId: account?.id ?? null, postId: identity.postId, url: identity.canonicalUrl, reportUrl: at(row, 'targetUrl') || at(row, 'Report URL') || at(row, 'URL'), text, textHash: hash(text), publishedAt, publishedAtSource: explicitDate ? 'publisher-iso-timestamp' : identity.publishedAt ? 'x-snowflake' : 'unknown', discoveredAt: now.toISOString(), sourceRow: r + 1, strategy: {}, ...(native ? { nativeUrn: native } : {}) });
      const prior = posts.find(x => x.id === post.id);
      if (prior) { skipped.push({ row: r + 1, platform: p, reason: 'Duplicate published post URL/ID' }); continue; }
      posts.push(post);
    } catch (e) { skipped.push({ row: r + 1, platform: p, reason: e instanceof Error ? e.message : 'Invalid published URL' }); }
  }
  return { posts, skipped };
}
