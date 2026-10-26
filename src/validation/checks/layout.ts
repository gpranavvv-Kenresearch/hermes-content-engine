import type { ValidationIssue } from '../../schemas/index.js';
import { layoutById } from '../../strategy/layouts.js';
import { issue, type CheckContext } from './context.js';

/** Enforce the selected format's list bounds and single discussion ending.
 * Explicit legacy layouts retain their historical review rules. Runs on plain text.
 */

const LIST_ITEM_RE = /^\s*(?:\d{1,2}[.)]|[••\-*])\s+\S/;
const HASHTAG_ONLY_RE = /^(?:\s*#[\p{L}\p{N}_]+)+\s*$/u;
const URL_ONLY_RE = /^\s*https?:\/\/\S+\s*$/;
// Mask URL tokens wherever they occur, including "Report: https://...?utm_...".
// Retain offsets so question placement can still be compared with the link.
const URL_TOKEN_RE = /https?:\/\/[^\s<>]+/gi;

const MIN_POINTS = 3;
const MAX_POINTS = 7;

export function brandHashtag(brandName: string): string {
  return `#${brandName.replace(/\s+/g, '')}`;
}

export function checkLayout(plain: string, ctx: CheckContext): ValidationIssue[] {
  if (ctx.limit.formatting.layout !== 'numbered_points') return [];
  const layout = layoutById(ctx.layout, ctx.platform);
  const issues: ValidationIssue[] = [];
  const lines = plain.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  const points = lines.filter((l) => LIST_ITEM_RE.test(l));
  const minimum = layout.minItems ?? MIN_POINTS;
  const maximum = layout.maxItems ?? MAX_POINTS;
  if (points.length < minimum) {
    issues.push(
      issue(
        'MISSING_LIST_STRUCTURE',
        'hard_fail',
        layout.minItems !== undefined
          ? `The ${layout.label} format needs ${minimum} distinct bullets; found ${points.length}.`
          : layout.id === 'numbered-points'
          ? `The post needs ${MIN_POINTS} to 6 numbered points ("1.", "2.", "3.", each in its own paragraph); found ${points.length}.`
          : `The post needs ${MIN_POINTS} to 6 bullets (each in its own paragraph, starting with "- "); found ${points.length}.`,
        { found: points.length },
      ),
    );
  } else if (points.length > maximum) {
    issues.push(issue('LIST_TOO_LONG', layout.maxItems !== undefined ? 'hard_fail' : 'review', `The ${layout.label} format permits at most ${maximum} list items; found ${points.length}.`, { found: points.length }));
  }

  if (layout.requires) {
    const missing = layout.requires.filter((marker, i) => (i === 0 ? !lines[0]?.startsWith(marker) : !lines.some((l) => l.startsWith(marker))));
    if (missing.length > 0) {
      issues.push(
        issue('MISSING_LIST_STRUCTURE', 'hard_fail', `The "${layout.label}" layout needs paragraphs that start with ${layout.requires.map((m) => `"${m}"`).join(' and ')} (missing: ${missing.join(', ')}).`, { missing }),
      );
    }
  }

  const first = lines[0];
  if (layout.singleDiscussion) {
    const body = lines.join('\n');
    const prose = lines.map((line) => HASHTAG_ONLY_RE.test(line) ? ' '.repeat(line.length) : line).join('\n')
      .replace(URL_TOKEN_RE, (url) => ' '.repeat(url.length));
    // The opening hook may be one question; it does not count as the discussion question.
    const hookQuestions = first ? Math.min(1, first.match(/\?/g)?.length ?? 0) : 0;
    const questions = (prose.match(/\?/g)?.length ?? 0) - hookQuestions;
    if (questions !== 1) issues.push(issue('DISCUSSION_QUESTION_COUNT', 'hard_fail', `Use exactly one discussion question after the report link (the opening hook may also be one question); found ${questions} besides the hook.`));
    if (first && first.split(/\s+/).length > 25) issues.push(issue('HOOK_TOO_LONG', 'hard_fail', 'Keep the first paragraph to at most 25 words; move market figures and context into the next paragraph.'));
    const link = body.match(/https?:\/\/[^\s<>]+/i);
    const linkEnd = link ? link.index! + link[0].length : -1;
    if (questions === 1 && (linkEnd < 0 || prose.lastIndexOf('?') < linkEnd)) issues.push(issue('DISCUSSION_QUESTION_POSITION', 'hard_fail', 'Place the single discussion question after the report link.'));
  }
  if (layout.hookIsQuestion && first !== undefined && !LIST_ITEM_RE.test(first) && !first.endsWith('?')) {
    issues.push(issue('HOOK_NOT_QUESTION', 'review', 'The first paragraph should be a hook written as a question.'));
  }

  const prose = lines.filter((l) => !HASHTAG_ONLY_RE.test(l) && !URL_ONLY_RE.test(l));
  const last = prose[prose.length - 1];
  if (last !== undefined && !last.endsWith('?')) {
    issues.push(issue('MISSING_CLOSING_QUESTION', 'review', 'End the text (before the hashtags) with a short engagement question.'));
  }

  const tag = brandHashtag(ctx.config.brand.name);
  if (!new RegExp(`${tag}\\b`, 'i').test(plain)) {
    issues.push(issue('MISSING_BRAND_HASHTAG', 'review', `Start the hashtags with ${tag}.`));
  }
  return issues;
}
