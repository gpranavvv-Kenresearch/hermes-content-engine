/**
 * UTM parameter utilities for tracking traffic sources
 */

// All UTM values (source/medium/campaign) are lowercase — e.g.
// utm_source=hackmd, not utm_source=HackMD. Keeps values consistent
// regardless of how a platform's display name is cased.
export const UTM_PARAMS = {
  X: '?utm_source=x&utm_medium=referral&utm_campaign=automation',
  Facebook: '?utm_source=facebook&utm_medium=referral&utm_campaign=automation',
  LinkedIn: '?utm_source=linkedin&utm_medium=referral&utm_campaign=automation',
  Medium: '?utm_source=medium&utm_medium=referral&utm_campaign=automation',
  Linkmate: '?utm_source=linkmate&utm_medium=referral&utm_campaign=automation',
  GoogleSite: '?utm_source=googlesites&utm_medium=referral&utm_campaign=automation',
  Devto: '?utm_source=devto&utm_medium=referral&utm_campaign=automation',
  Calisthenics: '?utm_source=calisthenics&utm_medium=referral&utm_campaign=automation',
  Substack: '?utm_source=substack&utm_medium=referral&utm_campaign=automation',
  HackMD: '?utm_source=hackmd&utm_medium=referral&utm_campaign=automation',
  LinkedinPulse: '?utm_source=linkedin-pulse&utm_medium=referral&utm_campaign=automation',
  WordPress: '?utm_source=wordpress&utm_medium=referral&utm_campaign=automation',
  Blogger: '?utm_source=blogger&utm_medium=referral&utm_campaign=automation',
  Patreon: '?utm_source=patreon&utm_medium=referral&utm_campaign=automation',
  Notion: '?utm_source=notion&utm_medium=referral&utm_campaign=automation',
  Note: '?utm_source=note&utm_medium=referral&utm_campaign=automation',
  Reddit: '?utm_source=reddit&utm_medium=referral&utm_campaign=automation',
  Naver: '?utm_source=naver&utm_medium=referral&utm_campaign=automation',
  Velog: '?utm_source=velog&utm_medium=referral&utm_campaign=automation',
  Coda: '?utm_source=coda&utm_medium=referral&utm_campaign=automation',
  Ameba: '?utm_source=ameba&utm_medium=referral&utm_campaign=automation',
  Paragraph: '?utm_source=paragraph&utm_medium=referral&utm_campaign=automation',
  PDF: '?utm_source=ppt/pdf&utm_medium=referral&utm_campaign=automation',
  Tumblr: '?utm_source=tumblr&utm_medium=referral&utm_campaign=automation',
  Instapaper: '?utm_source=instapaper&utm_medium=referral&utm_campaign=automation',
  Raindrop: '?utm_source=raindrop&utm_medium=referral&utm_campaign=automation',
  PdfHost: '?utm_source=pdfhost&utm_medium=referral&utm_campaign=automation',
  Mastodon: '?utm_source=mastodon&utm_medium=referral&utm_campaign=automation',
  Pearltrees: '?utm_source=pearltrees&utm_medium=referral&utm_campaign=automation',
  FourShared: '?utm_source=4shared&utm_medium=referral&utm_campaign=automation',
  Scribd: '?utm_source=scribd&utm_medium=referral&utm_campaign=automation',
  Telegraph: '?utm_source=telegraph&utm_medium=referral&utm_campaign=automation',
  Mataroa: '?utm_source=mataroa&utm_medium=referral&utm_campaign=automation',
  Vcru: '?utm_source=vcru&utm_medium=referral&utm_campaign=automation',
  Newsletter: '?utm_source=newsletter&utm_medium=email&utm_campaign=automation',
};

/**
 * Add UTM parameters to all URLs in text/HTML content
 * Avoids adding if UTM already exists
 */
export function injectUTM(content: string, utmString: string): string {
  if (!content || !utmString) return content;

  const utmParams = utmString.replace(/^\?/, ''); // strip leading ?
  const urlRegex = /(https?:\/\/[^\s<>"']+)/g;

  return content.replace(urlRegex, (match, _g1, offset: number, whole: string) => {
    // Never touch image/media URLs
    if (match.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)) {
      return match;
    }

    // Anything inside an <img src="..."> is an image, even with no file
    // extension (Google Drive /d/<id> URLs have none) — must stay byte-for-byte.
    if (/src\s*=\s*["']$/i.test(whole.slice(Math.max(0, offset - 12), offset))) {
      return match;
    }
    if (/^https?:\/\/(lh\d+\.googleusercontent\.com|drive\.google\.com)\//i.test(match)) {
      return match;
    }

    // Preferred Source CTA links: the direct Google deeplink and the tracked
    // short URL must never be modified.
    if (/^https?:\/\/(www\.)?google\.com\/preferences\/source/i.test(match) ||
        /^https?:\/\/(www\.)?encurtador\.dev\//i.test(match)) {
      return match;
    }

    // For kenresearch.com URLs: always strip existing UTM and replace with correct platform UTM
    if (match.includes('kenresearch.com')) {
      const baseUrl = match
        // Strip both raw "&" and HTML-entity "&amp;" separators — ChatGPT-authored
        // hrefs sometimes emit &amp; between params, which a plain "&" match misses.
        .replace(/[?&](?:amp;)?utm_source=[^&"'\s]*/gi, '')
        .replace(/[?&](?:amp;)?utm_medium=[^&"'\s]*/gi, '')
        .replace(/[?&](?:amp;)?utm_campaign=[^&"'\s]*/gi, '')
        .replace(/[?&](?:amp;)?utm_term=[^&"'\s]*/gi, '')
        .replace(/[?&](?:amp;)?utm_content=[^&"'\s]*/gi, '')
        .replace(/\?$/, '')   // remove trailing ?
        .replace(/&(?:amp;)?$/, ''); // remove trailing & or &amp;
      const separator = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${separator}${utmParams}`;
    }

    // For all other URLs: only add UTM if none already present
    if (match.includes('utm_')) {
      return match;
    }
    const separator = match.includes('?') ? '&' : '?';
    return `${match}${separator}${utmParams}`;
  });
}

/**
 * Ensures targetUrl appears in content so UTM injection has something to tag.
 * If targetUrl is missing from content, appends a "Read the full report" link.
 * Always call this BEFORE injectUTM.
 */
export function ensureTargetUrl(content: string, targetUrl?: string): string {
  if (!targetUrl || !targetUrl.includes('kenresearch.com')) return content;
  const base = targetUrl.split('?')[0];
  if (content.includes(base)) return content;
  return content + `\n\n<p><a href="${targetUrl}">Read the full report on Ken Research</a></p>`;
}

/**
 * Extract base URL (without UTM) for display
 */
export function getBaseUrl(url: string): string {
  const match = url.match(/^[^?]*/);
  return match ? match[0] : url;
}
