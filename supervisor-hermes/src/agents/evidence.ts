import { gatherEvidence } from '../../../src/pipeline/gather-evidence.js';
import { MIN_NOTES_FOR_QUALITATIVE } from '../../../src/pipeline/run-plan.js';
import { gatherSupplementaryEvidence } from '../../../src/pipeline/supplementary-evidence.js';
import type { Fact, SourceNote } from '../../../src/schemas/index.js';
import { selectBriefFacts } from '../../../src/strategy/brief-builder.js';
import { shortHash } from '../../../src/utils/hash.js';
import type { AgentReport } from '../types.js';
import type { AgentDeps } from './deps.js';

export type EvidenceMode = 'figures' | 'qualitative' | 'none';

export interface EvidenceOutput {
  itemId: string;
  reportPageLoaded: boolean;
  facts: Fact[];
  notes: SourceNote[];
  mode: EvidenceMode;
  verifiedFigures: number;
  sources: string[];
  error?: string;
}

/** The facts the writer, strategy and validator may use: the main engine's filter (verified, 2024 or later, no conflicting values). */
export function usableFacts(evidence: Pick<EvidenceOutput, 'facts'>): Fact[] {
  return selectBriefFacts(evidence.facts);
}

/** Last path segment, lower case, no trailing slash. A report keeps its slug when only the prefix or host form changes. */
function slugOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').split('/').pop()?.toLowerCase() ?? '';
  } catch {
    return '';
  }
}

export async function runEvidenceAgent(
  input: { url: string; title: string; supplementary: 'off' | 'ken-gov' | 'all' },
  deps: AgentDeps,
): Promise<AgentReport<EvidenceOutput>> {
  const itemId = `item_${shortHash(input.url, 12)}`;
  let facts: Fact[] = [];
  let notes: SourceNote[] = [];
  const sources: string[] = [input.url];
  const concerns: string[] = [];

  // A report that did not load can never anchor a post: do not look for substitute evidence.
  const notLoaded = (message: string): AgentReport<EvidenceOutput> => ({
    agent: 'evidence',
    output: { itemId, reportPageLoaded: false, facts: [], notes: [], mode: 'none', verifiedFigures: 0, sources, error: message },
    summary: `The report page did not load (${message}). No evidence was gathered.`,
    concerns: [`report page failed: ${message}`],
  });
  try {
    const got = await gatherEvidence({ url: input.url, config: deps.config, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}), now: deps.now });
    if (slugOf(got.source.finalUrl) !== slugOf(input.url)) {
      return notLoaded(`the URL redirected to a different page (${got.source.finalUrl}), so it is not this report`);
    }
    facts = got.factSet.facts;
    notes = got.factSet.notes;
  } catch (error) {
    return notLoaded((error as Error).message);
  }

  if (selectBriefFacts(facts).length === 0 && input.supplementary !== 'off' && deps.searchProvider) {
    try {
      const extra = await gatherSupplementaryEvidence({
        provider: deps.searchProvider,
        config: deps.config,
        market: input.title,
        geography: facts.find((f) => f.geography)?.geography,
        reportUrl: input.url,
        mode: input.supplementary,
        now: deps.now,
      });
      facts = [...facts, ...extra.facts];
      notes = [...notes, ...extra.notes];
      sources.push(...extra.sources.map((s) => s.url));
      if (extra.sources.length > 0) concerns.push(`figures or background came from ${extra.sources.length} supplementary page(s), not the report page`);
    } catch (error) {
      concerns.push(`supplementary search failed: ${(error as Error).message}`);
    }
  }

  const verifiedFigures = selectBriefFacts(facts).length;
  const mode: EvidenceMode = verifiedFigures > 0 ? 'figures' : notes.length >= MIN_NOTES_FOR_QUALITATIVE ? 'qualitative' : 'none';
  return {
    agent: 'evidence',
    output: { itemId, reportPageLoaded: true, facts, notes, mode, verifiedFigures, sources },
    summary: `Report page loaded. ${verifiedFigures} verified figure(s) from 2024 or later, ${notes.length} source note(s). Mode: ${mode}.`,
    concerns,
  };
}
