import { describe, expect, it } from 'vitest';
import { Account, CollectionError, emptyMetrics } from '../src/contracts.js';
import { NativeAdapters } from '../src/platforms.js';
import { post, account } from './helpers.js';

describe('platform adapters (official request/response contracts)', () => {
  it('reads X post metrics and keeps unavailable fields unknown', async () => {
    const adapter = new NativeAdapters({ TOKEN: 'private' }, async (url, init) => { expect(url).toContain('/2/tweets/123'); expect(url).not.toContain('private'); expect((init?.headers as any).Authorization).toBe('Bearer private'); return { data: { id: '123', created_at: '2026-09-01T00:00:00Z', public_metrics: { like_count: 0, reply_count: 2, retweet_count: 1 } } }; });
    const r = await adapter.collect(post(), account()); expect(r.metrics.likes).toBe(0); expect(r.metrics.impressions).toBeNull(); expect(r.metrics.comments).toBe(2);
  });
  it('does not leak a missing token value or contact the API', async () => { let calls = 0; const a = new NativeAdapters({}, async () => { calls++; }); await expect(a.collect(post(), account())).rejects.toThrow('Missing configured'); expect(calls).toBe(0); });
  it('validates author identity when configured', async () => { const a = new NativeAdapters({ TOKEN: 'private' }, async () => ({ data: { id: '123', author_id: 'wrong' } })); await expect(a.collect(post(), { ...account(), nativeId: 'right' })).rejects.toThrow('different author'); });
  it('rejects mismatched account', async () => { const a = new NativeAdapters({ TOKEN: 'private' }, async () => ({})); await expect(a.collect(post(), { ...account(), id: 'other' })).rejects.toThrow('identity'); });
  it('reads Tumblr aggregate notes without inventing likes/shares', async () => {
    const a = Account.parse({ id: 'account', platform: 'tumblr', kind: 'blog', handles: ['ken'], tokenEnv: 'TOKEN' });
    const adapter = new NativeAdapters({ TOKEN: 'private' }, async () => ({ response: { posts: [{ id_string: '123', timestamp: 1788220800, note_count: 17 }] } }));
    const r = await adapter.collect(post({ platform: 'tumblr' }), a); expect(r.metrics.notes).toBe(17); expect(r.metrics.likes).toBeNull(); expect(r.metrics.shares).toBeNull(); expect(r.metrics.impressions).toBeNull();
  });
  it('requires a current explicitly configured Facebook API version', async () => { const a = Account.parse({ id: 'account', platform: 'facebook', kind: 'page', handles: [], tokenEnv: 'TOKEN' }); const adapter = new NativeAdapters({ TOKEN: 'private' }, async () => ({})); await expect(adapter.collect(post({ platform: 'facebook' }), a)).rejects.toThrow('API version'); });
  it('reads Facebook basic interactions and does not fabricate omitted share counts', async () => {
    const a = Account.parse({ id: 'account', platform: 'facebook', kind: 'page', apiVersion: 'v24.0', nativeId: '456', tokenEnv: 'TOKEN' });
    const adapter = new NativeAdapters({ TOKEN: 'private' }, async () => ({ from: { id: '456' }, reactions: { summary: { total_count: 0 } }, comments: { summary: { total_count: 1 } } }));
    const r = await adapter.collect(post({ platform: 'facebook' }), a); expect(r.metrics.reactions).toBe(0); expect(r.metrics.likes).toBeNull(); expect(r.metrics.shares).toBeNull();
  });
  it('refuses opaque Facebook pfbid as a numeric Graph ID', async () => { const a = Account.parse({ id: 'account', platform: 'facebook', kind: 'page', apiVersion: 'v24.0', tokenEnv: 'TOKEN' }); await expect(new NativeAdapters({ TOKEN: 'private' }, async () => ({})).collect(post({ platform: 'facebook', postId: 'pfbidABC' }), a)).rejects.toThrow('numeric platform post ID'); });
  it('does not assume LinkedIn activity IDs are native share IDs', async () => { const a = Account.parse({ id: 'account', platform: 'linkedin', kind: 'member', apiVersion: '202609', tokenEnv: 'TOKEN' }); await expect(new NativeAdapters({ TOKEN: 'private' }, async () => ({})).collect(post({ platform: 'linkedin' }), a)).rejects.toThrow('exact share/ugcPost URN'); });
  it('uses member analytics query types with TOTAL aggregation', async () => {
    const a = Account.parse({ id: 'account', platform: 'linkedin', kind: 'member', apiVersion: '202609', tokenEnv: 'TOKEN' });
    let calls = 0; const adapter = new NativeAdapters({ TOKEN: 'private' }, async url => { expect(url).toContain('aggregation=TOTAL'); expect(url).toContain('entity=(share:urn%3Ali%3Ashare%3A123)'); calls++; return { elements: [{ count: 10 }] }; });
    const r = await adapter.collect(post({ platform: 'linkedin', nativeUrn: 'urn:li:share:123' }), a); expect(calls).toBe(7); expect(r.metrics.reactions).toBe(10); expect(r.metrics.saves).toBe(10); expect(r.metrics.clicks).toBe(10); expect(r.metrics.likes).toBeNull();
  });
  it('reads organization organic metrics separately', async () => {
    const a = Account.parse({ id: 'account', platform: 'linkedin', kind: 'organization', nativeId: '456', apiVersion: '202609', tokenEnv: 'TOKEN' });
    const adapter = new NativeAdapters({ TOKEN: 'private' }, async () => ({ elements: [{ share: 'urn:li:share:123', totalShareStatistics: { impressionCount: 1000, likeCount: 1, commentCount: 2, shareCount: 3 } }] }));
    const r = await adapter.collect(post({ platform: 'linkedin', nativeUrn: 'urn:li:share:123' }), a); expect(r.scope).toBe('organic'); expect(r.metrics.impressions).toBe(1000);
  });
});
