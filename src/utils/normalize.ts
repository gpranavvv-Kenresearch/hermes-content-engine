/**
 * Normalization used for alias matching: strips diacritics, lowercases, turns
 * "&" into "and", and collapses every run of non-alphanumerics into one space.
 * "Markets & Markets", "MARKETS-AND-MARKETS" and "marketsandmarkets" differ only
 * in spacing, so aliases are written in this normalized form.
 */
export function normalizeForMatch(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}
