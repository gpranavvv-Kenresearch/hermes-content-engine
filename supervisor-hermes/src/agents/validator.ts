import { parseModelOutput } from '../../../src/contracts.js';
import { scoreContent } from '../../../src/evaluation/index.js';
import { DRAFTS_COLLECTION, MAX_OUTPUT_TOKENS } from '../../../src/pipeline/generate-content.js';
import { runRewriteLoop, type Attempt } from '../../../src/rewrite/index.js';
import type { Draft } from '../../../src/schemas/index.js';
import type { StrategyItem } from '../../../src/strategy/index.js';
import { formatForPlatform, toPlain } from '../../../src/utils/bold.js';
import { mostSimilar } from '../../../src/utils/similarity.js';
import { validateText } from '../../../src/validation/index.js';
import type { AgentReport, SocialPlatform } from '../types.js';
import type { AgentDeps } from './deps.js';
import { usableFacts, type EvidenceOutput } from './evidence.js';
import type { StrategyOutput } from './strategy.js';
import type { WriterOutput } from './writer.js';

export const OWN_DRAFTS_COLLECTION = 'supervisor-hermes-drafts';
const MAX_REWRITE_ROUNDS = 3;

export interface ValidatorOutput {
  passed: boolean;
  status: 'approved' | 'needs_human';
  reason: string;
  /** Final text as posted (Unicode bold). */
  text: string;
  /** Working text with **markdown bold**. */
  markdown: string;
  hardFails: string[];
  reviewCodes: string[];
  score: number | null;
  rewriteRounds: number;
  attempts: Attempt[];
}

/** Shingle-Jaccard above this means "reads like the earlier post" (the limit the main engine uses). */
const SIMILARITY_LIMIT = 0.6;

interface RecentDraft {
  text: string;
  itemId?: string;
  createdAt: string;
}

/** Approved drafts from both pipelines, the newest 50 by creation time (store order is not recency). */
async function recentDrafts(deps: AgentDeps): Promise<RecentDraft[]> {
  const old = (await deps.store.list<Draft>(DRAFTS_COLLECTION))
    .map((r) => r.value)
    .filter((d) => d.status === 'approved')
    .map((d) => ({ text: d.text, itemId: d.itemId, createdAt: d.createdAt }));
  const own = (await deps.store.list<RecentDraft>(OWN_DRAFTS_COLLECTION)).map((r) => r.value);
  return [...old, ...own].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-50);
}

export async function recentTexts(deps: AgentDeps): Promise<string[]> {
  return (await recentDrafts(deps)).map((d) => d.text);
}

/** Called by the orchestrator only after the final gate approved the text, so unposted drafts never count as "recent". */
export async function saveApprovedDraft(deps: AgentDeps, itemId: string, platform: SocialPlatform, text: string): Promise<void> {
  const at = deps.now();
  await deps.store.put(OWN_DRAFTS_COLLECTION, `d_${itemId}_${platform}_${at.getTime()}`, { text, platform, itemId, createdAt: at.toISOString() });
}

export async function runValidatorAgent(
  input: { item: StrategyItem; evidence: EvidenceOutput; strategy: StrategyOutput; draft: WriterOutput; platform: SocialPlatform; keyword: string; minUsefulWords: number; instructions?: string },
  deps: AgentDeps,
): Promise<AgentReport<ValidatorOutput>> {
  const { item, evidence, strategy, draft, platform } = input;
  const facts = usableFacts(evidence);
  const noteTexts = evidence.notes.map((n) => n.text);
  const recentAll = await recentDrafts(deps);
  const recent = recentAll.map((d) => d.text);
  const layout = strategy.variant.layout;
  const validate = (text: string) =>
    validateText(
      {
        draftId: `draft_${item.id}`,
        platform,
        text,
        facts,
        notes: noteTexts,
        evidenceNotes: evidence.notes,
        recentTexts: recent,
        ...(layout ? { layout } : {}),
        claimChecker: deps.claimChecker,
        now: deps.now,
        requiredKeyword: input.keyword,
        minUsefulWords: input.minUsefulWords,
      },
      deps.config,
    );

  const rewrite = await runRewriteLoop({
    initial: async () => ({ text: draft.text, factIds: draft.factIds }),
    provider: deps.writer,
    validate,
    facts,
    notes: evidence.notes,
    ...(input.instructions ? { supervisorInstructions: input.instructions } : {}),
    platform,
    config: deps.config,
    maxRounds: MAX_REWRITE_ROUNDS,
    sourceUrl: item.reportUrl,
    ...(layout ? { layout } : {}),
    parse: parseModelOutput,
    maxOutputTokens: MAX_OUTPUT_TOKENS[platform],
  });

  const markdown = rewrite.text ?? '';
  const text = markdown ? formatForPlatform(markdown, deps.config.platformLimits[platform].formatting, deps.config.brand.name) : '';
  const issues = rewrite.finalReport?.issues ?? [];
  const hardFails = [...new Set(issues.filter((i) => i.severity === 'hard_fail').map((i) => i.code))];
  const reviewCodes = [...new Set(issues.filter((i) => i.severity === 'review').map((i) => i.code))];
  const passed = rewrite.status === 'approved' && hardFails.length === 0 && markdown !== '';

  let score: number | null = null;
  if (passed) {
    const plain = toPlain(markdown);
    score = scoreContent({ text: plain, facts, claimMappings: deps.claimChecker(plain, facts).mappings, brief: strategy.brief, platform, corpus: recent.map(toPlain) }).overall;
  }

  const sameItem = recentAll.filter((d) => d.itemId === item.id).map((d) => toPlain(d.text));
  const similarity = markdown && sameItem.length > 0 ? mostSimilar(toPlain(markdown), sameItem).score : 0;
  const concerns = passed ? [] : hardFails.map((c) => `hard fail ${c}`);
  if (similarity > SIMILARITY_LIMIT) concerns.push(`reads like an earlier post for this report (similarity ${similarity.toFixed(2)}, limit ${SIMILARITY_LIMIT})`);

  return {
    agent: 'validator',
    output: { passed, status: passed ? 'approved' : 'needs_human', reason: rewrite.reason, text, markdown, hardFails, reviewCodes, score, rewriteRounds: rewrite.rounds, attempts: rewrite.attempts },
    summary: passed
      ? `Passed validation after ${rewrite.rounds} rewrite round(s). Score ${score === null ? 'n/a' : Math.round(score * 100)}/100. Review notes: ${reviewCodes.join(', ') || 'none'}.`
      : `Did not pass: ${hardFails.join(', ') || rewrite.reason}.`,
    concerns,
  };
}
