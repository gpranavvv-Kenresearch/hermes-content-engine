import type { PlatformLimit } from '../schemas/index.js';

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/** URLs found in text, with trailing sentence punctuation removed. */
export function extractUrls(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((u) => u.replace(TRAILING_PUNCT_RE, ''));
}

export function countHashtags(text: string): number {
  return (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

/**
 * Length of the final serialized payload on a platform. URLs count as
 * `urlCountsAs` characters when the platform defines that (X counts every URL
 * as 23); otherwise the literal UTF-16 length is used. UTF-16 length is
 * deliberately the stricter measure: unicode-bold characters are surrogate
 * pairs and count as 2, matching how the legacy code measured FB/LI posts.
 */
export function payloadLength(text: string, limit: Pick<PlatformLimit, 'urlCountsAs'>): number {
  if (limit.urlCountsAs === null) return text.length;
  let length = text.length;
  for (const url of extractUrls(text)) {
    length += limit.urlCountsAs - url.length;
  }
  return length;
}
