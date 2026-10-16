import type { UtmEntry } from '../schemas/index.js';

const med = (source: string, medium = 'referral'): UtmEntry => ({
  source,
  medium,
  campaign: 'automation',
});

/**
 * UTM table, one place. Values are ported from the legacy utils/utm.ts
 * (all lowercase). Keys are platform/destination ids. 'instagram' and 'blog'
 * were absent in the legacy table and are added so every PlatformId resolves.
 * Note: the 'pdf' source keeps the legacy raw value "ppt/pdf".
 */
export const utmTable: Record<string, UtmEntry> = {
  x: med('x'),
  facebook: med('facebook'),
  linkedin: med('linkedin'),
  medium: med('medium'),
  linkmate: med('linkmate'),
  googlesite: med('googlesites'),
  devto: med('devto'),
  calisthenics: med('calisthenics'),
  substack: med('substack'),
  hackmd: med('hackmd'),
  linkedinpulse: med('linkedin-pulse'),
  wordpress: med('wordpress'),
  blogger: med('blogger'),
  patreon: med('patreon'),
  notion: med('notion'),
  note: med('note'),
  reddit: med('reddit'),
  naver: med('naver'),
  velog: med('velog'),
  coda: med('coda'),
  ameba: med('ameba'),
  paragraph: med('paragraph'),
  pdf: med('ppt/pdf'),
  tumblr: med('tumblr'),
  instapaper: med('instapaper'),
  raindrop: med('raindrop'),
  pdfhost: med('pdfhost'),
  mastodon: med('mastodon'),
  pearltrees: med('pearltrees'),
  fourshared: med('4shared'),
  scribd: med('scribd'),
  telegraph: med('telegraph'),
  mataroa: med('mataroa'),
  vcru: med('vcru'),
  newsletter: med('newsletter', 'email'),
  instagram: med('instagram'),
  blog: med('blog'),
};
