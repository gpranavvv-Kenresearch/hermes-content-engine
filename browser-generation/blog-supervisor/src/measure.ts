/**
 * Deterministic MEASUREMENTS of a finished blog article. This file gives the supervisor exact numbers; it does not
 * decide whether they are good enough. The V1.3 thresholds live in roles/supervisor.md, and Hermes judges against
 * them. The only code verdicts are the structural hardFails below (garbage, not style).
 */

export interface LinkInfo {
  href: string;
  host: string;
  kind: 'ken-homepage' | 'ken-primary' | 'ken-adjacent' | 'google-preferred-source' | 'government' | 'other-external' | 'invalid';
  inHeading: boolean;
  inBlockquote: boolean;
  /** 0-based index of the block (paragraph or list item) holding the link, -1 for headings. */
  block: number;
}

export interface BlogMeasurements {
  words: number;
  paragraphs: { count: number; maxWords: number; over90: number; outside55to85: number };
  headings: { h1: number; h2: number; h3: number; h2Texts: string[]; h2QuestionCount: number; maxH2Words: number };
  tables: number;
  blockquotes: number;
  emDashes: number;
  images: number;
  imagePlaceholders: number;
  unresolvedBraces: number;
  kenResearch: { mentions: number; unbolded: number };
  numbers: { total: number; unbolded: number; sampleUnbolded: string[]; densestPer100: number };
  style: { stockPhrases: string[]; hereOpeners: number; sameShapeHeadings: boolean };
  links: {
    total: number;
    kenHomepage: number;
    kenPrimary: number;
    kenAdjacent: number;
    googlePreferredSource: number;
    government: number;
    otherExternal: number;
    invalid: number;
    externalHosts: string[];
    inHeadings: number;
    maxLinksInOneBlock: number;
    /** Pairs of neighbouring paragraphs/list items that both hold a link (the intro's two paragraphs are exempt). */
    consecutiveLinkedBlocks: number;
    introHasNonKenLink: boolean;
    finalParagraphHrefs: string[];
    paragraphBeforeFinalHasLink: boolean;
    primaryOnlyInFinalParagraph: boolean;
    list: LinkInfo[];
  };
  seoTitle: { length: number; equalsH1: boolean; containsKenResearch: boolean } | null;
  metaDescription: { length: number } | null;
  /** Bold numbers in the article that do not appear anywhere in the report evidence (government-sourced ones can be legitimate). */
  figuresNotInEvidence: string[];
  h1HasBoldKenResearch: boolean;
}

const ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&ndash;': '–', '&mdash;': '—' };
const decode = (s: string) => s.replace(/&(?:nbsp|amp|lt|gt|quot|#39|ndash|mdash);/g, (m) => ENTITIES[m] ?? m);
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Stock phrases that mark generic AI prose. Counted by code; the supervisor decides what to do about them. */
export const STOCK_PHRASES = [
  "in today's digital landscape", 'in the ever-evolving', "it's important to note", 'it is worth mentioning', 'dive into', 'deep dive', 'delve',
  'game-changer', 'game changer', 'revolutionize', 'transformative', 'cutting-edge', 'state-of-the-art', 'harness the power', 'unlock the potential',
  'seamlessly', 'empower', 'at its core', 'tapestry', 'navigate the landscape', 'in conclusion', 'comprehensive guide',
];

const GOV_HOST_RES = [
  /(^|\.)gov$/, /(^|\.)gov\.[a-z]{2,3}$/, /(^|\.)gob\.[a-z]{2,3}$/, /(^|\.)gouv\.[a-z]{2,3}$/, /(^|\.)govt\.[a-z]{2,3}$/,
  /(^|\.)go\.[a-z]{2}$/, /(^|\.)gv\.[a-z]{2}$/, /(^|\.)gub\.[a-z]{2}$/, /(^|\.)gc\.ca$/, /(^|\.)canada\.ca$/, /(^|\.)admin\.ch$/,
  /(^|\.)europa\.eu$/, /(^|\.)bund\.de$/, /(^|\.)gov\.br$/,
];

export function looksGovernmentHost(host: string): boolean {
  return GOV_HOST_RES.some((re) => re.test(host));
}

const normalizeUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();

function classifyLink(href: string, primaryUrl: string | undefined): LinkInfo['kind'] {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return 'invalid';
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  if (host === 'google.com' && url.pathname.startsWith('/preferences/source')) return 'google-preferred-source';
  if (host === 'kenresearch.com' || host.endsWith('.kenresearch.com')) {
    if (primaryUrl && normalizeUrl(href) === normalizeUrl(primaryUrl)) return 'ken-primary';
    if (url.pathname === '/' || url.pathname === '') return 'ken-homepage';
    return 'ken-adjacent';
  }
  return looksGovernmentHost(host) ? 'government' : 'other-external';
}

interface Block {
  kind: 'p' | 'li';
  words: number;
  inBlockquote: boolean;
  intro: boolean;
  linkCount: number;
  hrefs: string[];
  figures: number;
  text: string;
}

export function measureBlog(input: {
  html: string;
  seoTitle?: string;
  metaDescription?: string;
  primaryUrl?: string;
  /** Plain text of the report evidence (fact statements and values) for the figuresNotInEvidence check. */
  evidenceText?: string;
}): BlogMeasurements {
  const html = input.html;
  const tagRe = /<(\/)?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;

  let strong = 0;
  let heading = 0;
  let blockquote = 0;
  let anchorHref: string | null = null;
  let seenH2 = false;
  let blockIndex = -1;
  let current: Block | null = null;
  let headingBuf: { level: number; text: string } | null = null;

  const blocks: Block[] = [];
  const links: LinkInfo[] = [];
  const h2Texts: string[] = [];
  let h1 = 0, h2 = 0, h3 = 0, tables = 0, blockquotes = 0, images = 0;
  let totalWords = 0;
  let kenMentions = 0, kenUnbolded = 0;
  let numTotal = 0, numUnbolded = 0;
  const sampleUnbolded: string[] = [];
  const boldNumbers: string[] = [];
  let visibleText = '';

  const onText = (raw: string) => {
    const text = decode(raw);
    if (!text.trim()) return;
    visibleText += text + ' ';
    totalWords += wordCount(text);
    if (current) { current.words += wordCount(text); current.text += text + ' '; }
    if (headingBuf) headingBuf.text += text;
    for (const m of text.matchAll(/Ken Research/gi)) {
      void m;
      kenMentions++;
      if (strong === 0) kenUnbolded++;
    }
    if (heading === 0) {
      for (const m of text.matchAll(/(?<![A-Za-z])\d[\d,]*(?:\.\d+)?/g)) {
        numTotal++;
        if (current) current.figures++;
        if (strong > 0) boldNumbers.push(m[0]);
        else {
          numUnbolded++;
          if (sampleUnbolded.length < 8) sampleUnbolded.push(m[0]);
        }
      }
    }
  };

  let last = 0;
  for (const m of html.matchAll(tagRe)) {
    onText(html.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const closing = !!m[1];
    const name = m[2]!.toLowerCase();
    const attrs = m[3] ?? '';

    if (name === 'strong' || name === 'b') strong += closing ? -1 : 1;
    else if (/^h[1-6]$/.test(name)) {
      const level = Number(name[1]);
      if (!closing) {
        heading++;
        headingBuf = { level, text: '' };
        if (level === 1) h1++;
        else if (level === 2) { h2++; seenH2 = true; }
        else if (level === 3) h3++;
      } else {
        heading = Math.max(0, heading - 1);
        if (headingBuf?.level === 2) h2Texts.push(headingBuf.text.trim());
        headingBuf = null;
      }
    } else if (name === 'blockquote') {
      blockquote += closing ? -1 : 1;
      if (!closing) blockquotes++;
    } else if (name === 'table' && !closing) tables++;
    else if (name === 'img' && !closing) images++;
    else if (name === 'p' || name === 'li') {
      if (!closing) {
        current = { kind: name, words: 0, inBlockquote: blockquote > 0, intro: !seenH2, linkCount: 0, hrefs: [], figures: 0, text: '' };
        blockIndex++;
      } else if (current) {
        blocks.push(current);
        current = null;
      }
    } else if (name === 'a') {
      if (!closing) {
        anchorHref = /href\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '';
        const href = decode(anchorHref);
        const kind = classifyLink(href, input.primaryUrl);
        let host = '';
        try { host = new URL(href).hostname.replace(/^www\./, '').toLowerCase(); } catch { /* invalid */ }
        links.push({ href, host, kind, inHeading: heading > 0, inBlockquote: blockquote > 0, block: heading > 0 ? -1 : blockIndex });
        if (current) { current.linkCount++; current.hrefs.push(href); }
      } else anchorHref = null;
    }
  }
  onText(html.slice(last));

  // --- paragraphs
  const paras = blocks.filter((b) => b.kind === 'p' && !b.inBlockquote);
  const maxWords = paras.reduce((n, b) => Math.max(n, b.words), 0);

  // --- link structure
  const linked = blocks.map((b) => b.linkCount > 0);
  let consecutive = 0;
  for (let i = 1; i < blocks.length; i++) {
    if (linked[i] && linked[i - 1] && !(blocks[i]!.intro && blocks[i - 1]!.intro)) consecutive++;
  }
  const lastPara = [...blocks].reverse().find((b) => b.kind === 'p' && !b.inBlockquote);
  const lastParaIdx = lastPara ? blocks.lastIndexOf(lastPara) : -1;
  const before = lastParaIdx > 0 ? blocks[lastParaIdx - 1] : undefined;
  const primaryLinks = links.filter((l) => l.kind === 'ken-primary');
  const finalHrefs = lastPara?.hrefs ?? [];
  const primaryOnlyFinal = primaryLinks.length > 0 && primaryLinks.every((l) => !!lastPara && lastPara.hrefs.includes(l.href));

  const count = (k: LinkInfo['kind']) => links.filter((l) => l.kind === k).length;
  const externalHosts = [...new Set(links.filter((l) => l.kind === 'government' || l.kind === 'other-external').map((l) => l.host))];

  // --- evidence cross-check on bold figures
  const norm = (s: string) => s.replace(/,/g, '');
  const evidence = norm(input.evidenceText ?? '');
  const figuresNotInEvidence = input.evidenceText
    ? [...new Set(boldNumbers.map(norm))].filter((n) => n.length >= 2 && !/^(19|20)\d{2}$/.test(n) && !evidence.includes(n)).slice(0, 15)
    : [];

  // --- style observations (descriptive only)
  const lowered = visibleText.toLowerCase();
  const stockPhrases = STOCK_PHRASES.filter((p) => lowered.includes(p));
  const hereOpeners = paras.filter((b) => /^\s*here(?:'s| is| are)\b/i.test(b.text)).length;
  const densestPer100 = Math.round(Math.max(0, ...paras.filter((b) => b.words >= 25).map((b) => (b.figures / b.words) * 100)) * 10) / 10;
  const shapeOf = (t: string) => (t.trim().endsWith('?') ? 'q' : /^(how|what|why|which|where|who|when|is|are|can|does|do|will)\b/i.test(t.trim()) ? 'q' : 's');
  const shapes = h2Texts.map(shapeOf);
  const sameShapeHeadings = h2Texts.length >= 5 && shapes.every((s) => s === shapes[0]);

  const seoTitle = input.seoTitle?.trim();
  const h1Text = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, '').trim();

  return {
    words: totalWords,
    paragraphs: {
      count: paras.length,
      maxWords,
      over90: paras.filter((b) => b.words > 90).length,
      outside55to85: paras.filter((b) => b.words < 55 || b.words > 85).length,
    },
    headings: {
      h1, h2, h3,
      h2Texts,
      h2QuestionCount: h2Texts.filter((t) => t.endsWith('?')).length,
      maxH2Words: h2Texts.reduce((n, t) => Math.max(n, wordCount(t)), 0),
    },
    tables,
    blockquotes,
    emDashes: (visibleText.match(/—/g) ?? []).length,
    images,
    imagePlaceholders: (html.match(/YOUR_IMAGE_URL_HERE/g) ?? []).length,
    unresolvedBraces: (html.match(/\{\{|\}\}/g) ?? []).length,
    kenResearch: { mentions: kenMentions, unbolded: kenUnbolded },
    numbers: { total: numTotal, unbolded: numUnbolded, sampleUnbolded, densestPer100 },
    style: { stockPhrases, hereOpeners, sameShapeHeadings },
    links: {
      total: links.length,
      kenHomepage: count('ken-homepage'),
      kenPrimary: count('ken-primary'),
      kenAdjacent: count('ken-adjacent'),
      googlePreferredSource: count('google-preferred-source'),
      government: count('government'),
      otherExternal: count('other-external'),
      invalid: count('invalid'),
      externalHosts,
      inHeadings: links.filter((l) => l.inHeading).length,
      maxLinksInOneBlock: blocks.reduce((n, b) => Math.max(n, b.linkCount), 0),
      consecutiveLinkedBlocks: consecutive,
      introHasNonKenLink: blocks.some((b) => b.intro && b.hrefs.some((h) => !/kenresearch\.com/i.test(h))),
      finalParagraphHrefs: finalHrefs,
      paragraphBeforeFinalHasLink: !!before && before.linkCount > 0,
      primaryOnlyInFinalParagraph: primaryOnlyFinal,
      list: links,
    },
    h1HasBoldKenResearch: /<h1[^>]*>[\s\S]*?<strong>\s*Ken Research\s*<\/strong>[\s\S]*?<\/h1>/i.test(html),
    seoTitle: seoTitle === undefined ? null : { length: seoTitle.length, equalsH1: !!h1Text && h1Text.toLowerCase() === seoTitle.toLowerCase(), containsKenResearch: /ken research/i.test(seoTitle) },
    metaDescription: input.metaDescription === undefined ? null : { length: input.metaDescription.trim().length },
    figuresNotInEvidence,
  };
}

/** Structural garbage only (never style). A hard fail cannot be waved through by the supervisor. */
export function structuralHardFails(m: BlogMeasurements): string[] {
  const fails: string[] = [];
  if (m.headings.h1 !== 1) fails.push(`the article has ${m.headings.h1} H1 headings (needs exactly 1)`);
  if (m.headings.h2 < 3) fails.push(`only ${m.headings.h2} H2 sections (this is not a complete article)`);
  if (m.words < 700) fails.push(`only ${m.words} words (a real article is about 1,400)`);
  if (m.words > 2600) fails.push(`${m.words} words (far beyond the 1,800-word hard limit)`);
  if (m.unresolvedBraces > 0) fails.push('unfilled {{ }} template placeholders remain');
  if (m.tables > 0) fails.push(`${m.tables} table(s); the prompt forbids tables`);
  return fails;
}

/** V1.3 non-negotiables. Sent back for a fix while fix requests remain; never blocks the article once they are used up. */
export function v13RuleFails(m: BlogMeasurements): string[] {
  const fails: string[] = [];
  if (!m.h1HasBoldKenResearch) fails.push('the H1 must contain <strong>Ken Research</strong>');
  if (m.kenResearch.unbolded > 0) fails.push(`${m.kenResearch.unbolded} "Ken Research" mention(s) are not bold`);
  if (m.seoTitle?.containsKenResearch) fails.push('the SEO Title must not contain "Ken Research"');
  if (m.links.kenHomepage !== 1) fails.push(`${m.links.kenHomepage} Ken Research homepage links (needs exactly 1, in the first paragraph)`);
  if (m.links.kenAdjacent !== 4) fails.push(`${m.links.kenAdjacent} adjacent Ken Research report links (needs exactly 4)`);
  if (m.links.kenPrimary !== 1) fails.push(`${m.links.kenPrimary} Primary Report links (needs exactly 1, in the final call-to-action)`);
  // Whether a host is a government source is judged by the supervisor: regulators and central banks often sit on .co.za, .org.za, .org and similar hosts.
  if (m.links.government + m.links.otherExternal !== 3) fails.push(`${m.links.government + m.links.otherExternal} external links (needs exactly 3, all government sources)`);
  if (m.links.inHeadings > 0) fails.push('links inside headings');
  return fails;
}

/** Compact table the supervisor reads. Exact numbers; thresholds are in the role text. */
export function formatMeasurements(m: BlogMeasurements): string {
  const L = m.links;
  const lines = [
    `Words: ${m.words}`,
    `Paragraphs (body, excluding blockquote): ${m.paragraphs.count}; longest ${m.paragraphs.maxWords} words; over 90 words: ${m.paragraphs.over90}; outside 55-85 words: ${m.paragraphs.outside55to85}`,
    `Headings: H1 ${m.headings.h1}, H2 ${m.headings.h2}, H3 ${m.headings.h3}; question H2s ${m.headings.h2QuestionCount}; longest H2 ${m.headings.maxH2Words} words`,
    `H2 list: ${m.headings.h2Texts.map((t, i) => `${i + 1}) ${t}`).join(' | ')}`,
    `Tables ${m.tables}; blockquotes ${m.blockquotes}; em dashes ${m.emDashes}; images ${m.images}; unresolved image placeholders ${m.imagePlaceholders}`,
    `"Ken Research" mentions ${m.kenResearch.mentions}, not bold ${m.kenResearch.unbolded}`,
    `Numbers outside headings ${m.numbers.total}, not bold ${m.numbers.unbolded}${m.numbers.sampleUnbolded.length ? ` (e.g. ${m.numbers.sampleUnbolded.join(', ')})` : ''}; densest paragraph holds ${m.numbers.densestPer100} figures per 100 words`,
    `Style: stock phrases ${m.style.stockPhrases.length}${m.style.stockPhrases.length ? ` (${m.style.stockPhrases.join('; ')})` : ''}; paragraphs opening with "Here": ${m.style.hereOpeners}; every H2 has the same grammatical shape: ${m.style.sameShapeHeadings}`,
    `Links total ${L.total}: Ken homepage ${L.kenHomepage}, Ken adjacent ${L.kenAdjacent}, Ken primary report ${L.kenPrimary}, Google preferred-source ${L.googlePreferredSource}, government-looking ${L.government}, other external ${L.otherExternal}, invalid ${L.invalid}`,
    `External hosts: ${L.externalHosts.join(', ') || 'none'}`,
    `Links inside headings ${L.inHeadings}; most links in one paragraph/bullet ${L.maxLinksInOneBlock}; back-to-back linked blocks (intro exempt) ${L.consecutiveLinkedBlocks}; non-Ken link in intro ${L.introHasNonKenLink}`,
    `Final paragraph links: ${L.finalParagraphHrefs.join(', ') || 'none'}; primary report only in final paragraph ${L.primaryOnlyInFinalParagraph}; paragraph before final has a link ${L.paragraphBeforeFinalHasLink}`,
    m.seoTitle ? `SEO title: ${m.seoTitle.length} characters; equals H1 ${m.seoTitle.equalsH1}; contains Ken Research ${m.seoTitle.containsKenResearch}` : 'SEO title: not extracted',
    m.metaDescription ? `Meta description: ${m.metaDescription.length} characters` : 'Meta description: not extracted',
    m.figuresNotInEvidence.length ? `Bold figures not found in the report evidence: ${m.figuresNotInEvidence.join(', ')}` : 'Bold figures not found in the report evidence: none',
  ];
  return lines.join('\n');
}
