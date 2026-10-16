import type { Fetcher, SearchProvider } from '../contracts.js';
import { scoreContent, type ContentScore } from '../evaluation/index.js';
import type { Fact, PlanningSignal, SourceNote } from '../schemas/index.js';
import { loadTechniques } from '../repos/techniques.js';
import { RssSignalSource, loadStyleExamples, selectBriefFacts, type StrategyItem } from '../strategy/index.js';
import { toPlain } from '../utils/bold.js';
import { mostSimilar } from '../utils/similarity.js';
import { gatherEvidence } from './gather-evidence.js';
import { gatherSupplementaryEvidence, type SupplementaryResult } from './supplementary-evidence.js';
import { gatherFreshData, type FreshDataResult } from './fresh-data.js';
import {
  DRAFTS_COLLECTION,
  FULL_STAGES_BY_PLATFORM,
  generateContent,
  type GenerateInput,
  type PipelineDeps,
  type PipelineResult,
} from './generate-content.js';
import { RunManifest, type StepRecord } from './manifest.js';

export const PLAN_RUNS_COLLECTION = 'plan-runs';

/** Fewest source notes a qualitative (no-number) post is built from. */
export const MIN_NOTES_FOR_QUALITATIVE = 3;

/** Shingle-Jaccard above this means "reads like the earlier post". Uncalibrated: tune on real runs. */
export const VARIANT_SIMILARITY_LIMIT = 0.6;

export interface PlanInput {
  platform: GenerateInput['platform'];
  campaignId: string;
  /** Either supply facts (from a saved FactSet) or a url to gather them from. */
  item?: StrategyItem;
  facts?: readonly Fact[];
  notes?: readonly SourceNote[];
  url?: string;
  /** Short market name used for the fresh-data queries. Default: derived from the item title. */
  market?: string;
  geography?: string;
  primaryKeyword?: string;
  minUsefulWords?: number;
}

export interface PlanOptions {
  /** Every step must run (optional ones too), otherwise the result is needs_human. */
  strict?: boolean;
  /** Skip the multi-prompt stages and editorial pass (what the first version of `generate` did). Recorded as skipped. */
  minimal?: boolean;
  styleDir?: string;
  techniquesDir?: string;
  /** Use the writing techniques adopted from reviewed repos. OFF by default: generation is unchanged unless asked. */
  techniques?: boolean;
  /**
   * When the report page has no verified figure from 2024 or later but has at least MIN_NOTES_FOR_QUALITATIVE source notes,
   * write a post WITHOUT numbers from those notes (Ken Research's own statements on its page). Default true. Nothing from
   * the web is ever presented as Ken Research data. Set false to stop at NO_VERIFIED_FACTS instead.
   */
  qualitativeFallback?: boolean;
  /**
   * Where to look when the report page has no verified figure from 2024 or later (needs a search provider):
   * 'all' (default): related Ken Research and government pages, then neutral number-free background from other
   * non-competitor pages; 'ken-gov': only Ken Research and government pages; 'off': the report page only.
   */
  supplementary?: 'off' | 'ken-gov' | 'all';
  /** Approved government feed URLs. Without them, planning-signals is skipped and says why. */
  feedUrls?: readonly string[];
  /** Without a search provider (no Tavily/Exa keys), fresh-data is skipped and says why. */
  searchProvider?: SearchProvider;
  fetcher?: Fetcher;
  variantLimit?: number;
  /** Keep style, methods and variation, but use one draft call before the existing bounded repair loop. */
  socialLean?: boolean;
  /** Skip trend discovery when this job only needs source-backed social text. */
  skipFreshData?: boolean;
}

export interface PlanResult extends PipelineResult {
  problems: StepRecord[];
  fresh?: FreshDataResult;
  /** Everything gathered beyond the report page, one entry per source. */
  supplementary?: SupplementaryResult;
  score?: ContentScore;
  strict: boolean;
}

const marketOf = (title: string): string =>
  title
    .replace(/\b(market|report|outlook|size|share|trends?|forecast|analysis)\b/gi, '')
    .replace(/\b(in|of|for)\s+[A-Z][\w\s]*$/, '')
    .replace(/\s+/g, ' ')
    .trim() || title;

/**
 * Runs the whole plan for one platform and reports every step. A step that cannot run is recorded as
 * skipped or failed WITH THE REASON; it never just disappears. Required steps that did not run make
 * the result needs_human; in strict mode the optional ones are required too.
 */
export async function runContentPlan(
  input: PlanInput,
  deps: Omit<PipelineDeps, 'manifest' | 'stages' | 'editorial' | 'useAngles' | 'styleExamples' | 'techniques'>,
  options: PlanOptions = {},
): Promise<PlanResult> {
  const strict = options.strict === true;
  const manifest = new RunManifest(input.platform);
  const { config, store } = deps;

  // 1. preflight
  manifest.ran('preflight', {
    configVersion: config.version,
    dryRun: deps.flags.dryRun,
    shadowMode: deps.flags.shadowMode,
    maxRewriteRounds: deps.flags.maxRewriteRounds,
  });

  // 2. evidence
  let facts = input.facts ?? [];
  let notes = input.notes ?? [];
  let item = input.item;
  if (facts.length > 0 || notes.length > 0) {
    manifest.ran('evidence', { source: 'supplied factset', facts: facts.length, notes: notes.length });
  } else if (input.url) {
    try {
      const got = await manifest.run(
        'evidence',
        () => gatherEvidence({ url: input.url!, config, ...(options.fetcher ? { fetcher: options.fetcher } : {}) }),
        (g) => ({ source: input.url, facts: g.factSet.facts.length, notes: g.factSet.notes.length }),
      );
      facts = got.factSet.facts;
      notes = got.factSet.notes;
      item ??= { id: got.factSet.itemId, title: input.market ?? 'Ken Research report', reportUrl: got.factSet.reportUrl };
    } catch {
      // recorded as failed by the manifest; generateContent then reports NO_VERIFIED_FACTS
    }
  } else {
    manifest.fail('evidence', 'no facts supplied and no url to gather them from');
  }
  if (!item) item = { id: `item_${Date.now()}`, title: input.market ?? 'Ken Research report', reportUrl: input.url ?? 'https://www.kenresearch.com' };

  // 2b. supplementary evidence: only when the report page gave no verified figure
  let supplementary: SupplementaryResult | undefined;
  const mode = options.supplementary ?? 'all';
  if (selectBriefFacts(facts).length > 0) {
    manifest.skip('supplementary-evidence', 'not needed: the report page has verified figures from 2024 or later', { byDesign: true });
  } else if (options.minimal || mode === 'off') {
    manifest.skip('supplementary-evidence', options.minimal ? 'minimal mode' : 'turned off (--report-only)');
  } else if (!options.searchProvider) {
    manifest.skip('supplementary-evidence', 'no search provider (set TAVILY_API_KEY_1..)');
  } else {
    try {
      supplementary = await manifest.run(
        'supplementary-evidence',
        () =>
          gatherSupplementaryEvidence({
            provider: options.searchProvider!,
            config,
            market: input.market ?? marketOf(item!.title),
            geography: input.geography ?? facts.find((f) => f.geography)?.geography,
            reportUrl: item!.reportUrl,
            mode,
          }),
        (r) => ({
          sources: r.sources.map((s) => `${s.tier}:${s.name} (${s.facts} facts, ${s.notes} notes)`).join('; ') || 'none usable',
          facts: r.facts.length,
          notes: r.notes.length,
          skippedPages: r.skipped.length,
        }),
      );
      facts = [...facts, ...supplementary.facts];
      notes = [...notes, ...supplementary.notes];
    } catch {
      // failed; recorded by the manifest
    }
  }

  const qualitative = options.qualitativeFallback !== false && selectBriefFacts(facts).length === 0 && notes.length >= MIN_NOTES_FOR_QUALITATIVE;
  if (qualitative) {
    manifest.annotate('evidence', { mode: `no verified figure from 2024 or later: a post WITHOUT numbers, written from ${notes.length} Ken Research source notes` });
  }

  // 3. style library
  let styleExamples: string[] = [];
  if (options.minimal) {
    manifest.skip('style-library', 'minimal mode');
  } else {
    const lib = loadStyleExamples(options.styleDir);
    styleExamples = lib.examples;
    if (lib.examples.length > 0) manifest.ran('style-library', { files: lib.files.join(', ') });
    else manifest.skip('style-library', `no usable .txt examples in ${lib.dir}`);
  }

  // 3b. techniques adopted from reviewed repos
  let techniques: string[] = [];
  if (options.minimal) {
    manifest.skip('techniques', 'minimal mode');
  } else if (!options.techniques) {
    manifest.skip('techniques', 'off by default, generation is unchanged (pass --techniques to use adopted repo techniques)', { byDesign: true });
  } else {
    const loaded = loadTechniques(input.platform, options.techniquesDir);
    techniques = loaded.items.map((t) => t.text);
    if (techniques.length > 0) manifest.ran('techniques', { count: techniques.length, from: [...new Set(loaded.items.map((t) => t.repo))].join(', ') });
    else manifest.skip('techniques', `none adopted for ${input.platform} yet (npm run repo:intake, then repo:adopt)`);
  }

  // 4. planning signals (government feeds)
  let signals: PlanningSignal[] = [];
  if (options.minimal) {
    manifest.skip('planning-signals', 'minimal mode');
  } else if (!options.feedUrls || options.feedUrls.length === 0) {
    manifest.skip('planning-signals', 'no government feed URLs configured (set CE_RSS_FEEDS)');
  } else {
    try {
      signals = await manifest.run(
        'planning-signals',
        () => new RssSignalSource({ feedUrls: [...options.feedUrls!], sourcePolicy: config.sourcePolicy }).fetchSignals({ topic: item!.title, maxResults: 8 }),
        (s) => ({ signals: s.length }),
      );
    } catch {
      // failed; recorded by the manifest
    }
  }

  // 5. fresh data (government + trends over the internet)
  let fresh: FreshDataResult | undefined;
  if (options.minimal || options.skipFreshData) {
    manifest.skip('fresh-data', 'minimal mode');
  } else if (!options.searchProvider) {
    manifest.skip('fresh-data', 'no search provider (set TAVILY_API_KEY_1.. or EXA_API_KEY_1..)');
  } else {
    try {
      fresh = await manifest.run(
        'fresh-data',
        () =>
          gatherFreshData({
            provider: options.searchProvider!,
            geography: input.geography ?? facts.find((f) => f.geography)?.geography,
            market: input.market ?? marketOf(item!.title),
            policy: config.sourcePolicy,
          }),
        (r) => ({ government: r.government.length, trends: r.trends.length, discarded: r.discarded }),
      );
      signals = [...signals, ...fresh.signals];
    } catch {
      // failed; recorded by the manifest
    }
  }

  // 6-11. generation
  const earlier = (await store.list<{ itemId: string; platform: string; id: string; text: string; status: string }>(DRAFTS_COLLECTION))
    .map((r) => r.value)
    .filter((d) => d.itemId === item!.id && d.platform === input.platform);
  const earlierTexts = earlier.map((d) => toPlain(d.text));
  const limit = options.variantLimit ?? VARIANT_SIMILARITY_LIMIT;

  const generate = (m: RunManifest, seed?: number): Promise<PipelineResult> =>
    generateContent(
      {
        item: item!,
        facts,
        notes,
        campaignId: input.campaignId,
        platform: input.platform,
        ...(qualitative ? { allowFactless: true } : {}),
        ...(input.primaryKeyword ? { primaryKeyword: input.primaryKeyword } : {}),
        ...(input.minUsefulWords !== undefined ? { minUsefulWords: input.minUsefulWords } : {}),
        ...(signals.length > 0 ? { signals } : {}),
      },
      {
        ...deps,
        manifest: m,
        ...(seed !== undefined ? { seed } : {}),
        ...(options.minimal
          ? {}
          : options.socialLean && (input.platform === 'facebook' || input.platform === 'linkedin')
            ? { stages: ['draft' as const], editorial: false, useAngles: true, styleExamples, techniques }
            : { stages: FULL_STAGES_BY_PLATFORM[input.platform], editorial: true, useAngles: true, styleExamples, techniques }),
      },
    );

  let result = await generate(manifest);
  let chosen = manifest;

  // 12. variant check: a new post for the same report must not read like an earlier one
  if (result.draft) {
    const sim = earlierTexts.length > 0 ? mostSimilar(toPlain(result.draft.text), earlierTexts) : { score: 0, index: -1 };
    let note = { similarity: Number(sim.score.toFixed(2)), comparedWith: earlierTexts.length, limit, retried: false };
    if (sim.score > limit) {
      const retryManifest = new RunManifest(input.platform);
      for (const s of manifest.steps()) {
        if (['preflight', 'evidence', 'style-library', 'planning-signals', 'fresh-data'].includes(s.id) && s.status !== 'skipped') {
          retryManifest.ran(s.id, s.detail);
        } else if (['preflight', 'evidence', 'style-library', 'planning-signals', 'fresh-data'].includes(s.id)) {
          retryManifest.skip(s.id, s.reason ?? 'skipped', { ...(s.byDesign ? { byDesign: true } : {}) });
        }
      }
      const second = await generate(retryManifest, Math.floor(Math.random() * 2 ** 31));
      const sim2 = second.draft ? mostSimilar(toPlain(second.draft.text), earlierTexts).score : 1;
      note = { ...note, retried: true, similarity: Number(Math.min(sim.score, sim2).toFixed(2)) };
      if (second.draft && sim2 < sim.score) {
        result = second;
        chosen = retryManifest;
      }
    }
    chosen.ran('variant-check', note);
  } else {
    chosen.skip('variant-check', 'no draft was produced');
  }

  // 13. scoring
  let score: ContentScore | undefined;
  if (result.draft && result.brief) {
    const plain = toPlain(result.draft.text);
    score = scoreContent({
      text: plain,
      facts,
      claimMappings: deps.claimChecker(plain, facts).mappings,
      brief: result.brief,
      platform: input.platform,
      corpus: earlierTexts,
    });
    chosen.ran('scoring', { overall: score.overall, label: score.label });
  } else {
    chosen.skip('scoring', 'no draft was produced');
  }

  const steps = chosen.steps(result.draft ? 'not executed' : 'not reached: no draft');
  const problems = chosen.problems(strict, result.draft ? 'not executed' : 'not reached: no draft');
  let status = result.status;
  let reason = result.reason;
  if (problems.length > 0 && status === 'approved') {
    status = 'needs_human';
    reason = `plan incomplete: ${problems.map((p) => `${p.id} (${p.status}${p.reason ? `: ${p.reason}` : ''})`).join('; ')}`;
  }

  const out: PlanResult = { ...result, status, reason, steps, problems, strict, ...(fresh ? { fresh } : {}), ...(supplementary ? { supplementary } : {}), ...(score ? { score } : {}) };
  await store.put(PLAN_RUNS_COLLECTION, result.runId, {
    runId: result.runId,
    status,
    reason,
    strict,
    minimal: options.minimal === true,
    steps,
    score: score ?? null,
    fresh: fresh ?? null,
    evidencePack: { facts, notes, sources: supplementary?.sources ?? [], skipped: supplementary?.skipped ?? [], queries: supplementary?.queries ?? [] },
  });
  return out;
}
