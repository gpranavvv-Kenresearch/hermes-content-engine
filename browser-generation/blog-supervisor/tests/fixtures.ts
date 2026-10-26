import type { BlogGenResult } from '../../src/agents/blogGenAgent.js';

export const REPORT_URL = 'https://www.kenresearch.com/industry-reports/brazil-seed-market';
export const PREFERRED = 'https://www.google.com/preferences/source?q=https%3A%2F%2Fwww.kenresearch.com';

const filler = (n: number, seed: string) =>
  Array.from({ length: n }, (_, i) => `${seed}${i % 7 === 0 ? 'analysis' : i % 5 === 0 ? 'market' : 'growth'}`).join(' ');

/** About 70 words of plain prose, optionally with extra markup spliced in (links, bold). */
const para = (seed: string, inner = '') => `<p>${inner ? inner + ' ' : ''}${filler(66, seed)}.</p>`;

export interface ArticleOptions {
  /** Leave "Ken Research" unbolded once. */
  unboldedKen?: boolean;
  /** Add a table. */
  table?: boolean;
  /** Add an em dash. */
  emDash?: boolean;
  /** Replace the last paragraph's primary report link. */
  noPrimaryLink?: boolean;
  /** Use a non-government external link. */
  badExternal?: boolean;
  /** Leave a mid-article image placeholder. */
  placeholder?: boolean;
  /** Number of H2 sections (default 6). */
  h2?: number;
  /** An extra unbolded figure. */
  unboldedNumber?: boolean;
}

export function makeArticle(o: ArticleOptions = {}): string {
  const ken = o.unboldedKen ? 'Ken Research' : '<strong>Ken Research</strong>';
  const gov1 = o.badExternal ? 'https://www.seedtradeassociation.org/report' : 'https://www.ibge.gov.br/en/statistics';
  const h2s = [
    ['How Big Is Brazil Seed Market and How Fast Is It Growing?', para('a', `Brazil's seed market reached <strong>USD 8.7 billion</strong> in <strong>2025</strong> and is forecast to reach <strong>USD 12.1 billion</strong> by <strong>2031</strong>.`), para('b')],
    ['What Is Driving Seed Demand Across the Soybean Belt?', para('c', `<a href="https://www.kenresearch.com/industry-reports/brazil-agriculture-market"><strong>Ken Research</strong> agriculture analysis</a> points to <strong>4.8%</strong> growth.`), para('d')],
    ['Which Seed Segments Are Growers Shifting Toward?', para('e'), para('f', `Official data from <a href="${gov1}">IBGE</a> shows planted area rising.`) + (o.placeholder ? '<img src="YOUR_IMAGE_URL_HERE_2" alt="x">' : '')],
    ['Seed Concentration: Four Firms Hold Most Hybrid Corn Sales', para('g'), para('h', `See the <a href="https://www.kenresearch.com/industry-reports/brazil-fertilizer-market">fertilizer market</a> for inputs context.`)],
    ['What Regulatory Risks Could Slow Brazil Seed Market Growth?', para('i'), `<blockquote><p><strong>Plan for cultivar registration before you plan for price.</strong> <a href="${PREFERRED}">Add ${ken} as a preferred source</a></p></blockquote>`],
    ['Where Brazil Seed Market Goes Next: A Decision Window to 2031', para('j', `Official guidance from <a href="https://www.gov.br/agricultura/en">MAPA</a> frames the rules.`), `<p>${o.noPrimaryLink ? 'Read more about the market.' : `Explore the full <a href="${REPORT_URL}">Brazil Seed Market report</a> from ${ken}.`} ${filler(40, 'z')}.</p>`],
  ].slice(0, o.h2 ?? 6);

  const intro = [
    para('x', `<a href="https://www.kenresearch.com/">${ken}</a> tracks Brazil's seed sector.`),
    para('y', `A related view appears in the <a href="https://www.kenresearch.com/industry-reports/brazil-crop-protection-market">crop protection market</a>.`),
  ].join('\n');

  const body = h2s.map(([h, p1, p2]) => `<h2>${h}</h2>\n${p1}\n${p2}`).join('\n');
  const extra = [
    o.table ? '<table><tr><td>x</td></tr></table>' : '',
    o.emDash ? '<p>A claim — with a dash.</p>' : '',
    o.unboldedNumber ? '<p>Roughly 42 growers noted it.</p>' : '',
  ].join('');
  return `<h1>Brazil Seed Market Outlook</h1>\n${intro}\n${body}\n${extra}`;
}

export function makeBlog(o: ArticleOptions = {}): BlogGenResult {
  return {
    title: 'Brazil Seed Market Outlook',
    description: 'Brazil seed market outlook with base value, forecast, growth drivers, segments, competition and risks for decision makers planning to 2031 and beyond today.',
    html: makeArticle(o),
    seoTitle: 'Brazil Seed Market: Hybrid Corn and Soybean Genetics Drive Growth to 2031',
    imageData: 'Market Size: USD 8.7 billion',
    imageData2: 'Growth Drivers: genetics',
  };
}
