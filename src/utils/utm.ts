import type { UtmEntry } from '../schemas/index.js';
import { normalizeHost } from './normalize.js';

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

export function isHostOrSubdomain(host: string, base: string): boolean {
  const h = normalizeHost(host);
  const b = normalizeHost(base);
  return h === b || h.endsWith(`.${b}`);
}

export function urlHost(url: string): string | null {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

export function isKenResearchUrl(url: string, kenHosts: readonly string[]): boolean {
  const host = urlHost(url);
  return host !== null && kenHosts.some((h) => isHostOrSubdomain(host, h));
}

/**
 * Deterministic UTM serializer. Removes EVERY existing utm_* parameter (any
 * case, any count), keeps all other parameters byte-for-byte in their original
 * order, then appends exactly one utm_source, utm_medium and utm_campaign in
 * that order. The fragment is preserved. Idempotent: applyUtm(applyUtm(u)) === applyUtm(u).
 * HTML-escaped "&amp;" separators are decoded to "&".
 */
export function applyUtm(url: string, utm: UtmEntry): string {
  let work = url.replace(/&amp;/gi, '&');
  let hash = '';
  const hashIdx = work.indexOf('#');
  if (hashIdx >= 0) {
    hash = work.slice(hashIdx);
    work = work.slice(0, hashIdx);
  }
  let query = '';
  const queryIdx = work.indexOf('?');
  if (queryIdx >= 0) {
    query = work.slice(queryIdx + 1);
    work = work.slice(0, queryIdx);
  }
  const kept = query.split('&').filter((p) => p.length > 0 && !p.toLowerCase().startsWith('utm_'));
  const params = [
    ...kept,
    `utm_source=${utm.source}`,
    `utm_medium=${utm.medium}`,
    `utm_campaign=${utm.campaign}`,
  ];
  return `${work}?${params.join('&')}${hash}`;
}

/** Applies the UTM to every Ken Research link in `text`; other links are left untouched. */
export function applyUtmToText(text: string, utm: UtmEntry, kenHosts: readonly string[]): string {
  return text.replace(URL_RE, (match) => {
    const trailing = match.match(TRAILING_PUNCT_RE)?.[0] ?? '';
    const url = trailing ? match.slice(0, -trailing.length) : match;
    if (!isKenResearchUrl(url, kenHosts)) return match;
    return applyUtm(url, utm) + trailing;
  });
}

export type UtmProblemKind = 'missing_utm' | 'duplicate_utm' | 'wrong_utm';

export interface UtmProblem {
  url: string;
  kind: UtmProblemKind;
}

function utmParams(url: string): string[] {
  const noHash = url.split('#')[0] ?? '';
  const qIdx = noHash.indexOf('?');
  if (qIdx < 0) return [];
  return noHash
    .slice(qIdx + 1)
    .replace(/&amp;/gi, '&')
    .split('&')
    .filter((p) => p.toLowerCase().startsWith('utm_'));
}

/**
 * Inspects every Ken Research link in `text` and reports links whose UTM set
 * is missing, repeated, or not exactly the approved one. A link is fine only
 * when it already equals its own canonical serialization.
 */
export function findUtmProblems(text: string, utm: UtmEntry, kenHosts: readonly string[]): UtmProblem[] {
  const problems: UtmProblem[] = [];
  for (const raw of text.match(URL_RE) ?? []) {
    const url = raw.replace(TRAILING_PUNCT_RE, '');
    if (!isKenResearchUrl(url, kenHosts)) continue;
    const params = utmParams(url);
    if (params.length === 0) {
      problems.push({ url, kind: 'missing_utm' });
      continue;
    }
    const keys = params.map((p) => p.split('=')[0]!.toLowerCase());
    if (new Set(keys).size !== keys.length) {
      problems.push({ url, kind: 'duplicate_utm' });
      continue;
    }
    if (applyUtm(url, utm) !== url) {
      problems.push({ url, kind: 'wrong_utm' });
    }
  }
  return problems;
}
