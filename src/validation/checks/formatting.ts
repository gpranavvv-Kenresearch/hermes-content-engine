import type { ValidationIssue } from '../../schemas/index.js';
import { isRangeBold, type BoldView } from '../../utils/bold.js';
import { findFigures } from '../../utils/figures.js';
import { attributionBody } from '../text-stats.js';
import { issue, type CheckContext } from './context.js';

/**
 * Brand and bold rules. Unlike the other checks these need the bold flags, so
 * they take a BoldView (plain text + per-character bold) instead of a string.
 *
 *  - MISSING_BRAND_MENTION (every platform): the brand name must appear.
 *  - BRAND_NOT_BOLD / FIGURE_NOT_BOLD (bold platforms): every mention of the
 *    brand and every currency or percentage figure must be bold. Both are
 *    fixed deterministically (ENSURE_BOLD fixer), so they rarely need the model.
 *  - UNEXPECTED_BOLD (review): bold on anything that is neither the brand nor a figure.
 */

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Index ranges of URLs in plain text (figures and names inside links are not content). */
function urlRanges(plain: string): Array<[number, number]> {
  return [...plain.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

const inside = (ranges: Array<[number, number]>, s: number, e: number): boolean => ranges.some(([rs, re]) => s >= rs && e <= re);

export function checkBrandAndBold(view: BoldView, ctx: CheckContext): ValidationIssue[] {
  const { plain } = view;
  const brand = ctx.config.brand.name;
  const issues: ValidationIssue[] = [];
  const urls = urlRanges(plain);

  const mentions = [...plain.matchAll(new RegExp(escapeRe(brand), 'gi'))]
    .map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
    .filter((m) => !inside(urls, m.start, m.end));

  if (mentions.length === 0 || !new RegExp(`\\b${escapeRe(brand)}\\b`, 'i').test(attributionBody(plain))) {
    issues.push(issue('MISSING_BRAND_MENTION', 'hard_fail', `Name "${brand}" in a substantive finding in the post body; a hashtag, URL or report-link label alone does not count. Attribute only its supplied findings to it.`));
  }
  if (mentions.length > 0 && ctx.limit.formatting.boldBrand) {
    const plainMentions = mentions.filter((m) => !isRangeBold(view, m.start, m.end));
    if (plainMentions.length > 0) {
      issues.push(
        issue('BRAND_NOT_BOLD', 'hard_fail', `${plainMentions.length} mention(s) of ${brand} are not bold. Write them as **${brand}**.`, {
          count: plainMentions.length,
        }),
      );
    }
  }

  const figures = findFigures(plain).filter((f) => !inside(urls, f.start, f.end));
  if (ctx.limit.formatting.boldFigures) {
    const plainFigures = figures.filter((f) => !isRangeBold(view, f.start, f.end));
    if (plainFigures.length > 0) {
      issues.push(
        issue(
          'FIGURE_NOT_BOLD',
          'hard_fail',
          `These figures are not bold: ${plainFigures.map((f) => `"${f.text}"`).join(', ')}. Wrap every currency amount and percentage in double asterisks.`,
          { figures: plainFigures.map((f) => f.text) },
        ),
      );
    }
  }

  if (!ctx.limit.formatting.selectiveBold && (ctx.limit.formatting.boldBrand || ctx.limit.formatting.boldFigures)) {
    // Runs of bold letters/digits (spaces and punctuation are neutral and never end a run)
    // that neither contain the brand nor overlap a figure.
    const covered = [...mentions, ...figures];
    const stray: string[] = [];
    const flush = (s: number, e: number): void => {
      if (covered.some((c) => s < c.end && e > c.start)) return;
      const run = plain.slice(s, e);
      stray.push(run.length > 40 ? `${run.slice(0, 37)}...` : run);
    };
    let start = -1;
    let lastAlnum = -1;
    for (let i = 0; i < plain.length; i++) {
      if (!/[A-Za-z0-9]/.test(plain[i]!)) continue;
      if (view.bold[i] === true) {
        if (start < 0) start = i;
        lastAlnum = i;
      } else if (start >= 0) {
        flush(start, lastAlnum + 1);
        start = -1;
      }
    }
    if (start >= 0) flush(start, lastAlnum + 1);
    if (stray.length > 0) {
      issues.push(issue('UNEXPECTED_BOLD', 'review', `Bold is reserved for ${brand} and figures; also bold: ${stray.map((s) => `"${s}"`).join(', ')}.`, { stray }));
    }
  }
  return issues;
}
