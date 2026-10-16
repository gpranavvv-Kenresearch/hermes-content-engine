import type { Brief, Fact } from '../schemas/index.js';

/**
 * Evergreen pillar templates. Pure data plus a small builder. Nothing here
 * promises search ranking; the structure aims at being useful and easy to
 * refresh, and any visibility outcome depends on factors outside this code.
 */

export interface PillarSectionTemplate {
  id: string;
  heading: string;
  guidance: string;
  /** Fact metrics (substring match, case-insensitive) most relevant to this section. */
  metricHints: string[];
  /** FAQ-style questions this section can answer; {topic} is substituted. */
  questions: string[];
}

export const PILLAR_SECTIONS: PillarSectionTemplate[] = [
  {
    id: 'definition',
    heading: 'What the {topic} covers',
    guidance: 'Define the market and its boundaries in plain terms. State what is in and out of scope.',
    metricHints: ['market_size', 'size'],
    questions: ['What is {topic}?', 'What is included in the {topic} definition?'],
  },
  {
    id: 'segmentation',
    heading: 'How {topic} is segmented',
    guidance: 'Break the market down by product, end user or geography. Use only segment figures that are provided as facts.',
    metricHints: ['share', 'segment'],
    questions: ['Which segments make up {topic}?'],
  },
  {
    id: 'drivers',
    heading: 'What is driving {topic}',
    guidance: 'Explain demand, supply and cost drivers. Tie each driver to a stated fact or leave it qualitative.',
    metricHints: ['cagr', 'growth'],
    questions: ['What drives growth in {topic}?'],
  },
  {
    id: 'constraints',
    heading: 'What holds {topic} back',
    guidance: 'Cover cost, capacity, adoption or supply constraints. Keep them specific rather than generic.',
    metricHints: [],
    questions: ['What are the main constraints in {topic}?'],
  },
  {
    id: 'regulatory',
    heading: 'Regulation and policy affecting {topic}',
    guidance: 'Describe the regulatory backdrop. Cite only government or regulatory bodies and Ken Research for this.',
    metricHints: ['regulat', 'policy', 'tariff', 'subsid'],
    questions: ['Which regulations affect {topic}?'],
  },
  {
    id: 'outlook',
    heading: 'Outlook for {topic}',
    guidance: 'Give the forecast period and what would change it. Separate observed figures from forecast figures.',
    metricHints: ['forecast', 'cagr', 'projection'],
    questions: ['How is {topic} expected to develop?'],
  },
];

export interface PillarSection {
  id: string;
  heading: string;
  guidance: string;
  factIds: string[];
}

export interface PillarOutline {
  itemId: string;
  topic: string;
  sections: PillarSection[];
  faq: string[];
  refreshNotes: string[];
}

function fill(template: string, topic: string): string {
  return template.replaceAll('{topic}', topic);
}

/** Builds a pillar outline. Only facts listed in brief.factIds are attached to sections. */
export function buildPillarOutline(brief: Brief, facts: readonly Fact[], options: { topic?: string } = {}): PillarOutline {
  const topic = options.topic ?? brief.keywords[0] ?? 'the market';
  const allowed = new Set(brief.factIds);
  const usable = facts.filter((f) => allowed.has(f.id));
  const assigned = new Set<string>();

  const sections: PillarSection[] = PILLAR_SECTIONS.map((tpl) => {
    // A fact attaches to the FIRST section whose hints match it, so no figure is repeated across sections.
    const matching = usable.filter((f) => !assigned.has(f.id) && tpl.metricHints.some((h) => f.metric.toLowerCase().includes(h)));
    matching.forEach((f) => assigned.add(f.id));
    return { id: tpl.id, heading: fill(tpl.heading, topic), guidance: tpl.guidance, factIds: matching.map((f) => f.id) };
  });
  // Facts no section claimed go to the definition section so none are dropped silently.
  const orphans = usable.filter((f) => !assigned.has(f.id)).map((f) => f.id);
  if (orphans.length > 0) sections[0]!.factIds.push(...orphans);

  const faq = PILLAR_SECTIONS.flatMap((t) => t.questions.map((q) => fill(q, topic)));
  return { itemId: brief.itemId, topic, sections, faq, refreshNotes: buildRefreshNotes(usable) };
}

/**
 * Plain checklist for keeping a pillar current. Flags facts whose source
 * retrieval date is older than `maxAgeDays`. It does not claim any effect on rankings.
 */
export function buildRefreshNotes(facts: readonly Fact[], options: { now?: Date; maxAgeDays?: number } = {}): string[] {
  const now = options.now ?? new Date();
  const maxAge = options.maxAgeDays ?? 180;
  const notes = [
    'Re-verify every figure against the Ken Research report page before each refresh.',
    'Update period labels when a newer forecast edition is published.',
    'Remove or rewrite any statement whose supporting fact has become conflicting or unverified.',
  ];
  for (const f of facts) {
    const ageDays = (now.getTime() - Date.parse(f.sourceRetrievedAt)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays > maxAge) {
      notes.push(`Fact ${f.id} (${f.metric}) was retrieved ${Math.floor(ageDays)} days ago; re-check it.`);
    }
  }
  return notes;
}
