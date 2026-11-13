import type { BlogDecision } from './types.js';

export interface PatchableBlog { html: string; seoTitle: string; description: string }

export type PatchResult =
  | { ok: true; blog: PatchableBlog; applied: number }
  | { ok: false; error: string };

/**
 * Applies the supervisor's own corrections straight to the article. Every `find` must be copied exactly from the
 * article and occur exactly once, so a wrong or ambiguous edit is refused and the whole patch is dropped rather
 * than half applied. Nothing is written to a Sheet from here.
 */
export function applyPatch(blog: PatchableBlog, decision: Pick<BlogDecision, 'edits' | 'seoTitle' | 'metaDescription'>): PatchResult {
  const edits = decision.edits ?? [];
  if (edits.length === 0 && !decision.seoTitle && !decision.metaDescription) return { ok: false, error: 'the patch contains no edits' };
  let html = blog.html;
  for (const [i, e] of edits.entries()) {
    if (/<\s*script/i.test(e.replace)) return { ok: false, error: `edit ${i + 1} adds a script tag` };
    const first = html.indexOf(e.find);
    if (first < 0) return { ok: false, error: `edit ${i + 1}: the text to replace was not found in the article` };
    if (html.indexOf(e.find, first + e.find.length) >= 0) return { ok: false, error: `edit ${i + 1}: the text to replace occurs more than once` };
    html = html.slice(0, first) + e.replace + html.slice(first + e.find.length);
  }
  return {
    ok: true,
    applied: edits.length + (decision.seoTitle ? 1 : 0) + (decision.metaDescription ? 1 : 0),
    blog: { html, seoTitle: decision.seoTitle?.trim() || blog.seoTitle, description: decision.metaDescription?.trim() || blog.description },
  };
}
