/**
 * Deterministic bold pass. Brand and figure emphasis is a V1.3 non-negotiable, so code applies it instead of asking
 * ChatGPT or Hermes to spend a fix on it: every plain "Ken Research" and every plain figure in body text is wrapped
 * in <strong>. Headings and link text keep their text as written (only the brand is bolded there); scripts and styles
 * are left untouched.
 */
const BRAND = /Ken Research/g;
// Optional currency/unit prefix, the number, then an optional % or scale word, so "USD 5,200 million" and "9.8%" are bolded whole.
const FIGURE = /(?<![A-Za-z0-9_.])(?:(?:USD|US\$|EUR|GBP|INR|ZAR|BRL|AED|SAR|[$€£₹R])\s?)?\d(?:[\d,]*\d)?(?:\.\d+)?(?:\s?%|\s(?:million|billion|trillion|thousand|crore|lakh)\b)?(?![A-Za-z0-9_])/g;

export function enforceBrandAndFigureBold(html: string): string {
  const tagRe = /<(\/)?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let out = '';
  let last = 0;
  let strong = 0, anchor = 0, heading = 0, raw = 0;

  const text = (t: string): string => {
    if (!t.trim() || strong > 0 || raw > 0) return t;
    // Link text: only the brand is bolded (a plain "Ken Research" inside an <a> used to survive and cost a ChatGPT fix round).
    if (anchor > 0) return t.replace(BRAND, (m) => `<strong>${m}</strong>`);
    let s = t.replace(BRAND, (m) => `<strong>${m}</strong>`);
    if (heading === 0) {
      // Skip list markers such as "1." or "2)" at the start of a text node.
      const marker = /^\s*\d+[.)]\s/.exec(s);
      const head = marker ? marker[0] : '';
      const rest = s.slice(head.length);
      s = head + rest.replace(/(<strong>[\s\S]*?<\/strong>)|([^<]+)/g, (_m, bolded: string | undefined, plain: string | undefined) =>
        bolded ?? plain!.replace(FIGURE, (f) => `<strong>${f}</strong>`));
    }
    return s;
  };

  for (const m of html.matchAll(tagRe)) {
    out += text(html.slice(last, m.index));
    out += m[0];
    last = (m.index ?? 0) + m[0].length;
    const closing = !!m[1];
    const name = m[2]!.toLowerCase();
    const d = closing ? -1 : 1;
    if (name === 'strong' || name === 'b') strong = Math.max(0, strong + d);
    else if (name === 'a') anchor = Math.max(0, anchor + d);
    else if (/^h[1-6]$/.test(name)) heading = Math.max(0, heading + d);
    else if (name === 'script' || name === 'style') raw = Math.max(0, raw + d);
  }
  return out + text(html.slice(last));
}
