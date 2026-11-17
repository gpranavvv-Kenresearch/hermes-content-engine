/**
 * platformMeasure.ts: measure a platform article (LinkedIn, Medium, HackMD, Blogger, Reddit) against the
 * hard limits written in browser-generation/prompts/platform-content/*.txt.
 * Pure functions; no network except checkLinks().
 */
import * as cheerio from 'cheerio';

export type PlatformId = 'linkedin' | 'medium' | 'hackmd' | 'blogger' | 'reddit';

interface Link { href: string; kind: 'homepage' | 'primary' | 'related' | 'official'; }
interface Block {
  type: 'h1' | 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'blockquote';
  text: string;
  words: number;
  links: Link[];
  items: { words: number; links: Link[] }[];
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const norm = (u: string) => u.trim().replace(/&amp;/g, '&').replace(/\/+$/, '').toLowerCase();

function classify(href: string, primary: string): Link {
  const h = norm(href);
  if (/^https?:\/\/(www\.)?kenresearch\.com$/.test(h)) return { href, kind: 'homepage' };
  if (h.replace(/\?.*$/, '') === norm(primary)) return { href, kind: 'primary' };
  if (/^https?:\/\/(www\.)?kenresearch\.com\//.test(h)) return { href, kind: 'related' };
  return { href, kind: 'official' };
}

function htmlBlocks(html: string, primary: string): Block[] {
  const $ = cheerio.load(`<div id="root">${html}</div>`, { xmlMode: false });
  const out: Block[] = [];
  $('#root').children().each((_, el) => {
    const tag = (el as any).tagName?.toLowerCase();
    if (!['h1', 'h2', 'h3', 'p', 'ul', 'ol', 'blockquote'].includes(tag)) return;
    const $el = $(el);
    const text = $el.text().replace(/\s+/g, ' ').trim();
    const links = $el.find('a').toArray().map((a) => classify($(a).attr('href') || '', primary));
    const items = (tag === 'ul' || tag === 'ol')
      ? $el.children('li').toArray().map((li) => ({
        words: words($(li).text()),
        links: $(li).find('a').toArray().map((a) => classify($(a).attr('href') || '', primary)),
      }))
      : [];
    out.push({ type: tag as Block['type'], text, words: words(text), links, items });
  });
  return out;
}

function mdBlocks(md: string, primary: string): Block[] {
  const lines = md.replace(/\r/g, '').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  let list: string[] | null = null;
  const linksOf = (s: string) => [...s.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => classify(m[1], primary));
  const plain = (s: string) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '').replace(/^#+\s*/, '').trim();
  const flushPara = () => {
    if (!para.length) return;
    const t = para.join(' ');
    out.push({ type: 'p', text: plain(t), words: words(plain(t)), links: linksOf(t), items: [] });
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.map((i) => ({ words: words(plain(i)), links: linksOf(i) }));
    out.push({ type: 'ul', text: list.map(plain).join(' '), words: items.reduce((n, i) => n + i.words, 0), links: items.flatMap((i) => i.links), items });
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (h) { flushPara(); flushList(); const t = plain(h[2]); out.push({ type: (`h${h[1].length}` as Block['type']), text: t, words: words(t), links: linksOf(h[2]), items: [] }); continue; }
    if (li) { flushPara(); (list ??= []).push(li[1]); continue; }
    flushList(); para.push(line.trim());
  }
  flushPara(); flushList();
  return out;
}

export interface Fields { [label: string]: string }

export interface Check { name: string; ok: boolean; detail: string }
export interface Report { platform: PlatformId; totalWords: number; checks: Check[]; failures: number; structure: any }

interface Spec {
  format: 'html' | 'md';
  softWords: number; hardWords: number;
  h2: number; faq?: number; faqCap?: number;
  openingCaps?: number[]; // exact paragraphs with caps
  sectionUnits?: number; paraCap?: number; bulletCap?: number;
  closingCaps?: number[];
  links?: { homepage: [number, number]; related: [number, number]; official: [number, number]; primary: [number, number]; total: [number, number] };
  fields: Record<string, [number, number, number?]>; // label: [min, hardMax, softMax]
  extra?: string;
}

export const SPECS: Record<PlatformId, Spec> = {
  linkedin: {
    format: 'html', softWords: 1200, hardWords: 1250, h2: 4,
    openingCaps: [80, 80, 35], sectionUnits: 3, paraCap: 70, bulletCap: 25, closingCaps: [50],
    links: { homepage: [1, 1], related: [2, 2], official: [1, 2], primary: [1, 1], total: [5, 6] },
    fields: { 'Article Title': [50, 70, 65], 'SEO Title': [50, 60, 58], 'SEO Description': [140, 160, 155] },
  },
  medium: {
    format: 'html', softWords: 1500, hardWords: 1550, h2: 5, faq: 3, faqCap: 65,
    openingCaps: [70, 70, 70], sectionUnits: 3, paraCap: 65, bulletCap: 25, closingCaps: [50, 50],
    links: { homepage: [1, 1], related: [2, 2], official: [1, 2], primary: [1, 1], total: [5, 6] },
    fields: { 'Story Title': [55, 75, 70], 'Subtitle': [80, 140, 130], 'SEO Title': [50, 60, 58], 'SEO Description': [140, 156, 152] },
  },
  hackmd: {
    format: 'md', softWords: 1600, hardWords: 1650, h2: 5, faq: 4, faqCap: 65,
    openingCaps: [70, 70], sectionUnits: 4, paraCap: 55, bulletCap: 20, closingCaps: [50, 50],
    links: { homepage: [1, 1], related: [3, 3], official: [1, 2], primary: [1, 1], total: [6, 7] },
    fields: { 'Note Title': [50, 70, 66], 'Description': [140, 160, 155], 'Permalink': [20, 60, 55] },
  },
  blogger: {
    format: 'html', softWords: 1650, hardWords: 1800, h2: 6, faq: 4, faqCap: 65,
    openingCaps: [70, 70, 70], sectionUnits: 3, paraCap: 60, bulletCap: 22, closingCaps: [70],
    links: { homepage: [2, 2], related: [3, 4], official: [1, 2], primary: [1, 1], total: [7, 9] },
    fields: { 'Post Title': [55, 70, 66], 'Search Description': [120, 150, 145] },
  },
  reddit: {
    format: 'md', softWords: 600, hardWords: 650, h2: 0,
    fields: { 'Post Title': [60, 120, 110], 'First Comment': [0, 300, 280] },
  },
};

export function parseLabelled(raw: string, labels: string[]): Fields {
  const out: Fields = {};
  const lines = raw.replace(/\r/g, '').split('\n');
  let cur: string | null = null;
  for (const l of lines) {
    const t = l.trim();
    const hit = labels.find((x) => x.toLowerCase() === t.toLowerCase());
    if (hit) { cur = hit; out[cur] = ''; continue; }
    if (cur) out[cur] += l + '\n';
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

export function measure(platform: PlatformId, article: string, fields: Fields, primaryUrl: string): Report {
  const spec = SPECS[platform];
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const blocks = spec.format === 'html' ? htmlBlocks(article, primaryUrl) : mdBlocks(article, primaryUrl);
  const body = blocks.filter((b) => b.type !== 'h1');
  const totalWords = body.reduce((n, b) => n + b.words, 0) + blocks.filter((b) => b.type === 'h1').reduce((n, b) => n + b.words, 0);

  add('words soft', totalWords <= spec.softWords, `${totalWords} (soft ${spec.softWords})`);
  add('words hard', totalWords <= spec.hardWords, `${totalWords} (hard ${spec.hardWords})`);

  // --- structure: opening / sections / faq / closing
  const firstH2 = body.findIndex((b) => b.type === 'h2');
  const opening = firstH2 < 0 ? body : body.slice(0, firstH2);
  const faqIdx = body.findIndex((b) => b.type === 'h2' && /frequently asked questions/i.test(b.text));
  const sectionsRaw: { heading: Block; blocks: Block[] }[] = [];
  if (firstH2 >= 0) {
    let cur: { heading: Block; blocks: Block[] } | null = null;
    for (let i = firstH2; i < body.length; i++) {
      const b = body[i];
      if (b.type === 'h2') { cur = { heading: b, blocks: [] }; sectionsRaw.push(cur); } else cur?.blocks.push(b);
    }
  }
  const isFaq = (s: { heading: Block }) => /frequently asked questions/i.test(s.heading.text);
  const isMeta = (s: { heading: Block }) => platform === 'hackmd' && /^(key facts|strategic takeaway)$/i.test(s.heading.text);
  const sections = sectionsRaw.filter((s) => !isFaq(s) && !isMeta(s));
  const faq = sectionsRaw.find(isFaq);
  const keyFacts = sectionsRaw.find((s) => platform === 'hackmd' && /^key facts$/i.test(s.heading.text));
  const takeaway = sectionsRaw.find((s) => platform === 'hackmd' && /^strategic takeaway$/i.test(s.heading.text));
  if (platform === 'hackmd') {
    const ul = keyFacts?.blocks.find((b) => b.type === 'ul');
    add('Key facts 6 bullets <= 22w', !!ul && ul.items.length === 6 && ul.items.every((i) => i.words <= 22), ul ? `${ul.items.length} bullets: ${ul.items.map((i) => i.words).join(',')}` : 'missing');
    const tp = takeaway?.blocks.filter((b) => b.type === 'p') ?? [];
    add('closing 2 paragraphs <= 50w', tp.length === 2 && tp.every((b) => b.words <= 50), tp.map((b) => b.words).join(',') || 'missing');
  }

  if (platform !== 'reddit') {
    add('H2 count', sections.length === spec.h2, `${sections.length} (need ${spec.h2})`);
    const starts = sections.map((s) => s.heading.text.split(/\s+/)[0].toLowerCase());
    add('H2 distinct first words', new Set(starts).size === starts.length, starts.join(' / '));
    const hw = sections.map((s) => s.heading.words);
    add('H2 8-14 words', hw.every((n) => n >= 8 && n <= 14), hw.join(','));
    if (platform === 'linkedin') add('LinkedIn H2 first words Where/Which/What/How', ['where', 'which', 'what', 'how'].every((w, i) => starts[i] === w), starts.join(' / '));
    if (spec.openingCaps) {
      const o = opening.filter((b) => b.type === 'p');
      add('opening paragraph count', o.length === spec.openingCaps.length, `${o.length} (need ${spec.openingCaps.length})`);
      add('opening paragraph caps', o.every((b, i) => b.words <= (spec.openingCaps![i] ?? 999)), o.map((b) => b.words).join(','));
    }
    if (spec.sectionUnits) {
      const unitCounts = sections.map((s, i) => {
        const units = s.blocks.filter((b) => b.type !== 'h3');
        return units.length;
      });
      const isLast = (i: number) => i === sections.length - 1;
      const li = platform === 'linkedin';
      add('section units <= cap', sections.every((s, i) => (li && isLast(i)) ? true : unitCounts[i] <= (spec.sectionUnits as number) + (platform === 'medium' && isLast(i) ? 1 : 0)), unitCounts.join(','));
      const over = sections.flatMap((s, i) => s.blocks.filter((b) => b.type === 'p' && b.words > (spec.paraCap as number) && !(li && isLast(i))).map((b) => `${b.words}w@S${i + 1}`));
      add('paragraphs <= word cap', over.length === 0, over.length ? over.join(' ') : `all <= ${spec.paraCap}`);
      const bigBullets = sections.flatMap((s, i) => s.blocks.filter((b) => b.type === 'ul' || b.type === 'ol').flatMap((b) => b.items.filter((it) => it.words > (spec.bulletCap as number) && !(li && isLast(i))).map((it) => `${it.words}w@S${i + 1}`)));
      add('bullets <= word cap', bigBullets.length === 0, bigBullets.length ? bigBullets.join(' ') : `all <= ${spec.bulletCap}`);
    }
    if (platform === 'linkedin') {
      const last = sections[sections.length - 1];
      const ul = last?.blocks.find((b) => b.type === 'ul');
      add('LinkedIn H2 4 has 3 bullets', ul?.items.length === 3, `${ul?.items.length ?? 0}`);
      const ps = last?.blocks.filter((b) => b.type === 'p') ?? [];
      const q = ps.find((b) => /\?\s*$/.test(b.text));
      add('closing question form', !!q && /^What is the first /i.test(q.text) && !/\bor\b/i.test(q.text) && q.words <= 50, q ? `${q.words}w "${q.text.slice(0, 90)}"` : 'no question found');
      const closing = ps[ps.length - 1];
      add('closing paragraph <= 50w', !!closing && closing.words <= 50, `${closing?.words}`);
    }
    if (spec.faq && faq) {
      const qs = faq.blocks.filter((b) => b.type === 'h3');
      add('FAQ question count', qs.length === spec.faq, `${qs.length} (need ${spec.faq})`);
      const ans = faq.blocks.filter((b) => b.type === 'p');
      const faqAns = ans.slice(0, spec.faq);
      add('FAQ answers 40-65w', faqAns.every((b) => b.words >= 40 && b.words <= (spec.faqCap as number)), faqAns.map((b) => b.words).join(','));
      add('FAQ no links', faq.blocks.every((b) => b.links.length === 0), 'links in FAQ: ' + faq.blocks.reduce((n, b) => n + b.links.length, 0));
      const closing = ans.slice(spec.faq);
      if (spec.closingCaps) {
        add('closing paragraph count', closing.length === spec.closingCaps.length, `${closing.length} (need ${spec.closingCaps.length})`);
        add('closing paragraph caps', closing.every((b, i) => b.words <= (spec.closingCaps![i] ?? 999)), closing.map((b) => b.words).join(','));
      }
    } else if (spec.faq) add('FAQ present', false, 'missing');
    add('no H3 outside FAQ', sections.every((s) => s.blocks.every((b) => b.type !== 'h3')), 'h3 inside sections: ' + sections.reduce((n, s) => n + s.blocks.filter((b) => b.type === 'h3').length, 0));
  }

  // --- links
  const allBlocks = blocks;
  const links = allBlocks.flatMap((b) => b.links);
  const count = (k: Link['kind']) => links.filter((l) => l.kind === k).length;
  if (spec.links) {
    const L = spec.links;
    const rng = (n: number, [a, b]: [number, number]) => n >= a && n <= b;
    add('links homepage', rng(count('homepage'), L.homepage), `${count('homepage')} (need ${L.homepage.join('-')})`);
    add('links related', rng(count('related'), L.related), `${count('related')} (need ${L.related.join('-')})`);
    add('links official', rng(count('official'), L.official), `${count('official')} (need ${L.official.join('-')})`);
    add('links primary', rng(count('primary'), L.primary), `${count('primary')} (need ${L.primary.join('-')})`);
    add('links total', rng(links.length, L.total), `${links.length} (need ${L.total.join('-')})`);
  } else if (platform === 'reddit') {
    add('Reddit body has no Ken links', count('homepage') + count('related') + count('primary') === 0, `ken links: ${count('homepage') + count('related') + count('primary')}`);
    add('Reddit official links <= 2', count('official') <= 2, `${count('official')}`);
  }
  const perPara = allBlocks.flatMap((b) => (b.type === 'ul' || b.type === 'ol') ? b.items.map((i) => i.links.length) : [b.links.length]);
  add('<=1 link per paragraph/item', perPara.every((n) => n <= 1), 'max ' + Math.max(0, ...perPara));
  const flags = allBlocks.filter((b) => b.type === 'p' || b.type === 'ul' || b.type === 'ol').map((b) => b.links.length > 0);
  let consecutive = 0; for (let i = 1; i < flags.length; i++) if (flags[i] && flags[i - 1]) consecutive++;
  add('no consecutive linked paragraphs', consecutive === 0, `${consecutive} consecutive pairs`);
  add('no links in headings', allBlocks.filter((b) => b.type.startsWith('h')).every((b) => b.links.length === 0), 'ok');

  // --- brand
  const rawText = article;
  if (spec.format === 'html') {
    const $ = cheerio.load(`<div id="root">${article}</div>`);
    let plain = 0, total = 0, firstLinked: boolean | null = null;
    $('#root *').addBack().contents().each((_, n) => {
      if (n.type !== 'text') return;
      const m = (n.data || '').match(/Ken Research/g); if (!m) return;
      const inStrong = $(n).parents('strong,b').length > 0;
      const inHome = $(n).parents('a').toArray().some((a) => classify($(a).attr('href') || '', primaryUrl).kind === 'homepage');
      for (let i = 0; i < m.length; i++) { total++; if (!inStrong) plain++; if (firstLinked === null) firstLinked = inHome; }
    });
    if (platform !== 'reddit') add('brand mentions all in <strong>', plain === 0, `${total} mentions, ${plain} not bold`);
    if (platform !== 'reddit') add('first Ken Research mention is linked homepage', firstLinked === true, String(firstLinked));
    const openTags = ['p', 'ul', 'ol', 'li', 'h2', 'h3', 'strong', 'a'].map((t) => [t, (rawText.match(new RegExp(`<${t}[\\s>]`, 'gi')) || []).length, (rawText.match(new RegExp(`</${t}>`, 'gi')) || []).length] as const);
    const bad = openTags.filter(([, o, c]) => o !== c).map(([t, o, c]) => `${t}:${o}/${c}`);
    add('HTML tags balanced', bad.length === 0, bad.length ? bad.join(' ') : 'ok');
    const bareAmp = (rawText.match(/&(?!(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);)/gi) || []).length;
    add('ampersands escaped', bareAmp === 0, `${bareAmp} bare &`);
    add('no percent-encoded ?=& in hrefs', !/href="[^"]*%3[FfDd]|href="[^"]*%26/.test(rawText), 'ok');
    add('no tables / h1 / img', !/<(table|h1|img)[\s>]/i.test(rawText), 'ok');
  } else {
    const boldBrand = (rawText.match(/\*\*Ken Research\*\*|\*\*\[Ken Research\]|\[\*\*Ken Research\*\*\]/g) || []).length;
    const anyBrand = (rawText.match(/Ken Research/g) || []).length;
    if (platform !== 'reddit') add('brand mentions all bold', boldBrand >= anyBrand, `${anyBrand} mentions, ${boldBrand} bold`);
  }
  add('no em dashes', !/—/.test(rawText), `${(rawText.match(/—/g) || []).length}`);

  // --- fields
  for (const [label, [min, hard, soft]] of Object.entries(spec.fields)) {
    const v = (fields[label] || '').trim();
    if (!v) { add(`field ${label}`, false, 'missing'); continue; }
    const n = v.length;
    add(`field ${label} chars`, n >= min && n <= hard, `${n} (hard ${min}-${hard}${soft ? `, soft ${soft}` : ''})${soft && n > soft ? ' ABOVE SOFT' : ''}`);
  }

  const failures = checks.filter((c) => !c.ok).length;
  return {
    platform, totalWords, checks, failures,
    structure: {
      opening: opening.map((b) => b.words),
      sections: sections.map((s) => ({ heading: s.heading.text, units: s.blocks.map((b) => `${b.type}:${b.words}`) })),
    },
  };
}

export async function checkLinks(article: string, primaryUrl: string): Promise<string[]> {
  const hrefs = new Set<string>();
  for (const m of article.matchAll(/href="([^"]+)"/g)) hrefs.add(m[1].replace(/&amp;/g, '&'));
  for (const m of article.matchAll(/\]\((https?:[^)\s]+)\)/g)) hrefs.add(m[1]);
  const lines: string[] = [];
  for (const u of hrefs) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(u, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0' } });
      clearTimeout(t);
      lines.push(`${r.status} ${u}`);
    } catch (e: any) { lines.push(`ERR(${e?.name || 'fetch'}) ${u}`); }
  }
  return lines;
}

export function formatReport(r: Report): string {
  const lines = [`# ${r.platform}: ${r.failures} failing checks, ${r.totalWords} words`, ''];
  for (const c of r.checks) lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  return lines.join('\n');
}
