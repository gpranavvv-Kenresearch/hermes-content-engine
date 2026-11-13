import { describe, expect, it } from 'vitest';
import type { BlogGenResult } from '../../src/agents/blogGenAgent.js';
import { assembleFreeHtml, freeHardFails, freeSanity, normaliseFreeBlog, onlyHtml } from '../src/free.js';

const blog = (html: string, seoTitle = 'South Africa Lubricant Market 2031', description = 'A plain description'): BlogGenResult => ({
  title: 'T', description, html, seoTitle, imageData: '', imageData2: '',
});

const RAW = `Here is your article:
\`\`\`html
<img src="YOUR_HEADER_IMAGE_URL_HERE" alt="South Africa lubricants">
<h1>South Africa Lubricant Market: Value Outpaces Volume, says Ken Research</h1>
<p>According to <a href="https://www.kenresearch.com/"><strong>Ken Research</strong></a>, the market was USD 438 million in 2025 and reaches USD 559 million by 2031, a 4.15% CAGR.</p>
<h2>Why value grows faster than volume — and what it means</h2>
<p>Ken Research estimates demand at 300 million litres in 2025 — rising to 340 million litres by 2031. ${'Words '.repeat(80)}</p>
<p>Read the <a href="https://www.kenresearch.com/south-africa-lubricant-market">full report</a>.</p>
\`\`\`
Let me know if you want changes.`;

describe('free-v2 normalisation', () => {
  it('keeps only the HTML', () => {
    const h = onlyHtml(RAW);
    expect(h.startsWith('<img')).toBe(true);
    expect(h.endsWith('</p>')).toBe(true);
    expect(h).not.toContain('```');
    expect(h).not.toContain('Let me know');
  });

  it('removes em dashes, bolds Ken Research and statistics, and leaves URLs alone', () => {
    const out = normaliseFreeBlog(blog(RAW, 'South Africa Lubricant Market — Value Outpaces Volume', 'Value — not volume — drives growth'));
    expect(out.html).not.toMatch(/—/);
    expect(out.seoTitle).toBe('South Africa Lubricant Market, Value Outpaces Volume');
    expect(out.description).toBe('Value, not volume, drives growth');
    expect(out.html).toContain('<strong>USD 438 million</strong>');
    expect(out.html).toContain('<strong>2025</strong>');
    expect(out.html).toContain('<strong>4.15%</strong>');
    expect(out.html).toContain('<strong>Ken Research</strong> estimates');
    expect(out.html).toContain('href="https://www.kenresearch.com/south-africa-lubricant-market"');
    expect(freeHardFails(out)).toEqual([]);
  });

  it('flags a missing H1 and unbolded brand that survive normalisation', () => {
    const s = freeSanity('<p>No heading here.</p>');
    expect(s.h1).toBe(0);
    expect(freeHardFails(blog('<p>No heading here.</p>'))[0]).toMatch(/0 H1/);
  });

  it('replaces the writer placeholder with the cover image above the H1, and adds nothing else', () => {
    const out = normaliseFreeBlog(blog(RAW));
    const html = assembleFreeHtml(out, 'Market', 'https://cdn.example/cover.png');
    expect(html.indexOf('cover.png')).toBeLessThan(html.indexOf('<h1'));
    expect(html).not.toContain('YOUR_HEADER_IMAGE_URL_HERE');
    expect((html.match(/<img\b/g) ?? []).length).toBe(1);
    const noCover = assembleFreeHtml(out, 'Market', '');
    expect(noCover).not.toContain('<img');
    expect(noCover.startsWith('<h1')).toBe(true);
  });
});

describe('free-v2 publishing title', () => {
  it('uses the Publishing Title as the platform title and cleans it (no markup, no em dash)', () => {
    const out = normaliseFreeBlog({ ...blog('<h1>H1 with <strong>Ken Research</strong></h1><p>' + 'word '.repeat(80) + '</p>'), title: 'old h1 text', publishingTitle: '**South Africa Lubricants** — value outgrows volume' });
    expect(out.title).toBe('South Africa Lubricants, value outgrows volume');
    expect(out.publishingTitle).toBe('South Africa Lubricants, value outgrows volume');
  });

  it('keeps the H1 text as the title when no Publishing Title is returned', () => {
    const out = normaliseFreeBlog({ ...blog('<h1>H1</h1><p>' + 'word '.repeat(80) + '</p>'), title: 'The H1 text' });
    expect(out.title).toBe('The H1 text');
    expect(out.publishingTitle).toBeUndefined();
  });
});

describe('free-v2 link quoting and H1 suffix', () => {
  const body = '<p>' + 'word '.repeat(80) + '</p>';
  it('repairs doubled, escaped, entity and curly href quotes', () => {
    const raw = `<h1>Market</h1><p><a href=""https://www.kenresearch.com/a?utm_source=x&utm_medium=y"">A</a> <a href=\\"https://gov.example/b\\">B</a> <a href=&quot;https://gov.example/c&quot;>C</a> <a href=\u201Chttps://gov.example/d\u201D>D</a> <a href=\\"https://www.kenresearch.com/f\?utm_source=a\&utm_medium=b\\">F</a> and <a href="https://ok.example/e">E</a></p>${body}`;
    const out = normaliseFreeBlog(blog(raw)).html;
    expect(out).toContain('href="https://www.kenresearch.com/a?utm_source=x&utm_medium=y"');
    expect(out).toContain('href="https://gov.example/b"');
    expect(out).toContain('href="https://gov.example/c"');
    expect(out).toContain('href="https://gov.example/d"');
    expect(out).toContain('href="https://www.kenresearch.com/f?utm_source=a&utm_medium=b"');
    expect(out).not.toMatch(/href=""/);
    expect(freeSanity(out).badHrefs).toBe(0);
    expect(freeSanity(raw).badHrefs).toBeGreaterThan(0);
  });

  it('removes a "| Ken Research" suffix from the H1 but keeps a brand placed inside the sentence', () => {
    const a = normaliseFreeBlog(blog(`<h1>Malaysia 3PL Market Shifts \| <strong>Ken Research</strong></h1>${body}`)).html;
    expect(a).toContain('<h1>Malaysia 3PL Market Shifts</h1>');
    const b = normaliseFreeBlog(blog(`<h1>Malaysia 3PL Market Shifts | Ken Research</h1>${body}`)).html;
    expect(b).toContain('<h1>Malaysia 3PL Market Shifts</h1>');
    const c = normaliseFreeBlog(blog(`<h1>Malaysia 3PL Networks: Ken Research Examines the Compliance Opportunity</h1>${body}`)).html;
    expect(c).toContain('<h1>Malaysia 3PL Networks: <strong>Ken Research</strong> Examines the Compliance Opportunity</h1>');
    expect(freeSanity(c).h1PipeBrand).toBe(0);
  });
});

describe('free-v2 preferred source CTA', () => {
  it('adds the Google preferred-source link for Ken Research exactly once', () => {
    const para = (t: string) => `<p>${t} ${'word '.repeat(60)}</p>`;
    const html = '<h1>Malaysia 3PL Networks: Ken Research Examines Growth</h1>' + para('Intro') + para('Intro two') +
      '<h2>Why compliance drives demand</h2>' + para('A') + para('B') +
      '<h2>Where the competition sits</h2>' + para('C') + para('D') +
      '<h2>What buyers should decide</h2>' + para('E') + para('F') +
      '<h2>Market outlook and next steps</h2>' + para('G') + '<p>Review the <a href="https://www.kenresearch.com/malaysia-3pl">full report</a>.</p>';
    const out = assembleFreeHtml(normaliseFreeBlog(blog(html)), 'Malaysia 3PL Market', '');
    expect(out.split('https://www.google.com/preferences/source?q=kenresearch.com').length - 1).toBe(1);
    expect(out).toContain('https://www.kenresearch.com/malaysia-3pl');
    // fallback CTA is wrapped in a blockquote
    const at = out.indexOf('preferences/source');
    expect(out.lastIndexOf('<blockquote>', at)).toBeGreaterThan(out.lastIndexOf('</blockquote>', at));
    expect(out.indexOf('</blockquote>', at)).toBeGreaterThan(at);
  });

  it('keeps a valid blockquote CTA written by the model', () => {
    const para = (t: string) => `<p>${t} ${'word '.repeat(60)}</p>`;
    const cta = '<blockquote><p><strong>Compliance, not scale, decides who wins Malaysian pharma logistics contracts.</strong> To follow more research like this, <a href="https://www.google.com/preferences/source?q=kenresearch.com"><strong>add Ken Research as a Preferred Source on Google</strong></a>.</p></blockquote>';
    const html = '<h1>Malaysia 3PL: Ken Research Examines Growth</h1>' + para('Intro') + para('Intro two') + '<h2>Why compliance drives demand</h2>' + para('A') + para('B') + '<h2>Where the competition sits</h2>' + para('C') + cta + para('D') + '<h2>Market outlook</h2>' + para('G') + '<p>Review the <a href="https://www.kenresearch.com/malaysia-3pl">full report</a>.</p>';
    const notes: string[] = [];
    const out = assembleFreeHtml(normaliseFreeBlog(blog(html)), 'Malaysia 3PL Market', '', (n) => notes.push(String(n)));
    expect(out.split('preferences/source').length - 1).toBe(1);
    expect(notes.join(' ')).toContain('kept as written');
  });
});
