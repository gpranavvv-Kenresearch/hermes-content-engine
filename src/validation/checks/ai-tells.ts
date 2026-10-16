/**
 * CURATION FILE. Everything in here is a heuristic seed list, easy to edit:
 * add a phrase, run the tests, and record the change in docs/validation.md.
 *
 * - AI_TELL_PHRASES: literal phrases (lowercase, straight apostrophes). Matched
 *   case-insensitively with letter/digit boundaries. Phrases already in
 *   brandConfig.bannedPhrases are reported as BANNED_PHRASE, not here.
 * - AI_TELL_PATTERNS: regex entries for word families ("delve", "delved", ...).
 * - WEAK_EVIDENCE_PATTERNS: vague attributions with no named source.
 * - GENERIC_PROMO_PHRASES: sales-copy boilerplate that undercuts an analyst voice.
 *
 * Review-only: a hit asks for a rewrite or a human glance, it never blocks alone.
 * Words that are common in legitimate market analysis ("landscape", "robust",
 * "leverage") are deliberately NOT here, to keep false positives low.
 */

export const AI_TELL_PHRASES: readonly string[] = [
  "in today's fast-paced",
  "in today's digital age",
  "in today's world",
  "in an ever-changing",
  "in the realm of",
  "it's worth noting",
  'it is worth noting',
  "it's worth mentioning",
  'it should be noted',
  'plays a crucial role',
  'plays a pivotal role',
  'plays a vital role',
  'serves as a beacon',
  'stands as a testament',
  'embark on a journey',
  'harness the power',
  'at the end of the day',
  "let's dive",
  'dive into',
  'paradigm shift',
  'holistic approach',
  'a myriad of',
  'in the grand scheme',
  'only time will tell',
  'the future looks bright',
  'rapidly changing world',
];

export interface NamedPattern {
  id: string;
  re: RegExp;
}

export const AI_TELL_PATTERNS: readonly NamedPattern[] = [
  { id: 'delve', re: /\bdelv(e|es|ed|ing)\b/i },
  { id: 'tapestry', re: /\btapestr(y|ies)\b/i },
  { id: 'multifaceted', re: /\bmulti-?faceted\b/i },
  { id: 'underscores', re: /\bunderscor(e|es|ed|ing)\b/i },
  { id: 'intricate', re: /\bintricac(y|ies)\b|\bintricate\b/i },
  { id: 'meticulous', re: /\bmeticulous(ly)?\b/i },
  { id: 'seamless', re: /\bseamless(ly)?\b/i },
  { id: 'sentence_start_moreover', re: /(^|[.!?]\s+|\n)(moreover|furthermore|additionally),/i },
];

export const WEAK_EVIDENCE_PATTERNS: readonly NamedPattern[] = [
  { id: 'studies_show', re: /\b(studies|research) (show|shows|suggest|suggests|indicate|indicates|have shown)\b/i },
  { id: 'experts_say', re: /\b(experts|analysts|insiders|observers|economists) (say|agree|believe|predict|expect|warn)\b/i },
  { id: 'many_believe', re: /\b(many|some|most) (people |experts |analysts |industry (watchers|observers) )?(believe|say|think|agree)\b/i },
  { id: 'widely_known', re: /\b(it is|it's) (widely|commonly|generally|well) (believed|known|accepted|agreed|documented)\b|\beveryone knows\b/i },
  { id: 'according_to_some', re: /\baccording to (some|many|several) (experts|analysts|sources|reports)\b/i },
];

export const GENERIC_PROMO_PHRASES: readonly string[] = [
  'best-in-class',
  'best in class',
  'world-class',
  'cutting-edge',
  'state-of-the-art',
  'industry-leading',
  'next-level',
  'take your business to the next level',
  "don't miss out",
  'do not miss out',
  'act now',
  'limited time',
  'click here',
  'must-read',
  "you won't believe",
  'second to none',
  'one-stop shop',
  'unlock growth',
];
