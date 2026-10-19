/**
 * blogSanityAgent.ts — post-generation cleanup pass for blog HTML.
 * Runs after ChatGPT generation (and cover-image injection) but BEFORE the
 * result is written into the sheet. Each rule is a small, independent
 * html -> html transform, applied in order — add new rules to RULES to
 * extend this later without touching the call sites.
 */

export interface BlogSanityContext {
  /** Used to build the fallback img alt text ("<title> market research"). */
  title?: string;
}

export interface BlogSanityResult {
  html: string;
  changes: string[];
}

// ---------------------------------------------------------------------------
// Rule 1 — normalize every <img> tag to the exact canonical shape:
//   <img src='URL'>
// (single-quoted src, no alt attribute, not self-closing). No alt is emitted
// because any apostrophe in the title (e.g. "Thailand's") broke the old
// single-quoted alt='...' attribute early, corrupting the rest of the tag.
// Handles double-quoted/unquoted attrs and already-correct tags.
// ---------------------------------------------------------------------------
export function normalizeImgTags(html: string, ctx: BlogSanityContext): { html: string; changed: boolean } {
  let changed = false;

  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    // ChatGPT sometimes doubles the src quote on top of the real attribute
    // quotes — e.g. src=""https://...""  — which the quote-matching regex
    // below reads as an EMPTY quoted string (opening quote immediately
    // followed by another quote), producing src='' and leaving the broken
    // doubled-quote tag untouched instead of fixing it (confirmed live on a
    // published post). Collapse any run of 2+ quotes down to 1 BEFORE
    // extracting src, so this malformed shape gets read the same as a
    // normal double-quoted one.
    const collapsedTag = tag.replace(/="{2,}/g, '="').replace(/"{2,}(?=[\s>/])/g, '"');
    const srcMatch = collapsedTag.match(/\bsrc\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s>]+))/i);

    const src = (srcMatch?.[1] ?? srcMatch?.[2] ?? srcMatch?.[3] ?? '').trim();
    if (!src) return tag; // nothing to normalize against — leave untouched

    const rebuilt = `<img src='${src}'>`;
    if (rebuilt !== tag) changed = true;
    return rebuilt;
  });

  return { html: out, changed };
}

// ---------------------------------------------------------------------------
// Rule 2 — remove a byline paragraph attributing the article to Ken Research,
// wherever it lands (e.g. "By Ken Research", "Market analysis by Ken
// Research."). Matched against the WHOLE paragraph's stripped text, then the
// entire <p> is dropped — never a mid-sentence substring removal, which used
// to leave a broken fragment like "<p>Market analysis .</p>" behind when the
// byline text didn't exactly match "By Ken Research" verbatim.
// ---------------------------------------------------------------------------
const BYLINE_TEXT_RE = /^(?:by|market\s+analysis\s+by|research\s+by|analysis\s+by)\s+ken\s+research\.?$/i;

function removeByline(html: string): { html: string; changed: boolean } {
  let changed = false;
  const out = html.replace(/<p>([\s\S]*?)<\/p>\s*/gi, (whole, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    if (!BYLINE_TEXT_RE.test(text)) return whole;
    changed = true;
    return '';
  });
  return { html: out, changed };
}

// ---------------------------------------------------------------------------
// Rule 3 — bold every numeric figure in the visible text (currency amounts,
// percentages, plain numbers, years), skipping text already inside <strong>
// and never touching HTML tags/attributes.
// ---------------------------------------------------------------------------
// The comma-grouped branch is tried first (e.g. "1,450"); the plain-digit
// fallback covers everything else, including bare 4+ digit years like
// "2025" that a \d{1,3}(,\d{3})* -only pattern would silently skip (no
// comma group present, and more than 3 digits in a row).
const NUMBER_RE = /(?<![\w'"=])(?:[$₹€£]\s?)?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)%?(?:\s(?:billion|million|trillion|bn|mn))?(?!\w)/gi;

function boldAllNumbers(html: string): { html: string; changed: boolean } {
  let changed = false;
  const parts = html.split(/(<[^>]+>)/); // alternates: text, tag, text, tag, ...
  let strongDepth = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isTag = i % 2 === 1;

    if (isTag) {
      if (/^<strong[\s>]/i.test(part)) strongDepth++;
      else if (/^<\/strong>/i.test(part)) strongDepth = Math.max(0, strongDepth - 1);
      continue;
    }

    if (strongDepth > 0 || !part) continue;

    const boldedText = part.replace(NUMBER_RE, (match) => {
      changed = true;
      return `<strong>${match}</strong>`;
    });
    parts[i] = boldedText;
  }

  return { html: parts.join(''), changed };
}

// ---------------------------------------------------------------------------
// Rule 4 — strip the standard Disclaimer paragraph entirely. We add our own
// disclaimer/compliance footer downstream if a platform requires one; the
// model should not be appending its own.
// ---------------------------------------------------------------------------
function removeDisclaimer(html: string): { html: string; changed: boolean } {
  let changed = false;
  // The inner (?!<\/p>) guards stop the match from crossing into the NEXT
  // paragraph — without them, a non-greedy match starting at an earlier <p>
  // will happily swallow every paragraph up through the disclaimer's </p>.
  const out = html.replace(/<p>(?:(?!<\/p>)[\s\S])*?Disclaimer:(?:(?!<\/p>)[\s\S])*?<\/p>\s*/gi, () => {
    changed = true;
    return '';
  });
  return { html: out, changed };
}

type Rule = { name: string; run: (html: string, ctx: BlogSanityContext) => { html: string; changed: boolean } };

const RULES: Rule[] = [
  { name: 'normalize img tags', run: normalizeImgTags },
  { name: 'remove "By Ken Research" byline', run: removeByline },
  { name: 'bold every number', run: boldAllNumbers },
  { name: 'remove Disclaimer paragraph', run: removeDisclaimer },
  // Add future rules here — each one gets its own named entry in `changes`.
];

/** Runs every rule in order and returns the cleaned HTML plus a log of what actually changed. */
export function runBlogSanityChecks(html: string, ctx: BlogSanityContext = {}): BlogSanityResult {
  let current = html;
  const changes: string[] = [];

  for (const rule of RULES) {
    const result = rule.run(current, ctx);
    current = result.html;
    if (result.changed) changes.push(rule.name);
  }

  return { html: current, changes };
}
