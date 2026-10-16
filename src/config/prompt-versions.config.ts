import type { PromptVersions } from '../schemas/index.js';

/**
 * Every generated draft records the prompt version that produced it. Bump the
 * relevant entry (and the global version) whenever prompt text changes, then
 * rerun the regression set.
 */
export const promptVersions: PromptVersions = {
  version: '2026.10.5',
  prompts: {
    'research-brief': 'research-brief.v5',
    outline: 'outline.v5',
    draft: 'draft.v6',
    'editorial-rewrite': 'editorial-rewrite.v6',
    'sanity-rewrite': 'sanity-rewrite.v6',
  },
};
