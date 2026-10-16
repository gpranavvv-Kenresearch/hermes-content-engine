import { describe, expect, it } from 'vitest';
import { extractNotes } from '../../src/evidence/index.js';

const URL_ = 'https://www.kenresearch.com/south-africa-online-classifieds-and-job-portals-market';

// Lines copied from the real report page (retrieved 2026-10-13), in page order, plus junk of the kinds
// that page contains: headings, table rows, sentences full of figures, "$" table residue.
const GOOD = {
  hiring:
    'This large candidate pool generates sustained traffic for recruitment portals, although employer-side monetization remains linked to formal hiring volumes rather than the total number of job seekers.',
  access: 'Digital access is expanding the addressable audience and improving listing discovery outside major metropolitan areas.',
  growth:
    'Growth will be supported by higher employer adoption of digital recruitment, expanding dealer and agency subscriptions, increased use of promoted listings, greater mobile engagement and the conversion of free users into paid business accounts.',
  remedies:
    'Competitive remedies should improve access for smaller agencies and dealers, although leading portals will retain advantages in traffic, inventory and proprietary matching data.',
  concentration: 'The market is concentrated in automotive and property classifieds but more fragmented in recruitment.',
  advantage:
    'Competitive advantage depends on listing density, consumer traffic, employer or dealer relationships, brand trust, matching quality, workflow integrations and the ability to demonstrate measurable lead conversion.',
};
const JUNK = [
  'CHAPTER 1 - MARKET SUMMARY',
  'Market Overview',
  'South Africa recorded 7.8 million unemployed people in Q4 2025, while the official unemployment rate stood at 31.4%.',
  'The South Africa Online Classifieds and Job Portals Market is projected to expand from USD 146.5 Mn in 2025 to USD 222.3 Mn by 2031, representing a forecast CAGR of 7.20%.',
  'Established vertical leaders possess deep inventory, recognized brands and recurring business-account relationships. $Revenue remains concentrated in formal urban employers, dealers and property agencies.',
  'Metric South Africa Nigeria Egypt Kenya Morocco',
  'Market Size USD 146.5 Mn USD 132.0 Mn USD 105.0 Mn USD 46.0 Mn USD 39.0 Mn',
  'AutoTrader held an estimated 40-50% automotive share, while a rival held 30-40%, creating substantial inventory and consumer-recognition barriers.',
  'Download the free sample report to see the full list of companies and request a quote for custom research.',
  'According to IMARC Group, the South African classifieds market is consolidating around a few large vertical portals.',
  'For the full methodology and every source used in this report, see https://example.com/methodology and the appendix pages.',
];

const text = [JUNK[0], JUNK[1], JUNK[2], GOOD.hiring, GOOD.access, JUNK[3], GOOD.growth, JUNK[4], GOOD.remedies, JUNK[5], JUNK[6], JUNK[7], GOOD.concentration, JUNK[8], JUNK[9], JUNK[10], GOOD.advantage].join('\n');

describe('extractNotes (real page sentences)', () => {
  const notes = extractNotes({ text, url: URL_ });

  it('keeps the qualitative prose and nothing else, in page order', () => {
    expect(notes.map((n) => n.text)).toEqual([GOOD.hiring, GOOD.access, GOOD.growth, GOOD.remedies, GOOD.concentration, GOOD.advantage]);
  });

  it('numbers them N1..Nk and records the source', () => {
    expect(notes.map((n) => n.id)).toEqual(['N1', 'N2', 'N3', 'N4', 'N5', 'N6']);
    expect(notes.every((n) => n.sourceUrl === URL_)).toBe(true);
  });

  it('never keeps a figure, table residue, a link, boilerplate or a competitor research firm', () => {
    const all = notes.map((n) => n.text).join(' ');
    expect(all).not.toMatch(/\d{2}|%|\$|Mn|https?:|IMARC|sample report/);
  });

  it('respects max, keeping the best-scoring sentences', () => {
    const two = extractNotes({ text, url: URL_, max: 2 });
    expect(two).toHaveLength(2);
    expect(two.map((n) => n.id)).toEqual(['N1', 'N2']);
  });

  it('drops near-duplicates', () => {
    const dup = extractNotes({ text: `${GOOD.growth}\n${GOOD.growth.replace('increased use', 'greater use')}`, url: URL_ });
    expect(dup).toHaveLength(1);
  });

  it('returns nothing for a page with no prose', () => {
    expect(extractNotes({ text: 'CHAPTER 1\nMarket Overview\n7.20%\nUSD 222.3 Mn', url: URL_ })).toEqual([]);
  });

  it('drops section blurbs that describe the report instead of stating a finding', () => {
    const blurbs = [
      'This section evaluates the historical market size, analyzes year-over-year growth dynamics, and presents forecast projections supported by demand-side drivers.',
      'Comprehensive analysis of key factors shaping the South Africa Online Classifieds and Job Portals Market, including growth catalysts, operational challenges, and emerging opportunities.',
    ].join('\n');
    expect(extractNotes({ text: blurbs, url: URL_ })).toEqual([]);
  });

  it('allows years inside a note', () => {
    const withYear = extractNotes({
      text: 'Digital recruitment adoption has been rising steadily since 2022 as employers shift more of their hiring budgets online.',
      url: URL_,
    });
    expect(withYear).toHaveLength(1);
  });
});
