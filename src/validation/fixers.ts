import type { LoadedConfig } from '../config/index.js';
import type { PlatformId } from '../schemas/index.js';
import { fromUnicodeBold, limitSelectiveBold, stripMarkdownBold } from '../utils/bold.js';
import { FIGURE_PATTERN, findFigures } from '../utils/figures.js';
import { applyUtmToText } from '../utils/utm.js';
import { BANNED_EMOJI_RE } from './checks/hard-fail.js';
import { brandHashtag } from './checks/layout.js';

/**
 * Deterministic auto-fixes, applied BEFORE any LLM rewrite. Each fixer is a
 * pure, idempotent function (fix(fix(x)) === fix(x)) and reports whether it
 * changed anything, so the attempt history can record exactly what was done.
 */

export interface FixerContext {
  platform: PlatformId;
  config: LoadedConfig;
}

export interface Fixer {
  id: string;
  fix(text: string, ctx: FixerContext): string;
}

export interface AppliedFix {
  id: string;
  /** Characters of difference is not meaningful; this just records that the text changed. */
  changed: true;
}

export interface FixResult {
  text: string;
  applied: AppliedFix[];
}

const URL_SPLIT_RE = /(https?:\/\/[^\s<>"')\]]+)/gi;

/** Applies `fn` to the non-URL stretches of the text only. */
function outsideUrls(text: string, fn: (s: string) => string): string {
  return text
    .split(URL_SPLIT_RE)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('');
}

const DASH_REPLACEMENTS: Array<[RegExp, string]> = [
  // En dash / figure dash / minus-like range dashes become a plain hyphen: "2025-2030".
  [/[‐-–−]/g, '-'],
  // Em dash and horizontal bar become a spaced hyphen, whatever spacing they had.
  [/\s*[—―]\s*/g, ' - '],
];

export const replaceDashesFixer: Fixer = {
  id: 'REPLACE_DASHES',
  fix(text, ctx) {
    const banned = ctx.config.brand.bannedCharacters;
    const targets = DASH_REPLACEMENTS.filter(([re]) => banned.some((c) => new RegExp(re.source).test(c)));
    if (targets.length === 0) return text;
    return outsideUrls(text, (s) => targets.reduce((acc, [re, rep]) => acc.replace(re, rep), s));
  },
};

export const stripEmojiFixer: Fixer = {
  id: 'STRIP_EMOJI',
  fix(text) {
    return outsideUrls(text, (s) => s.replace(BANNED_EMOJI_RE, ''));
  },
};

export const normalizeUtmFixer: Fixer = {
  id: 'NORMALIZE_UTM',
  fix(text, ctx) {
    const entry = ctx.config.utm[ctx.platform];
    if (!entry) return text;
    return applyUtmToText(text, entry, ctx.config.sourcePolicy.kenResearchHosts);
  },
};

export const normalizeWhitespaceFixer: Fixer = {
  id: 'NORMALIZE_WHITESPACE',
  fix(text) {
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/[     ]/g, ' ')
      .replace(/[​‌‍﻿]/g, '')
      .replace(/[ \t]+$/gm, '') // trailing spaces
      .replace(/(\S)[ \t]{2,}(?=\S)/g, '$1 ') // runs of inner spaces (leading indentation untouched)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  },
};

const BOLD_SPAN_SPLIT_RE = /(\*\*[^*]+?\*\*)/g;

/** Applies `fn` to the parts of a text that are neither URLs nor already inside a **bold** span. */
function outsideUrlsAndBold(text: string, fn: (s: string) => string): string {
  return outsideUrls(text, (chunk) =>
    chunk
      .split(BOLD_SPAN_SPLIT_RE)
      .map((part, i) => (i % 2 === 1 ? part : fn(part)))
      .join(''),
  );
}

/**
 * Bold platforms (Facebook, LinkedIn): wraps the brand name and every currency /
 * percentage figure in **double asterisks** when the model forgot to. Already
 * bold text is left alone, so running it twice changes nothing. Links are never touched.
 */
export const ensureBoldFixer: Fixer = {
  id: 'ENSURE_BOLD',
  fix(text, ctx) {
    const f = ctx.config.platformLimits[ctx.platform].formatting;
    if (!f.boldBrand && !f.boldFigures) return text;
    const brandRe = new RegExp(ctx.config.brand.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return outsideUrlsAndBold(text, (s) => {
      // Figures first, then the brand; the two never overlap in practice.
      let out = s;
      if (f.boldFigures) out = out.replace(new RegExp(FIGURE_PATTERN, 'gi'), (m) => `**${m}**`);
      if (f.boldBrand) out = out.replace(brandRe, (m) => `**${m}**`);
      return out;
    });
  },
};

/**
 * Bold platforms: bold is reserved for the brand name and figures (the reference post bolds nothing
 * else). A **span** that contains neither the brand nor a figure loses its markers.
 */
export const stripExtraBoldFixer: Fixer = {
  id: 'STRIP_EXTRA_BOLD',
  fix(text, ctx) {
    const f = ctx.config.platformLimits[ctx.platform].formatting;
    if (f.selectiveBold) return limitSelectiveBold(text, f.boldBrand ? ctx.config.brand.name : undefined);
    if (!f.boldBrand && !f.boldFigures) return text;
    const brandRe = new RegExp(ctx.config.brand.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return text.replace(/\*\*([^*]+?)\*\*/g, (whole, inner: string) => (brandRe.test(inner) || findFigures(inner).length > 0 ? whole : inner));
  },
};

/** Plain-text platforms (X, Instagram, Tumblr, Mastodon, blog): markdown asterisks would show up literally, so they are removed. */
export const stripBoldFixer: Fixer = {
  id: 'STRIP_BOLD',
  fix(text, ctx) {
    const f = ctx.config.platformLimits[ctx.platform].formatting;
    if (f.boldBrand || f.boldFigures || f.selectiveBold) return text;
    return fromUnicodeBold(stripMarkdownBold(text));
  },
};

const HASHTAG_LINE_RE = /^(?:\s*#[\p{L}\p{N}_]+)+\s*$/u;

/**
 * Layout platforms: the hashtag line must start with the brand hashtag (#KenResearch).
 * Adds it to the existing last hashtag line (dropping the last tag if the platform maximum
 * would be exceeded). If the post has no hashtag line there is nothing to extend, and the
 * review flag MISSING_BRAND_HASHTAG is left for the rewrite loop.
 */
export const ensureBrandHashtagFixer: Fixer = {
  id: 'ENSURE_BRAND_HASHTAG',
  fix(text, ctx) {
    const limit = ctx.config.platformLimits[ctx.platform];
    if (limit.formatting.layout !== 'numbered_points') return text;
    const tag = brandHashtag(ctx.config.brand.name);
    if (new RegExp(`${tag}\\b`, 'i').test(text)) return text;
    const lines = text.split('\n');
    let idx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (line === '' || line === '⠀') continue;
      if (HASHTAG_LINE_RE.test(line)) idx = i;
      break;
    }
    if (idx < 0) return text;
    let tags = lines[idx]!.trim().split(/\s+/);
    if (tags.length >= limit.hashtags.max) tags = tags.slice(0, Math.max(0, limit.hashtags.max - 1));
    lines[idx] = [tag, ...tags].join(' ');
    return lines.join('\n');
  },
};

/** Order matters only for tidiness: whitespace goes last so earlier edits cannot leave stray spaces. */
export const DEFAULT_FIXERS: readonly Fixer[] = [
  replaceDashesFixer,
  stripEmojiFixer,
  normalizeUtmFixer,
  stripBoldFixer,
  stripExtraBoldFixer,
  ensureBoldFixer,
  ensureBrandHashtagFixer,
  normalizeWhitespaceFixer,
];

export function applyFixers(text: string, ctx: FixerContext, fixers: readonly Fixer[] = DEFAULT_FIXERS): FixResult {
  let current = text;
  const applied: AppliedFix[] = [];
  for (const fixer of fixers) {
    const next = fixer.fix(current, ctx);
    if (next !== current) {
      applied.push({ id: fixer.id, changed: true });
      current = next;
    }
  }
  return { text: current, applied };
}
