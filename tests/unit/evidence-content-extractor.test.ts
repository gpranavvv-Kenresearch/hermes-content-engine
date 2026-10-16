import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractContent } from '../../src/evidence/content-extractor.js';

const fx = (n: string) => readFileSync(new URL(`../fixtures/evidence/${n}`, import.meta.url), 'utf8');
const URL_LANDING = 'https://www.kenresearch.com/report/examplestan-widget-market';

describe('extractContent', () => {
  it('extracts a report landing page with numbers, title, canonical and date', async () => {
    const r = await extractContent(fx('report-landing.html'), URL_LANDING);
    expect(r.title).toBe('Examplestan Widget Market Outlook to 2030');
    expect(r.canonicalUrl).toBe('https://www.kenresearch.com/report/examplestan-widget-market');
    expect(r.publishedAt).toBe('2026-03-02T02:30:00.000Z');
    expect(r.text).toContain('USD 4.2 billion in 2025');
    expect(r.text).toContain('CAGR of 10.1%');
    expect(r.text).toContain('62.5%');
  });

  it('does not leak scripts, styles or navigation phone numbers', async () => {
    const r = await extractContent(fx('report-landing.html'), URL_LANDING);
    expect(r.text).not.toContain('99999999');
    expect(r.text).not.toContain('dataLayer');
    expect(r.text).not.toContain('color: red');
  });

  it('keeps table numbers in tables[] and in text', async () => {
    const r = await extractContent(fx('report-landing.html'), URL_LANDING);
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]).toMatchObject({ caption: 'Segment revenue 2025', headers: ['Segment', 'Revenue (USD million)', 'Share'] });
    expect(r.tables[0]!.rows[0]).toEqual(['Industrial widgets', '2,310', '55%']);
    expect(r.text).toContain('2,310');
    expect(r.text).toContain('1,890');
  });

  it('handles an article-shaped page and JSON-LD date', async () => {
    const r = await extractContent(fx('article.html'), 'https://www.kenresearch.com/blog/gadgets');
    expect(r.title).toBe('Why the Examplestan Gadget Sector Is Growing');
    expect(r.text).toContain('USD 1.5 billion in 2024');
    expect(r.text).toContain('CAGR of 7.5%');
    expect(r.publishedAt).toBe('2026-01-15T10:00:00.000Z');
    expect(r.canonicalUrl).toBeUndefined();
  });

  it('falls back to body text for sparse non-article pages and keeps table figures', async () => {
    const r = await extractContent(fx('sparse.html'), 'https://www.kenresearch.com/x');
    expect(r.method).toBe('fallback');
    expect(r.text).toContain('12.5 percent');
    expect(r.text).toContain('1,200');
    expect(r.tables[0]!.rows).toContainEqual(['North', '1,200']);
  });

  it('is deterministic', async () => {
    const a = await extractContent(fx('report-landing.html'), URL_LANDING);
    const b = await extractContent(fx('report-landing.html'), URL_LANDING);
    expect(a).toEqual(b);
  });

  it('survives empty and garbage html', async () => {
    const r = await extractContent('', 'https://www.kenresearch.com/x');
    expect(r.text).toBe('');
    const g = await extractContent('<<<not html>>> 42', 'https://www.kenresearch.com/x');
    expect(typeof g.text).toBe('string');
  });

  it('returns an absolute canonical even if declared absolute on another host (validation is the caller job)', async () => {
    const html = '<html><head><link rel="canonical" href="https://evil.com/copy"></head><body>x</body></html>';
    const r = await extractContent(html, 'https://www.kenresearch.com/x');
    expect(r.canonicalUrl).toBe('https://evil.com/copy');
  });
});
