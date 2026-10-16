import type { Campaign, Fact } from '../schemas/index.js';

export interface ItemMeta {
  title: string;
  /** Extra descriptive text (category, summary, tags). Optional. */
  tags?: string[];
  /** Caller knows the item is news-driven (launch, deal, shock). Optional override. */
  headlineDriven?: boolean;
}

export interface PersonaSelection {
  personaId: string;
  reason: string;
}

const GROWTH_METRIC_RE = /(cagr|growth|rate|forecast|projection|yoy)/i;
const REGULATORY_RE =
  /\b(regulat\w*|polic(y|ies)|law|laws|legislation|compliance|mandate\w*|tariff\w*|subsid\w*|ban|bans|standard|standards|government|ministry|licen[cs]\w*|approval|framework|act)\b/i;
const HEADLINE_RE =
  /\b(launch\w*|surge\w*|record|acquir\w*|acquisition|merger|deal|breaks?|announce\w*|crisis|shock|first|new)\b/i;

interface Score {
  score: number;
  why: string[];
}

/**
 * Deterministic, rule-based persona choice. Never invents a persona: the
 * result is always one of campaign.personaIds. Only the three personas the
 * rules know about (cxo, pe-vc, strategy-head) can score; any other id in the
 * campaign is a fallback candidate. Ties resolve to the earlier id in
 * campaign.personaIds, so the same input always yields the same answer.
 */
export function selectPersona(input: {
  campaign: Pick<Campaign, 'id' | 'personaIds'>;
  facts: readonly Fact[];
  itemMeta: ItemMeta;
}): PersonaSelection {
  const { campaign, facts, itemMeta } = input;
  const ids = campaign.personaIds;
  const text = [itemMeta.title, ...(itemMeta.tags ?? [])].join(' ');

  const growthFacts = facts.filter((f) => GROWTH_METRIC_RE.test(f.metric) || /percent|%/i.test(f.unit)).length;
  const growthShare = facts.length === 0 ? 0 : growthFacts / facts.length;
  const regulatoryHits = (text.match(new RegExp(REGULATORY_RE.source, 'gi')) ?? []).length;
  const regulatoryFacts = facts.filter((f) => /regulat|polic|tariff|subsid|compliance/i.test(f.metric)).length;
  const headlineHit = itemMeta.headlineDriven === true || HEADLINE_RE.test(text);

  const scores: Record<string, Score> = {
    'pe-vc': { score: 0, why: [] },
    'strategy-head': { score: 0, why: [] },
    cxo: { score: 0, why: [] },
  };
  if (growthFacts >= 2 || growthShare >= 0.5) {
    scores['pe-vc']!.score += 2 + growthFacts;
    scores['pe-vc']!.why.push(`growth/CAGR heavy (${growthFacts} of ${facts.length} facts are rate or percentage metrics)`);
  }
  if (regulatoryHits >= 1 || regulatoryFacts >= 1) {
    scores['strategy-head']!.score += 2 + regulatoryHits + regulatoryFacts;
    scores['strategy-head']!.why.push(`regulatory/policy heavy (${regulatoryHits} policy terms in title/tags, ${regulatoryFacts} policy facts)`);
  }
  if (headlineHit) {
    scores.cxo!.score += 3;
    scores.cxo!.why.push('headline-driven item');
  }
  if (facts.length > 0 && facts.length <= 2) {
    scores.cxo!.score += 1;
    scores.cxo!.why.push('few facts, suits a concise implication-led post');
  }

  let best: { id: string; score: number } | undefined;
  for (const id of ids) {
    const s = scores[id]?.score ?? 0;
    if (!best || s > best.score) best = { id, score: s };
  }
  // personaIds is schema-guaranteed non-empty; guard anyway rather than invent one.
  if (!best) throw new Error(`campaign "${campaign.id}" has no personas to select from`);

  if (best.score === 0) {
    return {
      personaId: best.id,
      reason: `no persona rule matched; defaulted to first persona of campaign "${campaign.id}"`,
    };
  }
  const why = scores[best.id]?.why.join('; ') ?? '';
  return { personaId: best.id, reason: `${why} -> ${best.id} (score ${best.score})` };
}
