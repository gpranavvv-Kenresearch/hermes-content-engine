import { loadTechniques } from '../../../src/repos/techniques.js';
import type { Brief, ContentVariant } from '../../../src/schemas/index.js';
import {
  HOOK_STYLES,
  NUMBERS_FIRST,
  NUMBERED_LAYOUT_PLATFORMS,
  VariationHistory,
  angleById,
  availableAngles,
  buildBrief,
  hookById,
  layoutIdsFor,
  loadStyleExamples,
  mulberry32,
  primaryNotesFor,
  sampleVariant,
  seedFromString,
  selectPersona,
  type StrategyItem,
} from '../../../src/strategy/index.js';
import type { AgentReport, SocialPlatform } from '../types.js';
import type { AgentDeps } from './deps.js';
import path from 'node:path';
import { loadPolicy } from '../../../performance-engine/src/policy.js';
import { selectExperiment } from '../../../performance-engine/src/experiments.js';
import { guidanceRoot, guidanceTechniques, loadPromptGuidance } from '../../../performance-engine/src/guidance.js';
import { usableFacts, type EvidenceOutput } from './evidence.js';

/** Hook formulas that ask for a figure in the opening question (same set the engine uses). */
const FIGURE_HOOKS: ReadonlySet<string> = new Set(['contrast-why', 'sufficiency', 'which-part']);
const CAMPAIGN_ID = 'authority-insights';

export interface StrategyOutput {
  personaId: string;
  personaReason: string;
  brief: Brief;
  variant: ContentVariant;
  styleExamples: string[];
  techniques: string[];
  anglePrompt?: { label: string; instruction: string; primaryNotes: { id: string; text: string }[] };
  hook?: { instruction: string };
  performancePolicyVersion?: string;
  performanceExperimentId?: string;
  performanceGuidanceVersion?: string;
}

export async function runStrategyAgent(
  input: { item: StrategyItem; evidence: EvidenceOutput; platform: SocialPlatform; keyword: string; attempt: number },
  deps: AgentDeps,
): Promise<AgentReport<StrategyOutput>> {
  const { config } = deps;
  const { item, evidence, platform } = input;
  const campaign = config.campaigns.find((c) => c.id === CAMPAIGN_ID);
  if (!campaign || !campaign.active) throw new Error(`unknown or inactive campaign "${CAMPAIGN_ID}"`);
  const selection = selectPersona({ campaign, facts: usableFacts(evidence), itemMeta: { title: item.title } });
  const persona = config.personas.find((p) => p.id === selection.personaId);
  if (!persona) throw new Error(`persona "${selection.personaId}" not found in config`);

  const brief = buildBrief({ item, facts: evidence.facts, campaign, persona, personaReason: selection.reason, now: deps.now(), primaryKeyword: input.keyword });
  const history = await new VariationHistory(deps.store).load();
  const noFigures = evidence.verifiedFigures === 0;
  const angleIds = availableAngles(evidence.notes).filter((a) => !(noFigures && a === NUMBERS_FIRST));
  const hookIds = NUMBERED_LAYOUT_PLATFORMS.includes(platform) ? HOOK_STYLES.map((h) => h.id).filter((id) => !(noFigures && FIGURE_HOOKS.has(id))) : undefined;
  const eligibleLayouts = layoutIdsFor(platform, evidence.notes, usableFacts(evidence));
  const layoutIds = eligibleLayouts.length > 0 ? eligibleLayouts : undefined;
  const accountId = process.env[`PE_ACCOUNT_${platform.toUpperCase()}`];
  const performancePolicy = await loadPolicy(path.resolve(process.env.PE_STATE_DIR ?? 'output/performance-engine/state'), platform, accountId, deps.now());
  const experiment = await selectExperiment(path.resolve(process.env.PE_STATE_DIR ?? 'output/performance-engine/state'), platform, accountId, item.id, deps.now());
  const promptGuidance = await loadPromptGuidance(guidanceRoot(), platform, deps.now());
  const seed = seedFromString(`${item.id}|${platform}|${history.all().length}|${input.attempt}`);
  const variant = sampleVariant({
    campaign,
    itemId: item.id,
    personaId: persona.id,
    platform,
    history,
    rng: mulberry32(seed),
    config,
    angles: angleIds,
    ...(hookIds ? { hookStyles: hookIds } : {}),
    ...(layoutIds ? { layouts: layoutIds } : {}),
    ...(performancePolicy ? { performanceWeights: performancePolicy.weights } : {}),
  });
  await history.record(variant, platform, deps.now());

  const angleDef = variant.angle ? angleById(variant.angle) : undefined;
  const hookDef = variant.hookStyle ? hookById(variant.hookStyle) : undefined;
  const output: StrategyOutput = {
    personaId: persona.id,
    personaReason: selection.reason,
    brief,
    variant,
    styleExamples: platform === 'x' || platform === 'tumblr' ? [] : loadStyleExamples(platform === 'facebook' ? 'config/style-examples/facebook' : 'config/style-examples').examples,
    techniques: [...loadTechniques(platform).items.map((t) => t.text), ...(promptGuidance ? guidanceTechniques(promptGuidance) : []), ...(experiment ? [`Measured experiment ${experiment.id}: ${experiment.hypothesis} This is a writing technique only; keep the selected approved layout and use only supplied report evidence.`] : [])],
    ...(performancePolicy ? { performancePolicyVersion: performancePolicy.version } : {}),
    ...(experiment ? { performanceExperimentId: experiment.id } : {}),
    ...(promptGuidance ? { performanceGuidanceVersion: promptGuidance.version } : {}),
    ...(angleDef
      ? { anglePrompt: { label: angleDef.label, instruction: angleDef.instruction, primaryNotes: primaryNotesFor(angleDef.id, evidence.notes).map((n) => ({ id: n.id, text: n.text })) } }
      : {}),
    ...(hookDef ? { hook: { instruction: hookDef.instruction } } : {}),
  };
  return {
    agent: 'strategy',
    output,
    summary: `Persona ${persona.id} (${selection.reason}); tone ${variant.tone}, angle ${variant.angle ?? 'none'}, hook ${variant.hookStyle ?? 'none'}, layout ${variant.layout ?? 'default'}, opener ${variant.opener}.${promptGuidance ? ` Applied measured prompt guidance ${promptGuidance.version}.` : ''}`,
    concerns: noFigures ? ['no verified figure: the post must be written without numbers'] : [],
  };
}
