import { describe, expect, it } from 'vitest';
import { CollectionError } from '../src/contracts.js';
import { extractPublicHtml, parseVisibleCount, PublicUrlAdapters, UniversalAdapters } from '../src/public-platforms.js';
import { post } from './helpers.js';

describe('public URL collection', () => {
  it('parses compact visible counts', () => {
    expect(parseVisibleCount('1.2K')).toBe(1200);
    expect(parseVisibleCount('2,345')).toBe(2345);
    expect(parseVisibleCount('unknown')).toBeNull();
  });

  it('uses the no-key FxTwitter single-post contract for X', async () => {
    const adapter = new PublicUrlAdapters(async () => { throw new Error('HTML fallback should not run'); }, async url => {
      expect(url).toBe('https://api.fxtwitter.com/ken/status/123');
      return { code: 200, tweet: { id: '123', text: 'Public post', created_at: '2026-09-01T00:00:00Z', likes: 12, replies: 3, retweets: 4, views: 500, bookmarks: 2 } };
    });
    const result = await adapter.collect(post({ accountId: null }));
    expect(result.source).toBe('x-public-fxtwitter');
    expect(result.metrics).toMatchObject({ likes: 12, comments: 3, shares: 4, views: 500, saves: 2, impressions: null });
    expect(result.publishedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('extracts LinkedIn JSON-LD and keeps hidden metrics unknown', () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({ '@type': 'SocialMediaPosting', articleBody: 'A public LinkedIn post', datePublished: '2026-09-01T00:00:00Z', interactionStatistic: [{ '@type': 'InteractionCounter', interactionType: { '@type': 'LikeAction' }, userInteractionCount: 21 }, { '@type': 'InteractionCounter', interactionType: { '@type': 'CommentAction' }, userInteractionCount: 5 }] })}</script></head><body></body></html>`;
    const result = extractPublicHtml('linkedin', { url: 'https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/', status: 200, html });
    expect(result.metrics.likes).toBe(21);
    expect(result.metrics.comments).toBe(5);
    expect(result.metrics.impressions).toBeNull();
    expect(result.metrics.shares).toBeNull();
    expect(result.text).toBe('A public LinkedIn post');
  });

  it('reports a LinkedIn public sign-in wall without inventing zero counters', () => {
    const result = extractPublicHtml('linkedin', { url: 'https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/', status: 200, html: '<html><body><article>Post text</article><button aria-label="To view or add a comment, sign in">Comment</button></body></html>' });
    expect(result.metrics.comments).toBeNull();
    expect(result.definitions.visibility).toContain('sign-in prompt');
    expect((result.raw as any).publicLoginPrompt).toBe(true);
  });

  it('extracts Facebook visible labels without converting absent counts to zero', () => {
    const result = extractPublicHtml('facebook', { url: 'https://www.facebook.com/ken/posts/abc', status: 200, html: '<html><body><article><div data-ad-preview="message">Public Facebook post</div><span aria-label="1.5K reactions"></span><span aria-label="27 comments"></span></article></body></html>' });
    expect(result.metrics.reactions).toBe(1500);
    expect(result.metrics.comments).toBe(27);
    expect(result.metrics.shares).toBeNull();
    expect(result.metrics.reach).toBeNull();
  });

  it('supports Tumblr aggregate notes from public JSON-LD', async () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': 'SocialMediaPosting', text: 'Tumblr post', datePublished: '2026-09-02T12:00:00Z', interactionStatistic: { '@type': 'InteractionCounter', interactionType: { '@type': 'NoteAction' }, userInteractionCount: 17 } })}</script>`;
    const adapter = new PublicUrlAdapters(async url => ({ url, status: 200, html }), async () => ({}));
    const result = await adapter.collect(post({ platform: 'tumblr', accountId: null, postId: '123', url: 'https://ken.tumblr.com/post/123' }));
    expect(result.metrics.notes).toBe(17);
    expect(result.metrics.likes).toBeNull();
  });

  it('can retry a public page with a fresh no-session browser renderer', async () => {
    const direct = '<meta property="og:description" content="Post preview">';
    const rendered = '<article><span aria-label="45 reactions"></span><time datetime="2026-09-02T12:00:00Z"></time></article>';
    let renders = 0;
    const adapter = new PublicUrlAdapters(async url => ({ url, status: 200, html: direct }), async () => ({}), async url => { renders++; return { url, status: 200, html: rendered }; });
    const result = await adapter.collect(post({ platform: 'facebook', accountId: null, postId: 'abc', url: 'https://www.facebook.com/ken/posts/abc' }));
    expect(renders).toBe(1);
    expect(result.metrics.reactions).toBe(45);
    expect(result.publishedAt).toBe('2026-09-02T12:00:00.000Z');
  });

  it('follows a validated lnkd.in post short link through the public page loader', async () => {
    const adapter = new PublicUrlAdapters(async url => {
      expect(url).toBe('https://lnkd.in/p/gWhXGsVQ');
      return { url: 'https://www.linkedin.com/posts/person_topic-ugcPost-7516768682174345216-x/', status: 200, html: '<script type="application/ld+json">{"@type":"SocialMediaPosting","datePublished":"2026-10-16T07:55:09Z","interactionStatistic":{"@type":"InteractionCounter","interactionType":{"@type":"LikeAction"},"userInteractionCount":8}}</script>' };
    }, async () => ({}));
    const result = await adapter.collect(post({ platform: 'linkedin', accountId: null, postId: 'short:gWhXGsVQ', url: 'https://lnkd.in/p/gWhXGsVQ' }));
    expect(result.metrics.likes).toBe(8);
    expect(result.publishedAt).toBe('2026-10-16T07:55:09.000Z');
  });

  it('does not silently require native credentials when a public page is unavailable', async () => {
    let nativeCalls = 0;
    const publicAdapter = { async collect() { throw new CollectionError('unavailable', 'public_page_blocked'); } };
    const nativeAdapter = { async collect() { nativeCalls++; throw new Error('credential needed'); } };
    await expect(new UniversalAdapters(publicAdapter, nativeAdapter, false).collect(post({ accountId: null }))).rejects.toThrow('public_page_blocked');
    expect(nativeCalls).toBe(0);
  });

  it('merges official owner analytics into public interaction counts when enabled', async () => {
    const publicAdapter = { async collect() { return { metrics: { ...((await import('../src/contracts.js')).emptyMetrics()), likes: 2 }, definitions: { likes: 'public' }, scope: 'unknown' as const, source: 'linkedin-public-page', raw: { public: true } }; } };
    const nativeAdapter = { async collect() { return { metrics: { ...((await import('../src/contracts.js')).emptyMetrics()), impressions: 100, reach: 80, reactions: 3, clicks: 4 }, definitions: { impressions: 'official' }, scope: 'unknown' as const, source: 'linkedin-member', raw: { native: true } }; } };
    const result = await new UniversalAdapters(publicAdapter, nativeAdapter, true).collect(post(), { id: 'account', platform: 'x', kind: 'user', handles: [], matchUnknown: false, facebookInsights: {} });
    expect(result.metrics).toMatchObject({ likes: 2, impressions: 100, reach: 80, reactions: 3, clicks: 4 });
    expect(result.source).toContain('linkedin-public-page+linkedin-member');
  });

  it('keeps public metrics and explains an unavailable optional native fallback', async () => {
    const publicAdapter = { async collect() { return { metrics: { ...((await import('../src/contracts.js')).emptyMetrics()), likes: 2 }, definitions: {}, scope: 'unknown' as const, source: 'linkedin-public-page', raw: {} }; } };
    const nativeAdapter = { async collect() { throw new CollectionError('blocked', 'Missing configured analytics credential (PE_LINKEDIN_ACCESS_TOKEN).'); } };
    const result = await new UniversalAdapters(publicAdapter, nativeAdapter, true).collect(post(), { id: 'account', platform: 'x', kind: 'user', handles: [], matchUnknown: false, facebookInsights: {} });
    expect(result.metrics.likes).toBe(2);
    expect(result.source).toContain('native-unavailable');
    expect(result.definitions.nativeFallback).toContain('PE_LINKEDIN_ACCESS_TOKEN');
  });
});
