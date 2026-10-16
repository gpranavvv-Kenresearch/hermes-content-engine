import { Readability } from '@mozilla/readability';
import { Defuddle } from 'defuddle/node';
import { JSDOM, VirtualConsole } from 'jsdom';

export interface ExtractedTable {
  caption?: string;
  headers: string[];
  rows: string[][];
}

export type ExtractionMethod = 'defuddle' | 'readability' | 'fallback';

export interface ExtractedContent {
  title: string;
  text: string;
  markdown?: string;
  canonicalUrl?: string;
  publishedAt?: string;
  tables: ExtractedTable[];
  method: ExtractionMethod;
}

/** A main-content result shorter than this is treated as a failed extraction and the next strategy runs. */
const MIN_USEFUL_CHARS = 200;

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'head']);
const NOISE_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'nav', 'footer', 'header', 'aside', 'form', 'button'];
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'li', 'ul', 'ol', 'tr', 'table', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'figure', 'figcaption', 'caption', 'dd', 'dt', 'dl', 'thead', 'tbody',
]);

function makeDom(html: string, url: string): JSDOM {
  // Scripts are never executed (default) and no subresources are loaded.
  return new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
}

function collapse(s: string): string {
  return s.replace(/[ \t\r\f\v ]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function walkText(node: Node, out: string[]): void {
  if (node.nodeType === 3) {
    out.push(node.textContent ?? '');
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return;
  if (tag === 'td' || tag === 'th') {
    out.push(' ');
    for (const c of Array.from(el.childNodes)) walkText(c, out);
    out.push(' ');
    return;
  }
  const block = BLOCK_TAGS.has(tag);
  if (block) out.push('\n');
  for (const c of Array.from(el.childNodes)) walkText(c, out);
  if (block) out.push('\n');
}

function nodeToText(node: Node): string {
  const out: string[] = [];
  walkText(node, out);
  return collapse(out.join(''));
}

function htmlFragmentToText(html: string): string {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  return nodeToText(dom.window.document.body);
}

function cellText(el: Element): string {
  return nodeToText(el).replace(/\s*\n\s*/g, ' ');
}

export function extractTables(doc: Document): ExtractedTable[] {
  const tables: ExtractedTable[] = [];
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    const rowEls = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.closest('table') === table);
    const rows: string[][] = [];
    let headers: string[] = [];
    for (const tr of rowEls) {
      const cells = Array.from(tr.children).filter((c) => /^(td|th)$/i.test(c.tagName));
      if (cells.length === 0) continue;
      const texts = cells.map(cellText);
      const allHeader = cells.every((c) => c.tagName.toLowerCase() === 'th');
      if (allHeader && headers.length === 0 && rows.length === 0) headers = texts;
      else rows.push(texts);
    }
    if (headers.length === 0 && rows.length === 0) continue;
    const caption = table.querySelector('caption');
    const t: ExtractedTable = { headers, rows };
    const capText = caption ? cellText(caption) : '';
    if (capText) t.caption = capText;
    tables.push(t);
  }
  return tables;
}

function renderTable(t: ExtractedTable): string {
  const lines: string[] = [];
  if (t.caption) lines.push(t.caption);
  if (t.headers.length) lines.push(t.headers.join(' | '));
  for (const r of t.rows) lines.push(r.join(' | '));
  return lines.join('\n');
}

function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Appends any table content the main extractor dropped, so numbers in tables survive. */
function withTables(text: string, tables: ExtractedTable[]): string {
  const hay = squash(text.replace(/\|/g, ' '));
  const missing: string[] = [];
  for (const t of tables) {
    const rowsMissing = t.rows.filter((r) => !hay.includes(squash(r.join(' '))));
    if (rowsMissing.length > 0) missing.push(renderTable({ ...t, rows: rowsMissing }));
  }
  return missing.length ? `${text}\n\n${missing.join('\n\n')}`.trim() : text;
}

function resolveUrl(value: string | null | undefined, base: string): string | undefined {
  if (!value || !value.trim()) return undefined;
  try {
    return new URL(value.trim(), base).toString();
  } catch {
    return undefined;
  }
}

function pickMeta(doc: Document, names: string[]): string | undefined {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
    const v = el?.getAttribute('content')?.trim();
    if (v) return v;
  }
  return undefined;
}

function jsonLdDate(doc: Document): string | undefined {
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const walk = (v: unknown): string | undefined => {
        if (Array.isArray(v)) {
          for (const x of v) {
            const r = walk(x);
            if (r) return r;
          }
        } else if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>;
          if (typeof o.datePublished === 'string') return o.datePublished;
          for (const x of Object.values(o)) {
            const r = walk(x);
            if (r) return r;
          }
        }
        return undefined;
      };
      const r = walk(JSON.parse(s.textContent ?? ''));
      if (r) return r;
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return undefined;
}

function normalizeDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function findPublishedAt(doc: Document): string | undefined {
  const meta = pickMeta(doc, ['article:published_time', 'datePublished', 'og:published_time', 'date', 'DC.date.issued', 'publish-date']);
  const time = doc.querySelector('time[datetime]')?.getAttribute('datetime') ?? undefined;
  return normalizeDate(meta) ?? normalizeDate(jsonLdDate(doc)) ?? normalizeDate(time);
}

function findTitle(doc: Document): string {
  const og = pickMeta(doc, ['og:title']);
  const h1 = doc.querySelector('h1')?.textContent;
  const t = doc.querySelector('title')?.textContent;
  return squash(og ?? h1 ?? t ?? '');
}

async function tryDefuddle(html: string, url: string): Promise<{ text: string; markdown?: string; title?: string } | null> {
  try {
    const dom = makeDom(html, url);
    const res = await Defuddle(dom, url, {
      markdown: false,
      separateMarkdown: true,
      useAsync: false,
      fetch: () => Promise.reject(new Error('network disabled in extractor')),
    });
    const text = htmlFragmentToText(res.content ?? '');
    if (text.length < MIN_USEFUL_CHARS) return null;
    const out: { text: string; markdown?: string; title?: string } = { text };
    if (res.contentMarkdown) out.markdown = res.contentMarkdown;
    if (res.title) out.title = res.title;
    return out;
  } catch {
    return null;
  }
}

function tryReadability(html: string, url: string): { text: string; title?: string } | null {
  try {
    const dom = makeDom(html, url);
    const article = new Readability(dom.window.document).parse();
    if (!article) return null;
    const text = article.content ? htmlFragmentToText(article.content) : collapse(article.textContent ?? '');
    if (text.length < MIN_USEFUL_CHARS) return null;
    const out: { text: string; title?: string } = { text };
    if (article.title) out.title = article.title;
    return out;
  } catch {
    return null;
  }
}

function bodyFallback(html: string, url: string): string {
  const dom = makeDom(html, url);
  const body = dom.window.document.body;
  if (!body) return '';
  for (const el of Array.from(body.querySelectorAll(NOISE_TAGS.join(',')))) el.remove();
  return nodeToText(body);
}

/**
 * Report landing pages are not article-shaped, so the order is Defuddle, then
 * Readability, then a plain "strip scripts/nav/footer" body fallback. Tables
 * are always extracted from the raw DOM and any table text the main extractor
 * dropped is appended, so figures in tables survive. Deterministic for a given
 * input; performs no network access.
 */
export async function extractContent(html: string, url: string): Promise<ExtractedContent> {
  const dom = makeDom(html, url);
  const doc = dom.window.document;
  const tables = extractTables(doc);
  const canonicalUrl = resolveUrl(doc.querySelector('link[rel="canonical"]')?.getAttribute('href'), url);
  const publishedAt = findPublishedAt(doc);
  const pageTitle = findTitle(doc);

  let method: ExtractionMethod = 'defuddle';
  let main: { text: string; markdown?: string; title?: string } | null = await tryDefuddle(html, url);
  if (!main) {
    main = tryReadability(html, url);
    method = 'readability';
  }
  if (!main) {
    main = { text: bodyFallback(html, url) };
    method = 'fallback';
  }

  const result: ExtractedContent = {
    title: pageTitle || squash(main.title ?? ''),
    text: withTables(main.text, tables),
    tables,
    method,
  };
  if (main.markdown) result.markdown = main.markdown;
  if (canonicalUrl) result.canonicalUrl = canonicalUrl;
  if (publishedAt) result.publishedAt = publishedAt;
  return result;
}
