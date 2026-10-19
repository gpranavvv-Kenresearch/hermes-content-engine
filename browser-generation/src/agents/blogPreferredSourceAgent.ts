/**
 * blogPreferredSourceAgent.ts — inserts one Google Preferred Source CTA into
 * already-generated blog HTML, per the two "Preferred Source Placement"
 * skill specs (direct Google deeplink vs. tracked short-URL variants — same
 * placement/scoring/hook logic, only the destination URL differs).
 *
 * Runs after runBlogSanityChecks() and before validateBrandAuthority() in
 * blogGenLoop.ts — deterministic html -> html transform, no LLM call, same
 * convention as blogSanityAgent.ts / blogBrandValidator.ts. Because this
 * writes into the ONE shared Blog Content cell every off-page platform
 * poster (LinkedIn Pulse, Medium, HackMD, Google Sites, guest-posts...)
 * reads from, one insertion point here covers all of them.
 */
import * as cheerio from 'cheerio';

export type PreferredSourceMode = 'direct' | 'tracked';

export interface PreferredSourceOptions {
  mode: PreferredSourceMode;
  title?: string;
}

export interface PreferredSourceResult {
  html: string;
  applied: boolean;
  placement: string; // which candidate won, or 'existing-kept' / 'existing-url-swapped' / 'skipped-no-valid-placement'
}

const DIRECT_URL = 'https://www.google.com/preferences/source?q=kenresearch.com';
const TRACKED_URL = 'https://www.encurtador.dev/redirecionamento/acesse.one/xar1pvr';

function urlFor(mode: PreferredSourceMode): string {
  return mode === 'tracked' ? TRACKED_URL : DIRECT_URL;
}

// ── Heading/section keyword detection ───────────────────────────────────────

const DECISION_HEADING_RE = /decision framework|signals to monitor|what decision-makers should watch|strategic implications|market outlook|executive implications|what leaders should monitor|investment.*decision framework|market decision framework/i;
const FAQ_HEADING_RE = /frequently asked questions|^faqs?$|market faqs|key questions answered/i;
const METHODOLOGY_HEADING_RE = /methodology|^sources$|^disclaimer$/i;
const COMMERCIAL_CTA_RE = /talk to us|book a discovery call|speak with an analyst|discuss the research|contact ken research|request custom research|explore the full report|view (the )?full report|request a?\s?sample|download.*report|purchase.*report/i;

// Any prior Preferred Source CTA this skill (or a hand-written one) may have
// left behind — used for the duplication check.
const EXISTING_CTA_RE = /preferred source/i;

// ── CONTEXT extraction from title ───────────────────────────────────────────
// Best-effort heuristic, not a strict parser — the skill docs' own examples
// aren't fully rule-derivable (some drop "market", some keep it). Good
// enough for a natural-sounding hook; revisit if real output looks off.

const KNOWN_GEOS = [
  'india', 'united states', 'us', 'usa', 'uk', 'united kingdom', 'china', 'japan',
  'germany', 'france', 'italy', 'spain', 'brazil', 'canada', 'australia', 'mexico',
  'south korea', 'saudi arabia', 'uae', 'vietnam', 'indonesia', 'thailand', 'singapore',
  'south africa', 'nigeria', 'egypt', 'russia', 'turkey', 'poland', 'netherlands',
  'global', 'europe', 'asia pacific', 'middle east', 'africa', 'north america', 'latin america',
];

// Adjectival/regional terms that read as broken English with a possessive
// apostrophe-s ("Global's market") — use "the {geo} market" instead.
const NON_POSSESSIVE_GEOS = ['global'];

// Lowercase every word except short all-caps acronyms (AI, B2B, IoT-style
// ALLCAPS tokens up to 4 chars) — "AI Video Analytics" should read as "AI
// video analytics", not "ai video analytics".
const lowerPreservingAcronyms = (phrase: string) =>
  phrase.split(' ').map(w => (/^[A-Z0-9]{2,4}$/.test(w) ? w : w.toLowerCase())).join(' ');

function extractContext(title: string): string {
  let t = (title || '').trim().replace(/\s+/g, ' ');
  if (!t) return 'this market';

  // Blog article titles use the mandatory two-clause H1 format from
  // blogGenAgent.ts: "{Geo} {Market} Market Nears/Hits USD {Value} : Ken
  // Research Tracks/Flags {insight}". Strip clause 2 (everything from " : "
  // onward) FIRST — it must never leak into the hook — then strip only the
  // "Nears/Hits USD {Value}" part of clause 1, KEEPING the word "Market" so
  // the hook still reads "...market" like the skill docs' own examples.
  const colonIdx = t.indexOf(' : ');
  if (colonIdx !== -1) t = t.slice(0, colonIdx).trim();
  t = t.replace(/\s+(nears|hits)\s+usd\s+[\d.,]+\s*[bm]\b.*$/i, '').trim();
  if (!t) return 'this market';

  // Drop trailing generic modifiers that make the hook too long.
  t = t.replace(/\s*(advisory preference study|preference study|market report|industry report)\s*$/i, '');

  const words = t.split(' ');
  const firstWord = words[0]?.toLowerCase();
  const firstTwo = words.slice(0, 2).join(' ').toLowerCase();

  const geoMatch = KNOWN_GEOS.includes(firstTwo) ? firstTwo : (KNOWN_GEOS.includes(firstWord) ? firstWord : null);

  // Cap to the 6 words closest to the core entity in EITHER branch — the
  // earlier version only capped the no-geo branch, letting a long geo-led
  // title through unbounded.
  if (geoMatch) {
    const geoWordCount = geoMatch.split(' ').length;
    const geoDisplay = words.slice(0, geoWordCount).join(' ');
    const rest = words.slice(geoWordCount, geoWordCount + 6).join(' ').trim();
    const restLower = lowerPreservingAcronyms(rest);
    // "Global" (and similar adjectival/regional terms, not place names) reads
    // as broken English with a possessive -- "Global's X market" -- use
    // "the global X market" instead of "{Geo}'s X market".
    if (NON_POSSESSIVE_GEOS.includes(geoMatch)) {
      return `the ${geoMatch} ${restLower}`.trim();
    }
    return `${geoDisplay}'s ${restLower}`.trim();
  }

  // No geo prefix — lowercase the phrase (preserving acronyms), keep a
  // trailing "market"/"industry" as-is (matches most of the skill docs'
  // own examples: "Medical Accelerator Market" -> "medical accelerator
  // market", "India Electric Truck Market" -> "...electric truck market").
  const capped = t.split(' ').slice(-6).join(' ');
  return lowerPreservingAcronyms(capped);
}

// ── CTA template ─────────────────────────────────────────────────────────

function buildCtaHtml(context: string, mode: PreferredSourceMode): string {
  const url = urlFor(mode);
  return `<p><strong>Don’t miss the next ${context} shift.</strong> Ken Research continuously publishes new market intelligence, forecasts and industry analysis. <a href="${url}"><strong>Add Ken Research as a Preferred Source on Google</strong></a> to discover more of our research when your next market question comes up.</p>`;
}

// ── Candidate scoring ────────────────────────────────────────────────────

interface Candidate {
  index: number;   // position among top-level body children to insert BEFORE
  score: number;
  label: string;
}

function headingText($: cheerio.CheerioAPI, el: any): string {
  return $(el).text().trim();
}

// ChatGPT sometimes wraps the whole article body in a single top-level
// <article>/<div>/<section> instead of flat top-level tags. Every heuristic
// below only looks at TOP-LEVEL body children, so a single wrapper collapses
// the entire article into one "child" — Priority 2 then matches the
// commercial-CTA phrase buried deep inside that wrapper's text and inserts
// the Preferred Source CTA BEFORE the whole wrapper, landing it between the
// cover image and the H1 instead of near the article's actual end. Unwrap
// any such single generic container (one that itself contains an h1/h2) so
// the scoring below sees the real flat structure.
function unwrapGenericWrappers($: cheerio.CheerioAPI, body: cheerio.Cheerio<any>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const el of body.children().toArray()) {
      const tag = (el as any).tagName?.toLowerCase();
      if ((tag === 'article' || tag === 'div' || tag === 'section') && $(el).find('h1, h2').length > 0) {
        $(el).replaceWith($(el).contents());
        changed = true;
      }
    }
  }
}

export function applyPreferredSourceCTA(html: string, opts: PreferredSourceOptions): PreferredSourceResult {
  const mode = opts.mode;
  const context = extractContext(opts.title || '');

  const $ = cheerio.load(html);
  const body = $('body');
  unwrapGenericWrappers($, body);

  // Duplication handling: remove any existing Preferred Source CTA paragraph
  // (matched by URL or "Preferred Source" text) so we always re-place it
  // fresh at the current best position with the correct URL for this mode —
  // simpler and more robust than trying to judge "is the existing placement
  // good enough" and patch it in place.
  let hadExisting = false;
  body.children().each((_, el) => {
    const $el = $(el);
    const elHtml = $.html(el);
    if (EXISTING_CTA_RE.test($el.text()) || elHtml.includes(DIRECT_URL) || elHtml.includes(TRACKED_URL)) {
      hadExisting = true;
      $el.remove();
    }
  });

  const children = body.children().toArray();
  if (children.length === 0) {
    // No top-level structure to anchor against — bail out safely rather than
    // guessing at a raw string insertion into unknown markup.
    return { html: $.html(body).replace(/^<body>|<\/body>$/g, ''), applied: false, placement: 'skipped-no-structure' };
  }

  // Cumulative text-length depth per child, for the 40%/65-85% modifiers.
  const lengths = children.map((el) => $(el).text().length);
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  const cumulative: number[] = [];
  let running = 0;
  for (const len of lengths) {
    running += len;
    cumulative.push(running);
  }
  const depthAt = (i: number) => cumulative[i] / total; // depth AFTER child i

  function depthModifier(insertAfterIndex: number): number {
    const depth = insertAfterIndex >= 0 ? depthAt(insertAfterIndex) : 0;
    if (depth < 0.40) return -5;
    if (depth >= 0.65 && depth <= 0.85) return 3;
    return 1; // acceptable but unremarkable depth
  }

  function isForbiddenZone(insertBeforeIndex: number): boolean {
    // Walk backward from the insertion point to the nearest heading — if
    // that heading is FAQ/Methodology and we're not landing exactly AT its
    // start (i.e. we're past it), this position is inside a forbidden section.
    for (let i = insertBeforeIndex - 1; i >= 0; i--) {
      const el = children[i];
      const tag = (el as any).tagName?.toLowerCase();
      if (tag === 'h2' || tag === 'h3') {
        const text = headingText($, el);
        return FAQ_HEADING_RE.test(text) || METHODOLOGY_HEADING_RE.test(text);
      }
    }
    return false;
  }

  const candidates: Candidate[] = [];

  // Priority 1 — after the last element of a Decision Framework / Signals
  // to Monitor section (i.e. right before the next h2/h3, or end of doc).
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    const tag = (el as any).tagName?.toLowerCase();
    if ((tag === 'h2' || tag === 'h3') && DECISION_HEADING_RE.test(headingText($, el))) {
      let end = children.length;
      for (let j = i + 1; j < children.length; j++) {
        const t2 = (children[j] as any).tagName?.toLowerCase();
        if (t2 === 'h2' || t2 === 'h3') { end = j; break; }
      }
      candidates.push({ index: end, score: 6 + depthModifier(end - 1), label: 'after-decision-framework' });
    }
  }

  // Priority 2 — right before a paragraph/heading containing a late
  // commercial CTA phrase.
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    if (COMMERCIAL_CTA_RE.test($(el).text())) {
      candidates.push({ index: i, score: 5 + depthModifier(i - 1), label: 'before-commercial-cta' });
      break; // only the first one — later ones are usually repeats/footer links
    }
  }

  // Priority 3 — right before FAQ heading.
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    const tag = (el as any).tagName?.toLowerCase();
    if ((tag === 'h2' || tag === 'h3') && FAQ_HEADING_RE.test(headingText($, el))) {
      candidates.push({ index: i, score: 4 + depthModifier(i - 1), label: 'before-faq' });
      break;
    }
  }

  // Priority 4 — right before Methodology/Sources/Disclaimer heading.
  for (let i = 0; i < children.length; i++) {
    const el = children[i];
    const tag = (el as any).tagName?.toLowerCase();
    if ((tag === 'h2' || tag === 'h3') && METHODOLOGY_HEADING_RE.test(headingText($, el))) {
      candidates.push({ index: i, score: 3.5 + depthModifier(i - 1), label: 'before-methodology' });
      break;
    }
  }

  // Priority 5 — late-article fallback: the top-level boundary closest to
  // 75% depth, after a substantive block (paragraph/list), never inside a
  // heading's immediate first child.
  {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 1; i < children.length; i++) {
      const tag = (children[i - 1] as any).tagName?.toLowerCase();
      if (tag !== 'p' && tag !== 'ul' && tag !== 'ol') continue; // insert only after substantive content
      const dist = Math.abs(depthAt(i - 1) - 0.75);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    if (bestIdx >= 0) {
      candidates.push({ index: bestIdx, score: 2 + depthModifier(bestIdx - 1), label: 'late-fallback' });
    }
  }

  // Filter forbidden zones, apply adjacency penalty, then pick the winner.
  const valid = candidates
    .filter(c => c.index >= 0 && c.index <= children.length && !isForbiddenZone(c.index))
    .map(c => {
      const neighborBefore = c.index > 0 ? $(children[c.index - 1]).text() : '';
      const neighborAfter = c.index < children.length ? $(children[c.index]).text() : '';
      const adjacent = COMMERCIAL_CTA_RE.test(neighborBefore) || COMMERCIAL_CTA_RE.test(neighborAfter);
      return { ...c, score: c.score + (adjacent ? -1 : 0) };
    });

  if (valid.length === 0) {
    const outHtml = ($.html(body).match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? $.html(body)).trim();
    return { html: outHtml, applied: false, placement: 'skipped-no-valid-placement' };
  }

  valid.sort((a, b) => (b.score - a.score) || (b.index - a.index)); // highest score, later index on tie
  const winner = valid[0];

  const ctaHtml = buildCtaHtml(context, mode);
  if (winner.index >= children.length) {
    body.append(ctaHtml);
  } else {
    $(children[winner.index]).before(ctaHtml);
  }

  const outHtml = ($.html(body).match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? $.html(body)).trim();
  return { html: outHtml, applied: true, placement: hadExisting ? `repositioned:${winner.label}` : winner.label };
}

// ── Lightweight final-validator check ───────────────────────────────────
// Mirrors the skill docs' own validation checklist — cheap sanity pass
// before the result reaches validateBrandAuthority() / the sheet.

export interface PreferredSourceValidation {
  status: 'PASS' | 'ISSUE';
  issues: string[];
}

export function validatePreferredSourceCTA(html: string, mode: PreferredSourceMode): PreferredSourceValidation {
  const issues: string[] = [];
  const url = urlFor(mode);
  const $ = cheerio.load(html);
  const ctaLinks = $(`a[href="${url}"]`);

  if (ctaLinks.length === 0) issues.push('No Preferred Source CTA found with the expected URL.');
  if (ctaLinks.length > 1) issues.push(`Found ${ctaLinks.length} Preferred Source CTAs — expected exactly 1.`);

  // Wrong-mode URL leaked in (e.g. tracked mode but a direct link survived).
  const otherUrl = mode === 'tracked' ? DIRECT_URL : TRACKED_URL;
  if (html.includes(otherUrl)) issues.push(`Found the other mode's Preferred Source URL (${otherUrl}) still present.`);

  ctaLinks.each((_, el) => {
    const container = $(el).closest('p, li, td, blockquote');
    const containerTag = (container.get(0) as any)?.tagName?.toLowerCase();
    if (containerTag === 'blockquote' || containerTag === 'td') {
      issues.push('Preferred Source CTA lands inside a quote/table cell.');
    }
    // Positional check: not inside FAQ/Methodology (i.e. no such heading
    // appears between the document start and this element without an
    // intervening later heading resetting the section).
    let sectionText: string | null = null;
    let node = container.length ? container.get(0) : el;
    let prev = $(node).prevAll('h2, h3').first();
    if (prev.length) sectionText = prev.text();
    if (sectionText && (FAQ_HEADING_RE.test(sectionText) || METHODOLOGY_HEADING_RE.test(sectionText))) {
      issues.push(`Preferred Source CTA lands inside a "${sectionText.trim()}" section.`);
    }
  });

  return { status: issues.length === 0 ? 'PASS' : 'ISSUE', issues };
}
