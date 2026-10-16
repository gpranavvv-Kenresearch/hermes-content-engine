import {
  BriefSchema,
  PlanningSignalSchema,
  type Brief,
  type Campaign,
  type Fact,
  type Persona,
  type PlanningSignal,
  type VerificationStatus,
} from '../schemas/index.js';
import { isStaleFact } from '../utils/years.js';
import type { StrategyItem } from './context.js';

const METRIC_LABELS: Record<string, string> = {
  market_size: 'market size',
  cagr: 'growth rate',
  market_share: 'market share',
  forecast_value: 'forecast value',
  revenue: 'revenue',
};

export function metricLabel(metric: string): string {
  return METRIC_LABELS[metric] ?? metric.replace(/[_-]+/g, ' ').toLowerCase();
}

function conflictKey(f: Fact): string {
  return [f.metric, f.period ?? '', f.geography ?? '', f.marketDefinition ?? '', f.unit].join('|').toLowerCase();
}

/**
 * Facts a brief may reference: status in `include` (default verified only) and
 * not part of a group (same metric, period, geography, definition, unit) whose
 * members disagree on value. Returned in input order.
 */
export function selectBriefFacts(
  facts: readonly Fact[],
  include: readonly VerificationStatus[] = ['verified'],
): Fact[] {
  // Data older than MIN_DATA_YEAR (a period that starts before it) is never used.
  const candidates = facts.filter((f) => include.includes(f.verificationStatus) && !isStaleFact(f));
  const values = new Map<string, Set<number>>();
  for (const f of candidates) {
    const set = values.get(conflictKey(f)) ?? new Set<number>();
    set.add(f.value);
    values.set(conflictKey(f), set);
  }
  return candidates.filter((f) => (values.get(conflictKey(f))?.size ?? 1) === 1);
}

/** Strongest fact: highest confidence, observed before derived, then lowest id. Deterministic. */
export function strongestFact(facts: readonly Fact[]): Fact | undefined {
  return [...facts].sort(
    (a, b) =>
      (b.confidence ?? 0.5) - (a.confidence ?? 0.5) ||
      (a.factType === b.factType ? 0 : a.factType === 'observed' ? -1 : 1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
}

function chooseAngle(item: StrategyItem, strongest: Fact | undefined, persona: Persona, signals: readonly PlanningSignal[]): string {
  const priority = persona.priorities[0] ?? 'the decision at hand';
  const subject = item.title.trim();
  let angle: string;
  if (strongest) {
    const where = strongest.geography ? ` in ${strongest.geography}` : '';
    const when = strongest.period ? ` over ${strongest.period}` : '';
    angle = `What the ${metricLabel(strongest.metric)}${where}${when} means for ${persona.label}: ${subject}, read through ${priority}`;
  } else {
    angle = `${subject}: a ${persona.label} view focused on ${priority}`;
  }
  // Signals only steer framing words. Their titles and URLs never enter the angle.
  if (signals.some((s) => s.signalKind === 'govt_update')) angle += ', with the regulatory backdrop in view';
  else if (signals.length > 0) angle += ', framed around the questions readers are asking';
  return angle;
}

function titleKeywords(title: string): string[] {
  const t = title.trim().toLowerCase();
  return t ? [t] : [];
}

export interface BuildBriefInput {
  item: StrategyItem;
  facts: readonly Fact[];
  campaign: Campaign;
  persona: Persona;
  /** Why this persona was chosen (from selectPersona). */
  personaReason?: string;
  /** Planning signals. They stay in their own field and never become facts. */
  signals?: readonly PlanningSignal[];
  /** Generic beat points from serp-gap. */
  beatPoints?: readonly string[];
  /** Verification statuses allowed into factIds. Default: verified only. */
  includeStatuses?: readonly VerificationStatus[];
  now: Date;
  maxKeywords?: number;
  /** The required search phrase for this one post, supplied by the content job. */
  primaryKeyword?: string;
}

export function buildBrief(input: BuildBriefInput): Brief {
  const { item, campaign, persona } = input;
  if (!campaign.personaIds.includes(persona.id)) {
    throw new Error(`persona "${persona.id}" is not in campaign "${campaign.id}" persona pool`);
  }
  const usable = selectBriefFacts(input.facts, input.includeStatuses);
  const signals = dedupeSignals(input.signals ?? []);
  const keywords = [...new Set([input.primaryKeyword?.trim() ?? '', ...campaign.keywordCluster.map((k) => k.trim()).filter(Boolean), ...titleKeywords(item.title)].filter(Boolean))].slice(
    0,
    input.maxKeywords ?? 12,
  );
  return BriefSchema.parse({
    itemId: item.id,
    campaignId: campaign.id,
    personaId: persona.id,
    personaReason: input.personaReason ?? 'persona supplied by caller',
    angle: chooseAngle(item, strongestFact(usable), persona, signals),
    keywords,
    beatPoints: [...(input.beatPoints ?? [])],
    planningSignals: signals,
    factIds: usable.map((f) => f.id),
    createdAt: input.now.toISOString(),
  });
}

function dedupeSignals(signals: readonly PlanningSignal[]): PlanningSignal[] {
  const seen = new Set<string>();
  const out: PlanningSignal[] = [];
  for (const s of signals) {
    const parsed = PlanningSignalSchema.safeParse(s);
    if (parsed.success && !seen.has(parsed.data.sourceUrl)) {
      seen.add(parsed.data.sourceUrl);
      out.push(parsed.data);
    }
  }
  return out;
}
