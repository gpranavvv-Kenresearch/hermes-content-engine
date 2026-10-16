import type { SourceNote } from '../schemas/index.js';

/**
 * Angles: WHAT a post argues, as opposed to how it sounds. Source notes from the report page are
 * grouped into themes; each variant of a report gets a different angle and builds its numbered
 * points mainly from that theme's notes. This is the strongest variation lever, because it changes
 * the content, not just the wording.
 */

export interface PostAngle {
  id: string;
  label: string;
  /** Tells the model what to argue. */
  instruction: string;
  /** Notes that match belong to this angle (a note can belong to several). */
  keywords: RegExp;
}

export const NUMBERS_FIRST = 'numbers-first';

export const ANGLES: readonly PostAngle[] = [
  {
    id: 'growth-drivers',
    label: 'What is driving growth',
    instruction: 'Argue that the growth is explained by specific drivers, and what a decision maker should read into them.',
    keywords: /\b(growth|driver|supported|adoption|expanding|catalyst|demand|engagement|conversion)\b/i,
  },
  {
    id: 'competitive-structure',
    label: 'Who wins: the competitive structure',
    instruction: 'Argue from how concentrated or fragmented the market is and who holds the advantages.',
    keywords: /\b(compet\w*|concentrat\w*|fragment\w*|leading|incumbent\w*|largest|ranks|advantage\w*|share|dominan\w*)\b/i,
  },
  {
    id: 'monetization-pricing',
    label: 'How the money is made',
    instruction: 'Argue from the revenue model: what is monetized, how it is priced, and what that means for returns.',
    keywords: /\b(monetiz\w*|subscription\w*|pricing|revenue|packages?|charges|recurring|premium)\b/i,
  },
  {
    id: 'trust-verification',
    label: 'Trust and verification as a product',
    instruction: 'Argue that trust, verification or fraud control is becoming a product and a barrier in this market.',
    keywords: /\b(verif\w*|trust|fraud\w*|identity|badges?|screening|validation|complaint)\b/i,
  },
  {
    id: 'compliance',
    label: 'Compliance and regulation',
    instruction: 'Argue from compliance, consent or competition remedies and what they change for platforms.',
    keywords: /\b(regulat\w*|complian\w*|consent|remed\w*|legislat\w*|data protection|interoperab\w*)\b/i,
  },
  {
    id: 'entry-strategy',
    label: 'Where a new entrant can win',
    instruction: 'Argue about where smaller or newer players can enter, and what it takes to compete.',
    keywords: /\b(entry|smaller|sme|mid-market|new entrant\w*|mobile-first|without relying|onboarding|self-service)\b/i,
  },
  {
    id: NUMBERS_FIRST,
    label: 'The numbers and what they imply',
    instruction: 'Lead with the market size and growth rate, and argue what the trajectory implies for timing and capital.',
    keywords: /$^/, // never matches: this angle needs no notes
  },
];

export function angleById(id: string): PostAngle | undefined {
  return ANGLES.find((a) => a.id === id);
}

/** Notes grouped by angle. Angles with no matching note are omitted (except numbers-first). */
export function groupNotesByAngle(notes: readonly SourceNote[]): Map<string, SourceNote[]> {
  const out = new Map<string, SourceNote[]>();
  for (const angle of ANGLES) {
    if (angle.id === NUMBERS_FIRST) continue;
    const matching = notes.filter((n) => angle.keywords.test(n.text));
    if (matching.length > 0) out.set(angle.id, matching);
  }
  return out;
}

/** Angle ids a report can support: every angle with at least one note, plus numbers-first. */
export function availableAngles(notes: readonly SourceNote[]): string[] {
  return [...groupNotesByAngle(notes).keys(), NUMBERS_FIRST];
}

/** The notes a given angle should lead with (empty for numbers-first). */
export function primaryNotesFor(angleId: string, notes: readonly SourceNote[]): SourceNote[] {
  return groupNotesByAngle(notes).get(angleId) ?? [];
}
