import type { PlatformLimits } from '../schemas/index.js';

/**
 * Single authoritative place for platform limits.
 *
 * FB/LI: 2,280 is the hard cap on the final serialized payload (the legacy code
 * documented 2,280 but actually enforced 3000; that mismatch is fixed here).
 * The generator is steered to 1000-1700, which leaves room
 * for the characters bold and spacer lines add. The cap is measured on the
 * FINAL text, after **bold** markdown became Unicode bold (those characters
 * take two UTF-16 units each, the stricter measure).
 *
 * formatting: the brand name is mandatory in every post (see MISSING_BRAND_MENTION).
 * Facebook and LinkedIn require bold brand mentions and permit one additional short emphasis
 * without automatically bolding every figure or year. X, Instagram, Tumblr and Mastodon
 * are plain text here: X counts non-Latin code points double, and none of them
 * render markdown. Change a platform's flags here to change the rule.
 *
 * Values marked "verify" were taken from legacy prompt targets, not from
 * current official platform documentation; confirm before relying on them as
 * hard caps.
 */
const PLAIN = { boldBrand: false, boldFigures: false, layout: 'free', blankLineChar: null } as const;
// Shared approved social formatting; the legacy enum name identifies the structured-format family.
const SOCIAL_TEXT = { boldBrand: true, boldFigures: false, selectiveBold: true, layout: 'numbered_points', blankLineChar: '⠀' } as const;

export const platformLimits: PlatformLimits = {
  x: {
    hardMaxChars: 280,
    targetMinChars: null,
    targetMaxChars: 256, // legacy: 230 chars of text + space + 23-char URL
    urlCountsAs: 23,
    hashtags: { min: 1, max: 4 },
    requireSourceLink: true,
    requireTitle: false,
    formatting: PLAIN,
  },
  facebook: {
    hardMaxChars: 2280,
    targetMinChars: 1000,
    targetMaxChars: 1700,
    urlCountsAs: null,
    hashtags: { min: 6, max: 10 },
    requireSourceLink: true,
    requireTitle: false,
    formatting: SOCIAL_TEXT,
  },
  linkedin: {
    hardMaxChars: 2280,
    targetMinChars: 1000,
    targetMaxChars: 1700,
    urlCountsAs: null,
    hashtags: { min: 3, max: 5 },
    requireSourceLink: true,
    requireTitle: false,
    formatting: SOCIAL_TEXT,
  },
  tumblr: {
    hardMaxChars: null, // verify: no hard cap confirmed
    targetMinChars: 600,
    targetMaxChars: 1000, // editorial target for a short source-backed market brief, not a platform cap
    urlCountsAs: null,
    hashtags: { min: 1, max: 5 },
    requireSourceLink: true,
    requireTitle: false,
    formatting: PLAIN,
  },
  instagram: {
    hardMaxChars: 2200, // verify
    targetMinChars: null,
    targetMaxChars: 230, // legacy prompt target
    urlCountsAs: null,
    hashtags: { min: 1, max: 10 },
    requireSourceLink: true,
    requireTitle: false,
    formatting: PLAIN,
  },
  mastodon: {
    hardMaxChars: 500, // verify: default instance limit
    targetMinChars: null,
    targetMaxChars: 400, // legacy prompt target
    urlCountsAs: 23,
    hashtags: { min: 1, max: 4 },
    requireSourceLink: true,
    requireTitle: false,
    formatting: PLAIN,
  },
  blog: {
    hardMaxChars: null,
    targetMinChars: null,
    targetMaxChars: null,
    urlCountsAs: null,
    hashtags: { min: 0, max: 0 },
    requireSourceLink: true,
    requireTitle: true,
    formatting: PLAIN,
  },
};
