import type { LoadedConfig } from '../config/index.js';
import { parseModelOutput, parseModelOutputLenient, type ClaimChecker, type LlmProvider } from '../contracts.js';
import { EngineError, ShutdownError, BudgetExceededError } from '../errors.js';
import { runRewriteLoop, type LoopLogger, type RewriteResult } from '../rewrite/index.js';
import type { Budget } from '../safety/budget.js';
import type { Flags } from '../safety/flags.js';
import type { ShutdownController } from '../safety/shutdown.js';
import {
  DraftSchema,
  type Brief,
  type ContentVariant,
  type Draft,
  type Fact,
  type PlanningSignal,
  type PlatformId,
  type SourceNote,
  type ValidationReport,
} from '../schemas/index.js';
import type { Store } from '../store/store.js';
import {
  HOOK_STYLES,
  NUMBERS_FIRST,
  NUMBERED_LAYOUT_PLATFORMS,
  VariationHistory,
  angleById,
  availableAngles,
  buildBrief,
  buildDraftPrompt,
  buildEditorialRewritePrompt,
  buildOutlinePrompt,
  buildResearchBriefPrompt,
  hookById,
  layoutIdsFor,
  mulberry32,
  primaryNotesFor,
  sampleVariant,
  seedFromString,
  selectBriefFacts,
  selectPersona,
  type StrategyItem,
} from '../strategy/index.js';
import { formatForPlatform, toPlain } from '../utils/bold.js';
import { shortHash } from '../utils/hash.js';
import { applyFixers, sanityReport, validateText, type SanityRow } from '../validation/index.js';
import { RunManifest, type StepRecord } from './manifest.js';

/** Hook formulas that ask for a figure in the opening question. */
const FIGURE_HOOKS: ReadonlySet<string> = new Set(['contrast-why', 'sufficiency', 'which-part']);

export const DRAFTS_COLLECTION = 'drafts';
export const RUNS_COLLECTION = 'runs';
export const REVIEW_QUEUE_COLLECTION = 'review-queue';

export type LlmStage = 'research-brief' | 'outline' | 'draft';

/**
 * The MINIMAL stage list: one draft call for social, three stages for blogs. This is what a bare
 * `generateContent` does. The full plan (see FULL_STAGES_BY_PLATFORM) is run by runContentPlan.
 */
export const STAGES_BY_PLATFORM: Record<PlatformId, readonly LlmStage[]> = {
  x: ['draft'],
  facebook: ['draft'],
  linkedin: ['draft'],
  tumblr: ['draft'],
  instagram: ['draft'],
  mastodon: ['draft'],
  blog: ['research-brief', 'outline', 'draft'],
};

/**
 * The FULL multi-prompt pipeline: research brief -> (outline) -> draft, followed by the editorial
 * pass. Short posts skip the outline by design; Facebook, LinkedIn and blogs use it.
 */
export const FULL_STAGES_BY_PLATFORM: Record<PlatformId, readonly LlmStage[]> = {
  x: ['research-brief', 'draft'],
  facebook: ['research-brief', 'outline', 'draft'],
  linkedin: ['research-brief', 'outline', 'draft'],
  tumblr: ['research-brief', 'draft'],
  instagram: ['research-brief', 'draft'],
  mastodon: ['research-brief', 'draft'],
  blog: ['research-brief', 'outline', 'draft'],
};

/** Per-platform token caps for API/local providers (ported from the legacy per-platform max_tokens). */
export const MAX_OUTPUT_TOKENS: Record<PlatformId, number> = {
  x: 400,
  facebook: 900,
  linkedin: 1600,
  tumblr: 400,
  instagram: 400,
  mastodon: 400,
  blog: 4000,
};

export interface PipelineDeps {
  config: LoadedConfig;
  provider: LlmProvider;
  /**
   * Accept replies that ignore the output format (small local / free-tier
   * models): wrapper noise is stripped and the text goes to validation anyway.
   * A reply that starts the format but never ends it is still rejected.
   */
  lenientOutput?: boolean;
  /**
   * Blog generation stays in the legacy ChatGPT pipeline. The engine refuses to
   * generate blogs unless this is set (tests / future use); blogs are checked
   * with validateText instead.
   */
  allowBlogGeneration?: boolean;
  claimChecker: ClaimChecker;
  store: Store;
  flags: Flags;
  logger?: LoopLogger;
  /** Caps rewrite rounds across a run. (The ChatGPT provider has its own call budget.) */
  budget?: Budget;
  shutdown?: ShutdownController;
  now?: () => Date;
  /** Fixed seed for reproducible variant sampling. Default: derived from item + platform + history length. */
  seed?: number;
  /** Overrides the stage list (default: STAGES_BY_PLATFORM). runContentPlan passes FULL_STAGES_BY_PLATFORM. */
  stages?: readonly LlmStage[];
  /** Run an editorial pass after the draft. It is kept only if validation is no worse than before it. Default false. */
  editorial?: boolean;
  /** Choose an angle (and, on layout platforms, a hook style) for each post from the source notes. Default false. */
  useAngles?: boolean;
  /** Curated posts shown to the model for style only. */
  styleExamples?: readonly string[];
  /** Writing techniques adopted from reviewed repos (see repos/techniques.ts). */
  techniques?: readonly string[];
  /** Collects one record per plan step. A fresh one is created when not supplied. */
  manifest?: RunManifest;
}

export interface GenerateInput {
  item: StrategyItem;
  facts: readonly Fact[];
  campaignId: string;
  platform: PlatformId;
  /** Qualitative statements from the report page (see extractNotes). The model may restate them. */
  notes?: readonly SourceNote[];
  signals?: readonly PlanningSignal[];
  /** Generic topical gaps from serp-gap. Never facts. */
  beatPoints?: readonly string[];
  /** Extra recent texts (e.g. legacy posts) to check duplicates against. */
  recentTexts?: readonly string[];
  /** Allow generating when there are no verified facts (qualitative text). Default false. */
  allowFactless?: boolean;
  primaryKeyword?: string;
  minUsefulWords?: number;
}

export interface StageRecord {
  stage: LlmStage | 'editorial';
  promptVersion: string;
  /** Which provider actually answered (e.g. "groq:qwen/qwen3.8-27b"). */
  provider: string;
  complete: boolean;
  parsed: boolean;
  /** True when the reply ignored the output format and the text was salvaged. */
  salvaged: boolean;
  elapsedMs: number;
}

export type PipelineStatus = 'approved' | 'needs_human';

export interface PipelineResult {
  status: PipelineStatus;
  reason: string;
  draft: Draft | null;
  brief: Brief | null;
  variant: ContentVariant | null;
  rewrite: RewriteResult | null;
  stages: StageRecord[];
  /** One record per planned step: ran, skipped (with reason) or failed. */
  steps: StepRecord[];
  /** One row per content-sanity check on the final text (empty when no draft was produced). */
  sanity: SanityRow[];
  runId: string;
}

class StageFailure extends EngineError {
  constructor(stage: string, why: string) {
    super(`stage "${stage}" failed: ${why}`, 'needs_human', 'STAGE_FAILED', { detail: { stage, why } });
  }
}

const hardCodes = (r: ValidationReport): Set<string> => new Set(r.issues.filter((i) => i.severity === 'hard_fail').map((i) => i.code));
const reviewCount = (r: ValidationReport): number => r.issues.filter((i) => i.severity === 'review').length;

/** An edited text is kept only if it introduces no new hard-fail code and no more review flags than before. */
function editorialIsNoWorse(before: ValidationReport, after: ValidationReport): boolean {
  const hb = hardCodes(before);
  for (const code of hardCodes(after)) if (!hb.has(code)) return false;
  return reviewCount(after) <= reviewCount(before);
}

/**
 * ONE item, ONE platform: evidence-grounded generation with validation and a
 * bounded rewrite loop. It never publishes: it only writes the draft, the run
 * record and (when a human is needed) a review-queue entry to the Store. The
 * dry_run / shadow_mode flags are recorded on every run for audit.
 *
 * Nothing is retried blindly: a stage whose reply is incomplete or unparseable
 * ends the run as needs_human; fixing text goes through the rewrite loop,
 * whose prompts always carry the exact failures.
 *
 * Every step it performs is recorded in the run manifest (result.steps). Steps it never reached
 * are reported as skipped with the reason, never omitted.
 */
export async function generateContent(input: GenerateInput, deps: PipelineDeps): Promise<PipelineResult> {
  const { config, store } = deps;
  if (input.platform === 'blog' && !deps.allowBlogGeneration) {
    throw new EngineError(
      'Blog generation is not done by this engine: it stays in the existing ChatGPT blog pipeline. Check a finished blog with `npm run validate -- --platform blog --file <text>`.',
      'fatal',
      'BLOG_GENERATION_OUT_OF_SCOPE',
    );
  }
  const stageList = deps.stages ?? STAGES_BY_PLATFORM[input.platform];
  if (!stageList.includes('draft')) throw new EngineError('The stage list must include "draft"', 'fatal', 'BAD_PLAN');

  const manifest = deps.manifest ?? new RunManifest(input.platform);
  const parseReply = deps.lenientOutput ? parseModelOutputLenient : parseModelOutput;
  const maxOutputTokens = MAX_OUTPUT_TOKENS[input.platform];
  const now = deps.now ?? (() => new Date());
  const runId = `run_${shortHash({ item: input.item.id, platform: input.platform, at: now().toISOString(), n: Math.random() }, 16)}`;
  const stages: StageRecord[] = [];
  const log = (level: 'info' | 'warn', obj: Record<string, unknown>, msg: string): void => deps.logger?.[level]({ runId, ...obj }, msg);

  const fail = async (
    reason: string,
    parts: Partial<Pick<PipelineResult, 'brief' | 'variant' | 'rewrite' | 'draft'>> = {},
  ): Promise<PipelineResult> => {
    const result: PipelineResult = {
      status: 'needs_human',
      reason,
      draft: parts.draft ?? null,
      brief: parts.brief ?? null,
      variant: parts.variant ?? null,
      rewrite: parts.rewrite ?? null,
      stages,
      steps: manifest.steps(`not reached: ${reason}`),
      sanity: [],
      runId,
    };
    await persistRun(result, input, deps, runId, now());
    await store.put(REVIEW_QUEUE_COLLECTION, runId, {
      runId,
      itemId: input.item.id,
      platform: input.platform,
      reason,
      queuedAt: now().toISOString(),
    });
    log('warn', { reason }, 'run needs a human');
    return result;
  };

  // --- guards --------------------------------------------------------------
  const campaign = config.campaigns.find((c) => c.id === input.campaignId);
  if (!campaign || !campaign.active) return fail(`unknown or inactive campaign "${input.campaignId}"`);
  if (!campaign.platforms.includes(input.platform)) {
    return fail(`campaign "${campaign.id}" does not publish to "${input.platform}"`);
  }
  try {
    deps.shutdown?.assertRunning();
  } catch (e) {
    if (e instanceof ShutdownError) return fail(`shutdown: ${e.message}`);
    throw e;
  }

  // --- evidence: only verified, non-conflicting facts may be used --------------
  const usableFacts = selectBriefFacts(input.facts);
  if (usableFacts.length === 0 && !input.allowFactless) {
    return fail('NO_VERIFIED_FACTS: no verified, non-conflicting facts available for this item');
  }

  // --- strategy: persona, angle, hook, tone --------------------------------------
  const selection = selectPersona({ campaign, facts: usableFacts, itemMeta: { title: input.item.title } });
  const persona = config.personas.find((p) => p.id === selection.personaId);
  if (!persona) return fail(`persona "${selection.personaId}" not found in config`);

  const brief = buildBrief({
    item: input.item,
    facts: input.facts,
    campaign,
    persona,
    personaReason: selection.reason,
    ...(input.signals ? { signals: input.signals } : {}),
    ...(input.beatPoints ? { beatPoints: input.beatPoints } : {}),
    now: now(),
    ...(input.primaryKeyword ? { primaryKeyword: input.primaryKeyword } : {}),
  });

  const history = await new VariationHistory(store).load();
  const seed = deps.seed ?? seedFromString(`${input.item.id}|${input.platform}|${history.all().length}`);
  // With no verified figure the post has no numbers, so angles and hooks that lean on a figure are left out.
  const noFigures = usableFacts.length === 0;
  const angleIds = deps.useAngles ? availableAngles(input.notes ?? []).filter((a) => !(noFigures && a === NUMBERS_FIRST)) : undefined;
  const hookIds = deps.useAngles && NUMBERED_LAYOUT_PLATFORMS.includes(input.platform) ? HOOK_STYLES.map((h) => h.id).filter((id) => !(noFigures && FIGURE_HOOKS.has(id))) : undefined;
  const eligibleLayouts = layoutIdsFor(input.platform, input.notes ?? [], usableFacts);
  const layoutIds = deps.useAngles && eligibleLayouts.length > 0 ? eligibleLayouts : undefined;
  const variant = sampleVariant({
    campaign,
    itemId: input.item.id,
    personaId: persona.id,
    platform: input.platform,
    history,
    rng: mulberry32(seed),
    config,
    ...(angleIds ? { angles: angleIds } : {}),
    ...(hookIds ? { hookStyles: hookIds } : {}),
    ...(layoutIds ? { layouts: layoutIds } : {}),
  });
  // Record immediately so a failed run does not let the same combination be sampled again.
  await history.record(variant, input.platform, now());
  manifest.ran('persona-angle-variant', {
    persona: persona.id,
    why: selection.reason,
    tone: variant.tone,
    angle: variant.angle ?? 'none',
    hook: variant.hookStyle ?? 'none',
    layout: variant.layout ?? 'default',
    opener: variant.opener,
    length: variant.lengthClass,
  });

  const angleDef = variant.angle ? angleById(variant.angle) : undefined;
  const anglePrompt = angleDef
    ? {
        label: angleDef.label,
        instruction: angleDef.instruction,
        primaryNotes: primaryNotesFor(angleDef.id, input.notes ?? []).map((n) => ({ id: n.id, text: n.text })),
      }
    : undefined;
  const hookDef = variant.hookStyle ? hookById(variant.hookStyle) : undefined;

  // --- multi-prompt generation ----------------------------------------------------
  const promptCtx = {
    config,
    platform: input.platform,
    persona,
    tone: variant.tone,
    facts: usableFacts,
    notes: input.notes ?? [],
    styleExamples: deps.styleExamples ?? [],
    techniques: deps.techniques ?? [],
    ...(variant.layout ? { layout: variant.layout } : {}),
    reportUrl: input.item.reportUrl,
  };
  const briefView = { angle: brief.angle, keywords: brief.keywords, beatPoints: brief.beatPoints };

  const runStage = async (
    stage: StageRecord['stage'],
    built: { prompt: string; promptVersion: string },
  ): Promise<{ text: string; factIds: string[]; promptVersion: string; provider: string }> => {
    const reply = await deps.provider.generate({
      prompt: built.prompt,
      purpose: stage,
      expectLong: (stage !== 'draft' && stage !== 'editorial') || input.platform === 'blog',
      maxOutputTokens,
    });
    const parsed = reply.complete ? parseReply(reply.text) : null;
    stages.push({
      stage,
      promptVersion: built.promptVersion,
      provider: reply.provider,
      complete: reply.complete,
      parsed: parsed?.ok === true,
      salvaged: parsed?.ok === true && parsed.output.salvaged === true,
      elapsedMs: reply.elapsedMs,
    });
    if (!reply.complete) throw new StageFailure(stage, 'incomplete reply (cut off or still generating)');
    if (!parsed || !parsed.ok) throw new StageFailure(stage, `unparseable reply (${parsed ? parsed.reason : 'unknown'})`);
    return { text: parsed.output.text, factIds: parsed.output.factIds, promptVersion: built.promptVersion, provider: reply.provider };
  };

  let draftOutput: { text: string; factIds: string[]; promptVersion: string } | undefined;
  try {
    const stageNotes: string[] = [];
    for (const stage of stageList) {
      const built =
        stage === 'research-brief'
          ? () => buildResearchBriefPrompt({ ...promptCtx, brief: briefView, itemTitle: input.item.title })
          : stage === 'outline'
            ? () => buildOutlinePrompt({ ...promptCtx, brief: briefView, itemTitle: input.item.title })
            : () =>
                buildDraftPrompt({
                  ...promptCtx,
                  brief: briefView,
                  itemTitle: input.item.title,
                  variant,
                  ...(stageNotes.length > 0 ? { outlineText: stageNotes.join('\n\n') } : {}),
                  ...(anglePrompt ? { angle: anglePrompt } : {}),
                  ...(hookDef ? { hook: hookDef } : {}),
                });
      const out = await manifest.run(
        stage,
        () => runStage(stage, built()),
        (r) => ({ provider: r.provider, chars: r.text.length }),
      );
      if (stage === 'research-brief') stageNotes.push(`Research notes:\n${out.text}`);
      else if (stage === 'outline') stageNotes.push(`Outline:\n${out.text}`);
      else draftOutput = out;
    }
  } catch (e) {
    if (e instanceof StageFailure || e instanceof ShutdownError || e instanceof BudgetExceededError) {
      return fail(e.message, { brief, variant });
    }
    if (e instanceof EngineError) return fail(`${e.code}: ${e.message}`, { brief, variant });
    throw e;
  }
  for (const id of ['research-brief', 'outline'] as const) {
    if (stageList.includes(id)) continue;
    // A caller that passes an explicit stage list chose these stages on purpose (for example the social one-draft profile).
    if (deps.stages) {
      manifest.skip(id, `by design: this run uses ${stageList.join(' > ')}`, { byDesign: true });
    } else {
      manifest.skip(id, 'not configured in this run (minimal stage list)');
    }
  }
  // The stage list is checked above to include 'draft', so draftOutput is assigned here.
  let initial = draftOutput!;

  // --- shared validation ----------------------------------------------------------------
  const knownIds = new Set(usableFacts.map((f) => f.id));
  const recentTexts = await loadRecentTexts(store, input.recentTexts);
  const noteTexts = (input.notes ?? []).map((n) => n.text);
  const validateAs = (draftId: string) => (text: string) =>
    validateText(
      { draftId, platform: input.platform, text, facts: usableFacts, notes: noteTexts, evidenceNotes: input.notes ?? [], recentTexts, ...(variant.layout ? { layout: variant.layout } : {}), claimChecker: deps.claimChecker, now, ...(input.primaryKeyword ? { requiredKeyword: input.primaryKeyword } : {}), ...(input.minUsefulWords !== undefined ? { minUsefulWords: input.minUsefulWords } : {}) },
      config,
    );
  const fixCtx = { platform: input.platform, config };

  // --- editorial pass ---------------------------------------------------------------------
  if (deps.editorial) {
    const check = validateAs('editorial');
    const prepared = applyFixers(initial.text, fixCtx).text;
    const before = check(prepared);
    try {
      const edited = await manifest.run(
        'editorial',
        async () => {
          const issues = before.issues.map((i) => `${i.code}: ${i.message}`);
          const out = await runStage(
            'editorial',
            buildEditorialRewritePrompt({ ...promptCtx, draftText: prepared, issues, variant }),
          );
          const candidate = applyFixers(out.text, fixCtx).text;
          const after = check(candidate);
          const keep = editorialIsNoWorse(before, after);
          return { out, candidate, keep, hardBefore: hardCodes(before).size, hardAfter: hardCodes(after).size, reviewBefore: reviewCount(before), reviewAfter: reviewCount(after) };
        },
        (r) => ({ kept: r.keep, hard: `${r.hardBefore}->${r.hardAfter}`, review: `${r.reviewBefore}->${r.reviewAfter}`, provider: r.out.provider }),
      );
      initial = edited.keep
        ? { text: edited.candidate, factIds: edited.out.factIds, promptVersion: initial.promptVersion }
        : { ...initial, text: prepared };
    } catch (e) {
      // The edit failed (for example an unusable reply). The draft is kept as it was; the manifest shows 'editorial' as failed.
      if (e instanceof ShutdownError || e instanceof BudgetExceededError) return fail(e.message, { brief, variant });
      if (!(e instanceof StageFailure || e instanceof EngineError)) throw e;
      log('warn', { reason: (e as Error).message }, 'editorial pass failed; keeping the draft as written');
    }
  } else {
    manifest.skip('editorial', 'not enabled in this run', deps.editorial === false ? { byDesign: true } : {});
  }

  // --- validate + bounded rewrite loop -----------------------------------------------
  const draftId = `draft_${shortHash({ item: input.item.id, platform: input.platform, variant, text: initial.text }, 16)}`;
  const rewrite = await manifest.run(
    'validate-rewrite',
    () =>
      runRewriteLoop({
        initial: async () => ({ text: initial.text, factIds: initial.factIds }),
        provider: deps.provider,
        validate: validateAs(draftId),
        facts: usableFacts,
        notes: input.notes ?? [],
        platform: input.platform,
        config,
        maxRounds: deps.flags.maxRewriteRounds,
        sourceUrl: input.item.reportUrl,
        ...(variant.layout ? { layout: variant.layout } : {}),
        parse: parseReply,
        maxOutputTokens,
        ...(deps.budget ? { budget: deps.budget } : {}),
        ...(deps.shutdown ? { shutdown: deps.shutdown } : {}),
        ...(deps.logger ? { logger: deps.logger } : {}),
      }),
    (r) => ({ status: r.status, rewriteRounds: r.rounds, attempts: r.attempts.length }),
  );

  if (rewrite.text === null) return fail(`no usable text: ${rewrite.reason}`, { brief, variant, rewrite });

  const unknownIds = rewrite.factIds.filter((id) => !knownIds.has(id));
  if (unknownIds.length > 0) log('warn', { unknownIds }, 'model cited fact ids that were not supplied; dropped');

  // The loop works on markdown (**bold**). The saved draft is the FINAL text: on Facebook and
  // LinkedIn the asterisks become Unicode bold, which is what gets posted.
  const formatting = config.platformLimits[input.platform].formatting;
  const finalText = formatForPlatform(rewrite.text, formatting, deps.config.brand.name);
  const usesBold = formatting.boldBrand || formatting.boldFigures;

  const draft: Draft = DraftSchema.parse({
    id: draftId,
    itemId: input.item.id,
    platform: input.platform,
    text: finalText,
    ...(usesBold ? { markdown: rewrite.text } : {}),
    variant: { ...variant, promptVersion: initial.promptVersion },
    factIds: rewrite.factIds.filter((id) => knownIds.has(id)),
    configVersion: config.version,
    promptVersion: initial.promptVersion,
    attempt: rewrite.rounds + 1,
    status: rewrite.status === 'approved' ? 'approved' : 'needs_human',
    createdAt: now().toISOString(),
  });
  await store.put(DRAFTS_COLLECTION, draft.id, draft);
  manifest.ran('finalize', { draftId: draft.id, chars: finalText.length, bold: usesBold });

  const sanity = sanityReport(toPlain(rewrite.text), usableFacts, noteTexts);
  manifest.ran('content-sanity', {
    pass: sanity.filter((r) => r.status === 'pass').length,
    warn: sanity.filter((r) => r.status === 'warn').length,
    fail: sanity.filter((r) => r.status === 'fail').length,
  });

  const result: PipelineResult = {
    status: rewrite.status,
    reason: rewrite.reason,
    draft,
    brief,
    variant,
    rewrite,
    stages,
    steps: manifest.steps(),
    sanity,
    runId,
  };
  await persistRun(result, input, deps, runId, now());
  if (rewrite.status === 'needs_human') {
    await store.put(REVIEW_QUEUE_COLLECTION, runId, {
      runId,
      itemId: input.item.id,
      platform: input.platform,
      draftId: draft.id,
      reason: rewrite.reason,
      queuedAt: now().toISOString(),
    });
  }
  log('info', { status: result.status, draftId: draft.id, rounds: rewrite.rounds }, 'run finished');
  return result;
}

async function persistRun(result: PipelineResult, input: GenerateInput, deps: PipelineDeps, runId: string, at: Date): Promise<void> {
  await deps.store.put(RUNS_COLLECTION, runId, {
    runId,
    at: at.toISOString(),
    itemId: input.item.id,
    platform: input.platform,
    campaignId: input.campaignId,
    status: result.status,
    reason: result.reason,
    configVersion: deps.config.version,
    flags: { dryRun: deps.flags.dryRun, shadowMode: deps.flags.shadowMode },
    stages: result.stages,
    steps: result.steps,
    variant: result.variant,
    brief: result.brief,
    draftId: result.draft?.id ?? null,
    attempts: result.rewrite?.attempts ?? [],
    finalReport: result.rewrite?.finalReport ?? null,
  });
}

async function loadRecentTexts(store: Store, extra: readonly string[] | undefined): Promise<string[]> {
  const rows = await store.list<Draft>(DRAFTS_COLLECTION);
  const approved = rows
    .map((r) => r.value)
    .filter((d) => d.status === 'approved')
    .slice(-50)
    .map((d) => d.text);
  return [...approved, ...(extra ?? [])];
}
