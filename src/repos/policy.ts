import type { CompetitorDetector } from '../validation/competitors.js';

/**
 * Repo intake policy: what we are allowed to take from a repo someone gives us, and what we never take.
 * Everything here is deterministic. We take IDEAS (writing rules, structure, checks), never code or prose
 * copied from a repo, and never anything that conflicts with the source policy (verified Ken Research and
 * government facts only, no invented figures, quotes or sources, nothing paid).
 */

// --- license --------------------------------------------------------------------------

export type LicenseLevel = 'permissive' | 'copyleft' | 'unknown';

export interface LicenseVerdict {
  spdx: string | null;
  level: LicenseLevel;
  /** May a short technique line be copied verbatim into config? Only for permissive licenses. */
  verbatimOk: boolean;
  note: string;
}

const PERMISSIVE = new Set(['MIT', 'APACHE-2.0', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'ISC', 'CC0-1.0', 'UNLICENSE', '0BSD', 'CC-BY-4.0']);
const COPYLEFT = /^(A?GPL|LGPL|MPL|EPL|CC-BY-SA|CC-BY-NC)/i;

export function assessLicense(spdx: string | null | undefined): LicenseVerdict {
  const id = (spdx ?? '').trim();
  if (id === 'NOASSERTION') {
    return { spdx: 'NOASSERTION', level: 'unknown', verbatimOk: false, note: 'A custom license that GitHub does not recognise (often an open-source license with extra conditions on branding or hosting). Read its LICENSE file by hand; until then, ideas only, in your own words.' };
  }
  if (!id) {
    return { spdx: null, level: 'unknown', verbatimOk: false, note: 'No license found: all rights reserved. Read for ideas only and put every technique in your own words.' };
  }
  if (PERMISSIVE.has(id.toUpperCase())) {
    return { spdx: id, level: 'permissive', verbatimOk: true, note: `${id}: short rule lines may be kept with credit.` };
  }
  if (COPYLEFT.test(id)) {
    return { spdx: id, level: 'copyleft', verbatimOk: false, note: `${id}: copyleft. Ideas only, in your own words; never copy text or code.` };
  }
  return { spdx: id, level: 'unknown', verbatimOk: false, note: `${id}: unrecognised terms. Treat as ideas only, in your own words.` };
}

// --- risk scan ------------------------------------------------------------------------

export type RiskCode = 'FABRICATION' | 'KEYWORD_STUFFING' | 'PAID_SERVICE' | 'COMPETITOR_FIRM';

export interface Risk {
  code: RiskCode;
  message: string;
  /** A few matched snippets, so a person can judge. */
  examples: string[];
}

const FABRICATION_RE = /\b(fake|fabricat\w*|hypothetical|made[- ]up|invent(?:ed|ing)?|plausible[- ]sounding|even though (?:fake|artificial)|artificial (?:quotes|statistics))\b/i;
const STUFFING_RE = /keyword[- ]stuffing|stuff(?:ing)? (?:the )?keywords?|repeat (?:the )?(?:target )?keywords?/i;
const PAID_RE = /\b(dataforseo|semrush|ahrefs|moz pro|surfer ?seo|clearscope|jasper|copy\.ai|openai api key|anthropic api key|gemini api key|paid (?:api|plan|subscription))\b/i;

const SNIPPET = 90;

function snippets(text: string, re: RegExp, max = 3): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (m) {
      const start = Math.max(0, m.index - 30);
      out.push(line.slice(start, start + SNIPPET).trim());
      if (out.length >= max) break;
    }
  }
  return out;
}

export function scanRisks(text: string, detector?: CompetitorDetector): Risk[] {
  const risks: Risk[] = [];
  const fab = snippets(text, FABRICATION_RE);
  if (fab.length > 0) {
    risks.push({
      code: 'FABRICATION',
      message: 'Mentions fake, hypothetical or invented content. Our engine only states verified facts, so any technique that adds figures, quotes or sources must be adapted to use real ones.',
      examples: fab,
    });
  }
  const stuff = snippets(text, STUFFING_RE);
  if (stuff.length > 0) risks.push({ code: 'KEYWORD_STUFFING', message: 'Keyword stuffing lowered AI visibility in the GEO study; do not adopt it.', examples: stuff });
  const paid = snippets(text, PAID_RE);
  if (paid.length > 0) risks.push({ code: 'PAID_SERVICE', message: 'Depends on a paid service or API key. Everything here must stay free.', examples: paid });
  if (detector && detector.find(text).length > 0) {
    risks.push({ code: 'COMPETITOR_FIRM', message: 'Names a competitor research firm. We never cite or promote one; any technique that mentions it is dropped.', examples: [] });
  }
  return risks;
}

// --- relevance ------------------------------------------------------------------------

export type UseKind = 'post' | 'blog' | 'seo' | 'geo' | 'keywords';

const USE_PATTERNS: Record<UseKind, RegExp> = {
  post: /\b(linkedin|twitter|tweet|facebook|social (?:media )?post|thread|caption|hashtag)\b/gi,
  blog: /\b(blog|article|long[- ]form|headline|outline|draft|editorial)\b/gi,
  seo: /\b(seo|serp|backlink|search intent|meta description|ranking|on-page)\b/gi,
  geo: /\b(geo|generative engine|ai overview|ai search|llm citation|citab\w+|answer engine|perplexity)\b/gi,
  keywords: /\b(keyword|cluster\w*|topic cluster|long[- ]tail|search volume)\b/gi,
};

/** How often each use shows up, highest first. A guide to where a repo can help, not a verdict. */
export function classifyUse(text: string): Array<{ use: UseKind; hits: number }> {
  return (Object.keys(USE_PATTERNS) as UseKind[])
    .map((use) => ({ use, hits: (text.match(USE_PATTERNS[use]) ?? []).length }))
    .filter((r) => r.hits > 0)
    .sort((a, b) => b.hits - a.hits);
}

// --- candidate techniques -------------------------------------------------------------

export interface Candidate {
  n: number;
  text: string;
  /** Why it cannot be adopted (empty when it can). */
  blocked: string;
}

const RULE_VERB_RE = /\b(use|add|include|keep|avoid|never|always|ensure|limit|write|lead with|start with|front[- ]load|cite|name|open with|place|put|prefer|replace|vary|split)\b/i;

function clean(line: string): string {
  return line
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rule-like lines (imperative, 30 to 220 characters) from README and prompt files, minus code blocks and tables. */
export function extractCandidates(texts: readonly string[], detector?: CompetitorDetector, max = 30): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const text of texts) {
    let inCode = false;
    for (const raw of text.split('\n')) {
      if (/^\s*```/.test(raw)) {
        inCode = !inCode;
        continue;
      }
      if (inCode || /^\s*\|/.test(raw) || /^\s*#{1,6}\s/.test(raw)) continue;
      const line = clean(raw);
      if (line.length < 30 || line.length > 220 || /^https?:\/\//i.test(line) || !RULE_VERB_RE.test(line)) continue;
      const key = line.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);
      let blocked = '';
      if (FABRICATION_RE.test(line)) blocked = 'asks for fake, hypothetical or invented content';
      else if (STUFFING_RE.test(line)) blocked = 'keyword stuffing';
      else if (PAID_RE.test(line)) blocked = 'needs a paid service';
      else if (detector && detector.find(line).length > 0) blocked = 'names a competitor firm';
      out.push({ n: out.length + 1, text: line, blocked });
      if (out.length >= max) return out;
    }
  }
  return out;
}
