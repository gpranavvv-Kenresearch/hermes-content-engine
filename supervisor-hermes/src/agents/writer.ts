import { parseModelOutput } from '../../../src/contracts.js';
import { MAX_OUTPUT_TOKENS } from '../../../src/pipeline/generate-content.js';
import { buildDraftPrompt, type StrategyItem } from '../../../src/strategy/index.js';
import type { AgentReport, SocialPlatform } from '../types.js';
import type { AgentDeps } from './deps.js';
import { usableFacts, type EvidenceOutput } from './evidence.js';
import type { StrategyOutput } from './strategy.js';

export interface WriterOutput {
  text: string;
  factIds: string[];
  promptVersion: string;
}

export async function runWriterAgent(
  input: { item: StrategyItem; evidence: EvidenceOutput; strategy: StrategyOutput; platform: SocialPlatform; instructions?: string; previousDraft?: string },
  deps: AgentDeps,
): Promise<AgentReport<WriterOutput>> {
  const { item, evidence, strategy, platform } = input;
  const persona = deps.config.personas.find((p) => p.id === strategy.personaId);
  if (!persona) throw new Error(`persona "${strategy.personaId}" not found in config`);
  const built = buildDraftPrompt({
    config: deps.config,
    platform,
    persona,
    tone: strategy.variant.tone,
    facts: usableFacts(evidence),
    notes: evidence.notes,
    styleExamples: strategy.styleExamples,
    techniques: strategy.techniques,
    ...(strategy.variant.layout ? { layout: strategy.variant.layout } : {}),
    reportUrl: item.reportUrl,
    brief: { angle: strategy.brief.angle, keywords: strategy.brief.keywords, beatPoints: strategy.brief.beatPoints },
    itemTitle: item.title,
    variant: strategy.variant,
    ...(strategy.anglePrompt ? { angle: strategy.anglePrompt } : {}),
    ...(strategy.hook ? { hook: strategy.hook } : {}),
  });
  const limit = deps.config.platformLimits[platform];
  // Stated on every attempt, at the end of the prompt, with the real numbers. The model overshoots when the range is only implied.
  const overBy = input.previousDraft && limit.targetMaxChars !== null ? input.previousDraft.length - limit.targetMaxChars : 0;
  const lengthRule = limit.targetMaxChars === null
    ? ''
    : platform === 'x'
      ? `\n## LENGTH REQUIREMENT (STRICT)\nThe whole post must be at most ${limit.hardMaxChars ?? limit.targetMaxChars} characters including spaces, hashtags and the link (each URL counts as ${limit.urlCountsAs ?? 23}). There is no tolerance. Count before replying; if over, cut a clause.`
      : `\n## LENGTH REQUIREMENT (STRICT)\nThe final post must be between ${limit.targetMinChars ?? 0} and ${limit.targetMaxChars} characters including spaces, the report link, hashtags and the closing question. At most 20 characters outside that range is tolerated; anything more is rejected. Count your characters before replying. If you are over, cut the least important supported insight or sentence rather than trimming words everywhere.${overBy > 0 ? ` The current draft is about ${input.previousDraft!.length} characters, so remove about ${overBy} characters.` : ''}`;
  const prompt = [
    built.prompt,
    ...(input.instructions ? [`\n## SUPERVISOR INSTRUCTIONS FOR THIS ATTEMPT\n${input.instructions}\nFollow them without adding any fact that is not in the evidence above. Evidence, hard validation and the house format take precedence over conflicting style suggestions.`] : []),
    ...(input.previousDraft ? [
      '\n## TARGETED EDIT OF THE CURRENT DRAFT',
      'Edit only the listed blockers; preserve compliant paragraphs and supported claims. Keep the selected format and its question count. Do not undo earlier corrections or invent an industry assumption.',
      `CURRENT DRAFT:\n${input.previousDraft}`,
    ] : []),
    lengthRule,
  ].join('\n');
  const reply = await deps.writer.generate({ prompt, purpose: input.previousDraft ? 'rewrite' : 'draft', maxOutputTokens: MAX_OUTPUT_TOKENS[platform] });
  if (!reply.complete) throw new Error('writer: incomplete reply (cut off or still generating)');
  const parsed = parseModelOutput(reply.text);
  if (!parsed.ok) throw new Error(`writer: unparseable reply (${parsed.reason})`);
  return {
    agent: 'writer',
    output: { text: parsed.output.text, factIds: parsed.output.factIds, promptVersion: built.promptVersion },
    summary: `Draft of ${parsed.output.text.length} characters citing ${parsed.output.factIds.length} fact id(s).${input.instructions ? ' Supervisor instructions were applied.' : ''}`,
    concerns: [],
  };
}
