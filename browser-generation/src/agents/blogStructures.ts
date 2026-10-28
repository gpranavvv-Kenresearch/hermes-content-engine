/**
 * Blog article architectures (DRAFT, opt-in; see docs/architecture/blog-structures-draft-2026-10-23.md).
 *
 * Each architecture becomes its own standalone prompt file under
 * browser-generation/prompts/blog-generation/structures/, generated from the V1.3 master prompt by
 * src/tools/buildBlogStructures.ts. Only the "silently create three structures" step is swapped; every
 * other V1.3 rule (H2 formula, word limits, patterns, bolding, links, sourcing) is unchanged.
 *
 * Selection: BLOG_STRUCTURE=v1.3 (default, the live prompt) | <id> | rotate | random.
 * rotate and random both pick among the LEAST-USED structures so a bulk run never repeats one back to back;
 * rotate takes the first of those, random takes a random one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BLOG_FORMATS } from './blogFormats.js';

export interface BlogArchitecture {
  id: string;
  label: string;
  /** Prompt-ready text that replaces V1.3's "create three structures" step. */
  block: string;
}

const COMMON_TAIL =
  'Fit each H2 to what the report and verified government sources actually support; if a section below has no supported evidence, adapt that H2 to the nearest supported topic. Never invent a figure, scenario, ranking or source to fill the architecture.';

export const ARCHITECTURES: readonly BlogArchitecture[] = [
  {
    id: 'decision-brief',
    label: 'Decision Brief',
    block: `ARCHITECTURE: DECISION BRIEF. A decision-maker reads this to decide what to do. H2 order: (1) a question H2 on market size and growth, with base value, forecast, CAGR and years in the first sentence; (2) the core demand driver with its mechanism; (3) the buyer or segment split; (4) a question H2 on who competes and how they win; (5) the counter-thesis: what could slow the market; (6) the forward-looking, decision-driving conclusion H2 with the CTA. ${COMMON_TAIL}`,
  },
  {
    id: 'question-ladder',
    label: 'Question Ladder',
    block: `ARCHITECTURE: QUESTION LADDER. Built for AI Overviews and People-Also-Ask. Five or six H2s, all but one phrased as a real question a buyer or analyst would search about this market, climbing from "how big and how fast" to "what drives it", "which segments matter", "who wins" and "what could go wrong". The first sentence under each H2 is the complete direct answer with the verified figure; later sentences add the mechanism and the implication. Every answer must still make sense quoted on its own. The last H2 is the fresh, decision-driving conclusion with the CTA. ${COMMON_TAIL}`,
  },
  {
    id: 'economics-teardown',
    label: 'Economics Teardown',
    block: `ARCHITECTURE: ECONOMICS TEARDOWN. Explain how the market earns money. H2 order: (1) a question H2 on size and growth; (2) where the value chain earns its margin; (3) the cost, pricing or capacity driver that moves the market; (4) a question H2 on how channel or capacity economics differ between segments; (5) the main risk to unit economics; (6) the conclusion H2 with the CTA. Each H2 holds one derived number or named threshold labelled as Ken Research analysis, only where the report supports it. ${COMMON_TAIL}`,
  },
  {
    id: 'segment-divergence',
    label: 'Segment Divergence',
    block: `ARCHITECTURE: SEGMENT DIVERGENCE. Show that the market is not one market. H2 order: (1) a question H2 on size and growth; (2) which segment leads and why; (3) which segment is accelerating or lagging; (4) a question H2 on what buyers in each segment actually choose; (5) a saturation or risk signal; (6) the conclusion H2 with the CTA. Do not rank segments or players beyond what the report states. ${COMMON_TAIL}`,
  },
  {
    id: 'regulation-to-opportunity',
    label: 'Regulation to Opportunity',
    block: `ARCHITECTURE: REGULATION TO OPPORTUNITY. For policy-shaped markets. H2 order: (1) a question H2 on size and growth; (2) the regulatory shift and its date, sourced to a government site; (3) who gains and who bears the compliance cost; (4) a question H2 on how the rules change buyer or supplier behaviour; (5) the execution risk; (6) the conclusion H2 with the CTA. Place the government links where the regulation is discussed. ${COMMON_TAIL}`,
  },
  {
    id: 'competitive-moat',
    label: 'Competitive Moat',
    block: `ARCHITECTURE: COMPETITIVE MOAT. For concentrated or consolidating markets. H2 order: (1) a question H2 on size and growth; (2) how the market is structured; (3) what creates the entry barriers (capital, licences, distribution, data); (4) a question H2 on how leading players differentiate; (5) where challengers can still enter; (6) the conclusion H2 with the CTA. Never rank competitors beyond what the report supports. ${COMMON_TAIL}`,
  },
  {
    id: 'scenario-outlook',
    label: 'Scenario Outlook',
    block: `ARCHITECTURE: SCENARIO OUTLOOK. For volatile or policy-dependent markets. H2 order: (1) a question H2 on the baseline size and forecast; (2) what must go right for the forecast to hold; (3) what could pull growth below it; (4) a question H2 on the signals a buyer should watch; (5) the segment or region most exposed; (6) the conclusion H2 with the CTA. Scenarios are qualitative and sit around the report's own CAGR; do not invent scenario numbers. ${COMMON_TAIL}`,
  },
  {
    id: 'myth-vs-evidence',
    label: 'Myth vs Evidence',
    block: `ARCHITECTURE: MYTH VS EVIDENCE. Highest information gain. H2 order: (1) the headline figure and the common assumption it challenges; (2) to (4) one H2 per widely repeated belief about this market, each tested against the report or a government source (question or statement form); (5) what the evidence implies for decisions; (6) the conclusion H2 with the CTA. Only use beliefs the evidence can genuinely test; do not invent a myth. ${COMMON_TAIL}`,
  },
];

export const DEFAULT_STRUCTURE = 'v1.3';
export const STRUCTURES_DIR = path.resolve('browser-generation/prompts/blog-generation/structures');
export const FORMATS_DIR = path.resolve('browser-generation/prompts/blog-generation/formats');
export const MASTER_V13_FILE = path.resolve('browser-generation/prompts/blog-generation/01-master-v1.3-live.txt');
const usageFile = () => process.env.BLOG_STRUCTURE_USAGE_FILE || path.resolve('.sessions/blog-structure-usage.json');

export type StructureFamily = 'architecture' | 'format';

export interface StructureInfo {
  id: string;
  label: string;
  family: StructureFamily;
  /** What the supervisor reads about this structure. */
  summary: string;
}

/** Every selectable structure: the 8 V1.3-based architectures and the 8 standalone formats. */
export const STRUCTURE_CATALOG: readonly StructureInfo[] = [
  ...ARCHITECTURES.map((a): StructureInfo => ({ id: a.id, label: a.label, family: 'architecture', summary: a.block })),
  ...BLOG_FORMATS.map((f): StructureInfo => ({ id: f.id, label: f.label, family: 'format', summary: f.spec })),
];

export function describeStructure(id: string): StructureInfo | undefined {
  return STRUCTURE_CATALOG.find((s) => s.id === id);
}

export function idsInFamily(family: StructureFamily): string[] {
  return STRUCTURE_CATALOG.filter((s) => s.family === family).map((s) => s.id);
}

export function structureFile(id: string): string {
  return path.join(describeStructure(id)?.family === 'format' ? FORMATS_DIR : STRUCTURES_DIR, `${id}.txt`);
}

function readUsage(): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(usageFile(), 'utf8')) as Record<string, number>;
  } catch {
    return {};
  }
}

function recordUse(id: string): void {
  try {
    const usage = readUsage();
    usage[id] = (usage[id] ?? 0) + 1;
    fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
    fs.writeFileSync(usageFile(), JSON.stringify(usage, null, 2), 'utf8');
  } catch {
    // Usage counting only improves variety; never fail a generation over it.
  }
}

/**
 * Pools for the automatic modes:
 *   rotate / random                 the 8 V1.3-based architectures (unchanged behaviour)
 *   rotate-formats / random-formats the 11 standalone formats
 *   rotate-all / random-all         all 19
 */
function poolFor(wanted: string): { ids: string[]; random: boolean } | null {
  const m = /^(rotate|random)(?:-(formats|all))?$/.exec(wanted);
  if (!m) return null;
  const scope = m[2];
  const ids = scope === 'formats' ? idsInFamily('format') : scope === 'all' ? STRUCTURE_CATALOG.map((s) => s.id) : idsInFamily('architecture');
  return { ids, random: m[1] === 'random' };
}

/** Resolve BLOG_STRUCTURE (or the given mode) to the id of the prompt file to use. 'v1.3' means the live master prompt. */
export function chooseStructure(mode: string = process.env.BLOG_STRUCTURE || DEFAULT_STRUCTURE): string {
  const wanted = mode.trim().toLowerCase();
  if (wanted === DEFAULT_STRUCTURE) return DEFAULT_STRUCTURE;
  const pool = poolFor(wanted);
  if (pool) {
    const usage = readUsage();
    const least = Math.min(...pool.ids.map((id) => usage[id] ?? 0));
    const candidates = pool.ids.filter((id) => (usage[id] ?? 0) === least);
    const picked = pool.random ? candidates[Math.floor(Math.random() * candidates.length)]! : candidates[0]!;
    recordUse(picked);
    return picked;
  }
  if (!describeStructure(wanted)) {
    throw new Error(`Unknown BLOG_STRUCTURE "${mode}". Use v1.3, rotate, random, rotate-formats, random-formats, rotate-all, random-all or one of: ${STRUCTURE_CATALOG.map((s) => s.id).join(', ')}`);
  }
  recordUse(wanted);
  return wanted;
}
