/**
 * "free-v2" blog mode: the writer prompt (prompts/blog-generation/free/blog-free-v2.txt) decides structure, audience, tone,
 * H2 count and links. Code enforces only four things, deterministically, instead of sending the article back for fixes:
 *   1. no em dashes,
 *   2. no extra text around the three deliverable sections or the HTML (markdown, commentary, code fences),
 *   3. every "Ken Research" bold,
 *   4. every meaningful statistic bold.
 * UTM parameters on kenresearch.com links are added by the existing blog UTM step; links, H2 counts, middle images and the
 * preferred-source call to action are not checked or added in this mode.
 */
import type { BlogGenResult } from '../../src/agents/blogGenAgent.js';
import { injectCoverImage, PREFERRED_SOURCE_MODE } from '../../src/coordinator/blogGenLoop.js';
import { applyPreferredSourceCTA, validatePreferredSourceCTA } from '../../src/agents/blogPreferredSourceAgent.js';
import { normalizeImgTags } from '../../src/agents/blogSanityAgent.js';
import { enforceBrandAndFigureBold } from './bold.js';

export const FREE_STRUCTURE = 'free-v2';
export const isFreeStructure = (structure: string | undefined): boolean => structure === FREE_STRUCTURE;

const EM_DASH = /\s*[\u2014\u2015]\s*/g;
const stripMarkup = (s: string): string =>
  s.replace(/<[^>]+>/g, '').replace(/\*\*|__/g, '').replace(/^\s*#{1,6}\s+/gm, '').replace(/\s+/g, ' ').trim();

/** Keeps only the HTML: drops code fences, text before the first tag and commentary after the last tag. */
export function onlyHtml(html: string): string {
  let h = html.replace(/```(?:html)?/gi, '').trim();
  const first = h.indexOf('<');
  if (first > 0) h = h.slice(first);
  const last = h.lastIndexOf('>');
  if (last >= 0) h = h.slice(0, last + 1);
  return h.trim();
}

/**
 * Repairs malformed link quoting such as href=""https://x"", href=\"https://x\", href=&quot;https://x&quot; or curly quotes
 * to href="https://x". Only href values that start with a URL are touched.
 */
export function fixHrefQuotes(html: string): string {
  return html
    .replace(/\\/g, '') // visible backslashes are never valid in the article (escaped quotes, \| and \? from a Markdown-escaped copy)
    .replace(/&quot;/g, '"')
    .replace(/href\s*=\s*(?:\\?["“”‘’']+)\s*((?:https?:\/\/|mailto:|\/)[^\s"'<>\\“”‘’]*)\s*(?:\\?["“”‘’']+)/gi, 'href="$1"');
}

/** Removes a trailing "| Ken Research" (or "\| Ken Research") from the H1; the brand belongs inside the headline sentence. */
export function stripH1BrandSuffix(html: string): string {
  return html.replace(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/i, (_m, attrs: string, inner: string) =>
    `<h1${attrs}>${inner.replace(/\s*\\?\|\s*(?:<strong>\s*Ken Research\s*<\/strong>|Ken Research)\s*$/i, '').trim()}</h1>`);
}

export function normaliseFreeBlog(blog: BlogGenResult): BlogGenResult {
  const html = enforceBrandAndFigureBold(stripH1BrandSuffix(fixHrefQuotes(onlyHtml(blog.html).replace(EM_DASH, ', '))));
  const seoTitle = stripMarkup(blog.seoTitle).replace(EM_DASH, ', ');
  const description = stripMarkup(blog.description).replace(EM_DASH, ', ');
  const publishingTitle = blog.publishingTitle ? stripMarkup(blog.publishingTitle).replace(EM_DASH, ', ') : undefined;
  const title = publishingTitle ?? (blog.title ? stripMarkup(blog.title).replace(EM_DASH, ', ') : blog.title);
  return { ...blog, html, seoTitle, description, title, ...(publishingTitle ? { publishingTitle } : {}) };
}

export interface FreeSanity {
  emDashes: number;
  unboldedKen: number;
  markdownLeft: number;
  textOutsideTags: number;
  h1: number;
  /** href attributes that are not exactly href="..." (doubled, escaped, curly or missing quotes). */
  badHrefs: number;
  /** An H1 that still ends with "| Ken Research". */
  h1PipeBrand: number;
}

/** Counts what is still wrong after normaliseFreeBlog. Everything but h1 should be zero. */
export function freeSanity(html: string, seoTitle = '', description = ''): FreeSanity {
  const noStrong = html.replace(/<strong>\s*Ken Research\s*<\/strong>/gi, '');
  return {
    emDashes: (`${html} ${seoTitle} ${description}`.match(/[\u2014\u2015]/g) ?? []).length,
    unboldedKen: (noStrong.replace(/<[^>]+>/g, ' ').match(/Ken Research/g) ?? []).length,
    markdownLeft: (html.match(/\*\*|^\s{0,3}#{1,6}\s|```/gm) ?? []).length,
    textOutsideTags: html.replace(/<(p|h[1-6]|li|blockquote)\b[\s\S]*?<\/\1>/gi, '').replace(/<\/?(?:ul|ol|a|strong|img)\b[^>]*>/gi, '').replace(/\s+/g, '').length,
    h1: (html.match(/<h1[\s>]/gi) ?? []).length,
    badHrefs: (html.match(/<a\b[^>]*>/gi) ?? []).filter((tag) => !/^<a\b[^>]*\shref="[^"\s]+"(?:\s[^>]*)?>$/i.test(tag)).length,
    h1PipeBrand: /<h1\b[^>]*>[\s\S]*\\?\|\s*(?:<strong>\s*Ken Research\s*<\/strong>|Ken Research)\s*<\/h1>/i.test(html) ? 1 : 0,
  };
}

export function freeHardFails(blog: Pick<BlogGenResult, 'html' | 'seoTitle' | 'description'> & { publishingTitle?: string }): string[] {
  const s = freeSanity(blog.html, `${blog.publishingTitle ?? ''} ${blog.seoTitle}`, blog.description);
  const fails: string[] = [];
  if (s.h1 !== 1) fails.push(`the article has ${s.h1} H1 headings (needs exactly 1)`);
  if (s.emDashes > 0) fails.push(`${s.emDashes} em dash(es) remain`);
  if (s.unboldedKen > 0) fails.push(`${s.unboldedKen} "Ken Research" mention(s) are not bold`);
  if (s.markdownLeft > 0) fails.push('Markdown or code fences remain inside the HTML');
  if (s.textOutsideTags > 0) fails.push('extra text sits outside the HTML elements');
  if (s.badHrefs > 0) fails.push(`${s.badHrefs} link(s) have invalid href quoting (write href="https://..." with one pair of straight quotes)`);
  if (s.h1PipeBrand > 0) fails.push('the H1 ends with "| Ken Research"; put the brand inside the headline sentence instead');
  if (!/<\/(p|h1|h2)>/i.test(blog.html) || blog.html.replace(/<[^>]+>/g, '').trim().length < 300) fails.push('the article is missing or far too short');
  return fails;
}

const PREFERRED_SOURCE_URL = 'https://www.google.com/preferences/source?q=kenresearch.com';

/** Wraps the top-level paragraph that holds the preferred-source link in a blockquote (no-op when it already sits in one). */
export function wrapPreferredSourceInBlockquote(html: string): string {
  return html.replace(/(<blockquote\b[^>]*>\s*)?(<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?google\.com\/preferences\/source\?q=kenresearch\.com(?:(?!<\/p>)[\s\S])*?<\/p>)(\s*<\/blockquote>)?/i,
    (m, open: string | undefined, para: string, close: string | undefined) => (open && close ? m : `<blockquote>${para}</blockquote>`));
}

/**
 * Header image: drop the writer's placeholder, then put the generated cover (if any) above the H1. Then the Google preferred-source
 * call to action for Ken Research is added once (same agent and placement rules as the other blogs). No snapshot or landscape images.
 */
export function assembleFreeHtml(blog: BlogGenResult, title: string, coverImageUrl: string, note: (summary: string) => unknown = () => {}): string {
  let html = blog.html.replace(/<img\b[^>]*YOUR_[A-Z_0-9]*URL[A-Z_0-9]*[^>]*>\s*/gi, '');
  if (coverImageUrl) html = injectCoverImage(html, coverImageUrl);
  html = normalizeImgTags(html, { title: blog.title || title }).html;
  html = stripH1BrandSuffix(fixHrefQuotes(onlyHtml(html).replace(EM_DASH, ', ')));
  // The prompt asks the writer for the CTA inside a blockquote. Keep it when it is exactly one, in a blockquote and valid;
  // otherwise let the preferred-source agent place its own, and put that one in a blockquote as well.
  const writerBlock = html.split(PREFERRED_SOURCE_URL).length - 1 === 1
    && new RegExp(`<blockquote\\b[^>]*>(?:(?!</blockquote>)[\\s\\S])*?${PREFERRED_SOURCE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(html);
  if (writerBlock) {
    const keep = validatePreferredSourceCTA(html, PREFERRED_SOURCE_MODE);
    if (keep.status === 'PASS') {
      note('preferred-source CTA kept as written (blockquote)');
      return enforceBrandAndFigureBold(html);
    }
    note(`writer's preferred-source CTA replaced: ${keep.issues.join(' | ')}`);
  }
  const preferred = applyPreferredSourceCTA(html, { mode: PREFERRED_SOURCE_MODE, title: blog.title || title });
  const check = validatePreferredSourceCTA(preferred.html, PREFERRED_SOURCE_MODE);
  note(`preferred-source CTA ${preferred.applied ? `inserted (${preferred.placement})` : `skipped (${preferred.placement})`}${check.status === 'PASS' ? '' : `; ${check.issues.join(' | ')}`}`);
  return enforceBrandAndFigureBold(wrapPreferredSourceInBlockquote(preferred.html));
}
