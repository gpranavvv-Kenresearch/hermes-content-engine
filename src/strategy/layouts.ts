import type { Fact, PlatformId } from '../schemas/index.js';
import { findGeographies } from '../evidence/fact-extractor.js';
import { COUNTRIES } from '../evidence/geography.data.js';

/**
 * User-approved shared Facebook/LinkedIn formats. New formats require user review before
 * entering this pool. Legacy layouts remain readable but are not sampled for new posts.
 */

export interface PostLayout {
  id: string;
  label: string;
  /** Opening and body steps; platform-specific closing steps are appended by layoutSection. */
  steps: readonly string[];
  /** Closing sentence of the layout rules (what list symbol to use). */
  listRule: string;
  /** The hook is a question, so hook styles (see hooks.ts) apply. */
  hookIsQuestion: boolean;
  /** Plain-text markers the first lines must carry (checked by checkLayout). */
  requires?: readonly string[];
  /** Explicit list bounds for the newer editorial formats; zero permits narrative paragraphs. */
  minItems?: number;
  maxItems?: number;
  singleDiscussion?: boolean;
}

export const POST_LAYOUTS: readonly PostLayout[] = [
  {
    id: 'stat-spotlight', label: 'One-stat spotlight', hookIsQuestion: false,
    minItems: 0, maxItems: 0, singleDiscussion: true,
    steps: [
      'Lead with ONE verified statistic as a short standalone callout. Name its source, market, period and scope immediately afterwards.',
      'Explain its meaning, add one supported nuance and close with a practical implication. Do not repeat the headline statistic in the body.',
    ],
    listRule: 'Use compact paragraphs, without a numbered list or bullets.',
  },
  {
    id: 'forecast-timeline', label: 'Baseline to forecast', hookIsQuestion: false,
    minItems: 0, maxItems: 0, singleDiscussion: true,
    steps: [
      'Short statement hook, then two clearly labelled blocks: the baseline year/value and the forecast year/value, attributed to the source.',
      'Use comparable figures for the SAME market and scope. Explain one supported shift and its implication; do not invent intermediate milestones.',
    ],
    listRule: 'Use year-labelled paragraphs, without bullets or numbered lists.',
  },
  {
    id: 'two-lens-comparison', label: 'Two-lens comparison', hookIsQuestion: false,
    minItems: 0, maxItems: 0, singleDiscussion: true,
    steps: [
      'Introduce one market insight, then explain two distinct evidence-backed lenses in labelled paragraphs, such as volume and value.',
      'Show what each lens reveals and how they inform the same assessment. Do not invent a comparison or present these as two strategic routes.',
    ],
    listRule: 'Use two labelled prose blocks followed by a short implication; no list.',
  },
  {
    id: 'source-quote-analysis', label: 'Source-quote analysis', hookIsQuestion: false,
    minItems: 0, maxItems: 0, singleDiscussion: true,
    steps: [
      'Open with a short EXACT excerpt (6–25 words) from a supplied Ken Research source note, in quotation marks. Attribute it and name the market immediately afterwards.',
      'Explain the context, the narrower finding it supports and a practical implication. Never manufacture a quote, endorsement or country ranking.',
    ],
    listRule: 'Use a quote lead and natural paragraphs, without a list.',
  },
  {
    id: 'evaluation-checklist', label: 'Evaluation checklist', hookIsQuestion: false,
    minItems: 3, maxItems: 3, singleDiscussion: true,
    steps: [
      'Introduce a specific evaluation task and its source-backed context.',
      'Give exactly three practical screening checkpoints as hyphen bullets. Tie each to supplied evidence; frame checks as considerations, not guaranteed outcomes.',
    ],
    listRule: 'Use three plain hyphen bullets, then one brief decision implication.',
  },
  {
    id: 'market-watchlist', label: 'What-to-watch watchlist', hookIsQuestion: false,
    minItems: 0, maxItems: 0, singleDiscussion: true,
    steps: [
      'Introduce one forward-looking market theme and attribute the outlook.',
      'Give three short labelled paragraphs beginning with "Watch": each names a different source-backed signal and why it deserves attention. Keep projections qualified; do not invent targets or triggers.',
    ],
    listRule: 'Use three Watch-labelled paragraphs, not numbered points or bullets, then a brief implication.',
  },
  {
    id: 'insight-brief', label: 'Insight and three takeaways', hookIsQuestion: false,
    minItems: 3, maxItems: 3, singleDiscussion: true,
    steps: [
      'Open with one short, evidence-backed tension as a statement. Follow with one attributed market snapshot.',
      'Give exactly three concise bullets with different insights, then one strategic implication. Each bullet must add information, not restate the hook or another bullet.',
    ],
    listRule: 'Use three plain hyphen bullets; no numbered research-summary paragraphs.',
  },
  {
    id: 'short-narrative', label: 'Situation, tension, implication', hookIsQuestion: false,
    minItems: 0, maxItems: 0, singleDiscussion: true,
    steps: [
      'Use four or five short paragraphs: a specific statement hook, the market evidence, the tension or trade-off, and the practical implication.',
      'Build one connected argument from supplied evidence. No invented personal story, quotations, client experience or prevailing belief.',
    ],
    listRule: 'Use natural paragraphs, without bullets or numbered lists.',
  },
  {
    id: 'evidence-to-decision', label: 'Evidence to decision', hookIsQuestion: false,
    minItems: 0, maxItems: 0, singleDiscussion: true,
    steps: [
      'Open with a concise decision tension as a statement; give one source-attributed market snapshot.',
      'Compare two evidence-backed options in short paragraphs, explain the trade-off and give one decision criterion. Separate findings from interpretation; avoid generic investment prescriptions.',
    ],
    listRule: 'Use compact paragraphs, without bullets or numbered lists.',
  },
  {
    id: 'country-contrast', label: 'Three country perspectives', hookIsQuestion: false,
    minItems: 3, maxItems: 3, singleDiscussion: true,
    steps: [
      'Statement hook, then one attributed market snapshot. Give three concise bullets about distinct country markets or an explicitly evidenced country grouping.',
      'Each bullet needs a different supported advantage or constraint. Treat Southeast Asia as a region; never invent individual-country detail. Close the body with one implication.',
    ],
    listRule: 'Use three plain hyphen bullets. Preserve source groupings such as Japan and South Korea.',
  },
  {
    id: 'numbered-points',
    label: 'Hook question, numbered points',
    hookIsQuestion: true,
    steps: [
      'First paragraph: a hook written as ONE question. It names the market and its key figure and points at a tension or contrast.',
      'Then 4 or 5 numbered points, written "1.", "2.", "3." and so on, each in its own paragraph. Each point is one or two sentences: one fact from the FACTS or SOURCE NOTES, then what it means for a decision maker. The last point may run a little longer.',
    ],
    listRule: 'Use numbers for the points, not bullet symbols or dashes.',
  },
  {
    id: 'bullet-insights',
    label: 'Statement opener, bullet insights',
    hookIsQuestion: false,
    steps: [
      'First paragraph: ONE or TWO plain statement sentences (not a question) that name Ken Research, the market and its key figures: size now, size at the end of the forecast, and the growth rate.',
      'Then one short line that introduces the list and ends with a colon, for example "Three things decision-makers should note before planning entry:".',
      'Then 3 or 4 bullets, each in its own paragraph and each starting with a hyphen and a space ("- "). Each bullet is one or two sentences: one fact from the FACTS or SOURCE NOTES, then what it means for a decision maker.',
    ],
    listRule: 'Start each bullet with a plain hyphen and a space. Use no numbers, no other bullet symbols and no emoji.',
  },
  {
    id: 'myth-reality',
    label: 'Myth versus reality',
    hookIsQuestion: false,
    requires: ['Myth:', 'Reality:'],
    steps: [
      'First paragraph: starts with the word "Myth:" followed by ONE sentence stating a common assumption about this market. It must be an assumption a reader might hold, not a fact from the report.',
      'Second paragraph: starts with the word "Reality:" followed by one or two sentences that begin with "according to Ken Research" or "Ken Research finds" and give the key figures from the FACTS.',
      'Then one short line that ends with a colon (for example "What the research points to:"), followed by exactly 3 bullets, each in its own paragraph and each starting with a hyphen and a space ("- "). Each bullet is one fact from the SOURCE NOTES or FACTS and what it means.',
    ],
    listRule: 'Start each bullet with a plain hyphen and a space. Use no numbers, no other bullet symbols and no emoji.',
  },
];

export const DEFAULT_LAYOUT = 'numbered-points';

/** All ten samples approved by the user on 2026-10-15; shared by both platforms. */
export const APPROVED_SOCIAL_LAYOUTS: readonly string[] = [
  'insight-brief', 'short-narrative', 'evidence-to-decision', 'country-contrast',
  'stat-spotlight', 'forecast-timeline', 'two-lens-comparison', 'source-quote-analysis',
  'evaluation-checklist', 'market-watchlist',
];

const BY_PLATFORM: Partial<Record<PlatformId, readonly string[]>> = {
  facebook: APPROVED_SOCIAL_LAYOUTS,
  linkedin: APPROVED_SOCIAL_LAYOUTS,
};

export function layoutIdsFor(platform: PlatformId, notes?: readonly { text: string; tier?: string }[], facts?: readonly Fact[]): readonly string[] {
  const ids = BY_PLATFORM[platform] ?? [];
  if (notes === undefined && facts === undefined) return ids;
  const countries = new Set((notes ?? []).flatMap((n) => findGeographies(n.text)).filter((g) => COUNTRIES.includes(g)));
  const quoteAvailable = (notes ?? []).some((n) => (!n.tier || n.tier === 'ken_research') && n.text.split(/\s+/).length >= 6);
  const verified = facts?.filter((f) => f.verificationStatus === 'verified');
  const sizes = verified?.filter((f) => ['market_size', 'forecast_value'].includes(f.metric)
    && /^\d{4}$/.test(f.period ?? '') && f.geography?.trim() && f.marketDefinition?.trim()) ?? [];
  const timelineAvailable = sizes.some((a) => sizes.some((b) => Number(b.period) > Number(a.period)
    && a.unit === b.unit && a.currency === b.currency
    && (a.geography ?? '').toLowerCase() === (b.geography ?? '').toLowerCase()
    && (a.marketDefinition ?? '').toLowerCase() === (b.marketDefinition ?? '').toLowerCase()));
  return ids.filter((id) => {
    if (id === 'country-contrast' && notes !== undefined) return countries.size >= 3;
    if (id === 'source-quote-analysis' && notes !== undefined) return quoteAvailable;
    if (id === 'stat-spotlight' && verified !== undefined) return verified.length > 0;
    if (id === 'forecast-timeline' && verified !== undefined) return timelineAvailable;
    return true;
  });
}

export function layoutById(id: string | undefined, platform?: PlatformId): PostLayout {
  const fallback = platform === 'linkedin' || platform === 'facebook' ? APPROVED_SOCIAL_LAYOUTS[0]! : DEFAULT_LAYOUT;
  return POST_LAYOUTS.find((l) => l.id === (id ?? fallback))
    ?? POST_LAYOUTS.find((l) => l.id === fallback)!;
}
