import { ShutdownError } from '../../src/errors.js';
import { layoutSection, platformSection } from '../../src/strategy/prompts/common.js';
import type { AgentDeps } from './agents/deps.js';
import { runEvidenceAgent, usableFacts, type EvidenceOutput } from './agents/evidence.js';
import { runLearningAgent } from './agents/learning.js';
import { writeRowAgent, type SheetPickOutput } from './agents/sheet.js';
import { runStrategyAgent, type StrategyOutput } from './agents/strategy.js';
import { saveGenerationHandoff } from '../../performance-engine/src/metadata.js';
import { runValidatorAgent, saveApprovedDraft, type ValidatorOutput } from './agents/validator.js';
import { runWriterAgent } from './agents/writer.js';
import { MIN_NOTES, enforceGate, type GateFacts } from './gates.js';
import type { Ledger } from './ledger.js';
import type { DecideInput, SupervisorResult } from './supervisor.js';
import type { AgentReport, Decision, Gate, RowResult, SocialPlatform } from './types.js';

export interface Agents {
  evidence: typeof runEvidenceAgent;
  strategy: typeof runStrategyAgent;
  writer: typeof runWriterAgent;
  validator: typeof runValidatorAgent;
  learning: typeof runLearningAgent;
  write: typeof writeRowAgent;
}

export const realAgents: Agents = {
  evidence: runEvidenceAgent,
  strategy: runStrategyAgent,
  writer: runWriterAgent,
  validator: runValidatorAgent,
  learning: runLearningAgent,
  write: writeRowAgent,
};

export interface RowJob {
  pick: SheetPickOutput;
  platform: SocialPlatform;
  writeSheet: boolean;
  supplementary: 'off' | 'ken-gov' | 'all';
}

export interface RowContext {
  deps: AgentDeps;
  supervisor: { decide(input: DecideInput): Promise<SupervisorResult> };
  ledger: Ledger;
  agents?: Agents;
  runId: string;
}

export const MIN_USEFUL_WORDS: Record<SocialPlatform, number> = { x: 12, facebook: 95, linkedin: 110, tumblr: 40 };

function factLines(ev: EvidenceOutput): string[] {
  return usableFacts(ev).map((f) => `- [${f.id}] ${f.metric}: ${f.value} ${f.unit} (${f.period}, ${f.geography ?? 'n/a'}) [${f.verificationStatus}]${f.marketDefinition ? ` Market: ${f.marketDefinition}.` : ''}${f.sourceTier ? ` Source: ${f.sourceTier}, ${f.sourceName ?? f.sourceTitle}.` : ''}`);
}

function evidenceMaterial(ev: EvidenceOutput): string {
  const notes = ev.notes.map((n) => `- [${n.id}] ${n.text}${n.tier === 'other' ? ' [neutral background only; never attribute to Ken Research]' : ''}`);
  return [
    `Mode: ${ev.mode}. Report page loaded: ${ev.reportPageLoaded}${ev.error ? ` (${ev.error})` : ''}.`,
    `Verified figures: ${ev.verifiedFigures}. Source notes: ${ev.notes.length}.`,
    `Sources: ${ev.sources.join(', ')}`,
    'FACTS:',
    ...(factLines(ev).length ? factLines(ev) : ['- none']),
    'NOTES:',
    ...(notes.length ? notes : ['- none']),
  ].join('\n');
}

function draftVerdict(v: ValidatorOutput, d: Decision): string {
  return [
    `VALIDATOR: ${v.passed ? 'passed' : 'FAILED'} | score ${v.score === null ? 'n/a' : Math.round(v.score * 100)}/100 | rewrite rounds ${v.rewriteRounds}`,
    `Hard fails: ${v.hardFails.join(', ') || 'none'}`,
    `Review notes: ${v.reviewCodes.join(', ') || 'none'}`,
    '',
    `SUPERVISOR (draft gate): ${d.action}`,
    `Reason: ${d.reason}`,
    `Instructions: ${d.instructions ?? '-'}`,
    `Concerns: ${d.concerns.join('; ') || '-'}`,
    '',
  ].join('\n');
}

/** The strategy summary alone says nothing about fit, so the supervisor also reads the evidence the strategy will steer. */
function strategyMaterial(summary: string, ev: EvidenceOutput): string {
  return `STRATEGY CHOSEN:\n${summary}\n\nEVIDENCE THE WRITER WILL BE LIMITED TO:\n${evidenceMaterial(ev)}`;
}

function draftMaterial(v: ValidatorOutput, ev: EvidenceOutput, houseFormat: string): string {
  return [
    `FINAL DRAFT:\n${v.text || '(no usable text)'}`,
    `\nVALIDATOR: ${v.passed ? 'passed' : 'FAILED'}. Hard fails: ${v.hardFails.join(', ') || 'none'}. Review notes: ${v.reviewCodes.join(', ') || 'none'}. Score: ${v.score === null ? 'n/a' : Math.round(v.score * 100)}/100.`,
    `\nHOUSE FORMAT (accept this format; do not replace it):\n${houseFormat}`,
    `\nEVIDENCE (the only allowed facts):\n${evidenceMaterial(ev)}`,
  ].join('\n');
}

/**
 * One Sheet row through every agent. Each gate asks the supervisor, then code rules (gates.ts) can only make the answer
 * stricter. Nothing here throws for a bad row: an unexpected error becomes needs_human so a batch survives it.
 */
export async function processRow(job: RowJob, ctx: RowContext): Promise<RowResult> {
  const agents = ctx.agents ?? realAgents;
  const { deps, ledger, runId } = ctx;
  const { pick, platform } = job;
  const decisions: Decision[] = [];
  const corrections = new Set<string>();
  let totalRetries = 0;
  let draftNo = 0;
  const base = { rowIndex: pick.rowIndex, url: pick.url, title: pick.title, keyword: pick.keyword, platform };
  let itemId = '';
  let noEvidence = false;
  let lastValidator: AgentReport<ValidatorOutput> | undefined;
  let lastStrategy: StrategyOutput | undefined;

  const control = (message: string): Promise<void> => ledger.append({ type: 'control', data: { message } });
  const track = async <T>(report: AgentReport<T>): Promise<AgentReport<T>> => {
    if (report.agent === 'strategy') lastStrategy = report.output as StrategyOutput;
    await ledger.append({ type: 'agent', agent: report.agent, data: { summary: report.summary, concerns: report.concerns } });
    return report;
  };
  /**
   * Every exit goes through here. Once a draft has been validated, the learning agent records the run with its REAL status
   * (needs_human rows teach the writer what failed), and only an approved text is remembered as "recent" for duplicate checks.
   */
  const finish = async (status: RowResult['status'], reason: string, text: string | null = null, score: number | null = null, written: RowResult['written'] = null): Promise<RowResult> => {
    if (lastValidator) {
      try {
        await track(await agents.learning({ runId, platform, keyword: pick.keyword, validator: lastValidator.output, status, reason }, deps));
      } catch (error) {
        await control(`learning failed: ${(error as Error).message}`);
      }
    }
    if (status === 'approved' && text) {
      try {
        await saveApprovedDraft(deps, itemId, platform, text);
        if (lastStrategy) await saveGenerationHandoff(deps.store, { runId, platform, reportUrl: pick.url, text, variant: lastStrategy.variant, at: deps.now(), policyVersion: lastStrategy.performancePolicyVersion, experimentId: lastStrategy.performanceExperimentId });
      } catch (error) {
        await control(`could not remember the approved draft: ${(error as Error).message}`);
      }
    }
    const result: RowResult = { ...base, status, reason, text, score, regenerations: deps.limits.regenerations, retries: totalRetries, decisions, written, noEvidence };
    await ledger.append({ type: 'result', data: { status, reason, regenerations: result.regenerations, retries: totalRetries, written } });
    return result;
  };
  const gate = async (g: Gate, reports: readonly AgentReport<unknown>[], material: string, facts: Omit<GateFacts, 'gate' | 'retriesLeft'>): Promise<Decision> => {
    const l = deps.limits;
    const limitsNote = `regenerations left: ${l.regenerationsLeft}; retries left: ${l.retriesLeft}; Hermes calls left: ${l.calls.remaining}`;
    const platformRules = [platformSection(deps.config, platform), ...(platform === 'x' || platform === 'tumblr' ? [layoutSection(deps.config, platform)!] : [])].join('\n');
    const res = await ctx.supervisor.decide({ gate: g, reports, material: g === 'evidence' || g === 'strategy' ? `${platformRules}\n\n${material}` : material, history: decisions, limitsNote });
    const outcome = enforceGate(res.decision, { ...facts, gate: g, retriesLeft: l.canRetry() });
    await ledger.append({ type: 'decision', gate: g, data: { requested: res.decision, final: outcome.decision, overridden: outcome.overridden, failedClosed: res.failedClosed } });
    decisions.push(outcome.decision);
    const d = outcome.decision;
    if (d.instructions?.trim()) corrections.add(d.instructions.trim());
    for (const concern of d.concerns) corrections.add(concern);
    if ((d.action === 'retry' || d.action === 'regenerate') && !d.instructions?.trim()) corrections.add(d.reason);
    return outcome.decision;
  };

  try {
    // --- gate 1: evidence -------------------------------------------------------------------
    const evReport = await track(await agents.evidence({ url: pick.url, title: pick.title, supplementary: job.supplementary }, deps));
    const ev = evReport.output;
    // Preserve the exact evidence used by all agents for later audits.
    try {
      await ledger.saveEvidence(ev);
    } catch (error) {
      await control(`could not save evidence: ${(error as Error).message}`);
    }
    itemId = ev.itemId;
    const evFacts = { reportPageLoaded: ev.reportPageLoaded, verifiedFigures: ev.verifiedFigures, usableNotes: ev.notes.length };
    const d1 = await gate('evidence', [evReport], evidenceMaterial(ev), evFacts);
    if (d1.action !== 'proceed') {
      // Only a real lack of evidence makes the row skippable; a supervisor that merely failed or disagreed does not.
      noEvidence = !ev.reportPageLoaded || (ev.verifiedFigures === 0 && ev.notes.length < MIN_NOTES);
      return await finish('needs_human', `evidence gate: ${d1.reason}`);
    }

    const item = { id: ev.itemId, title: pick.title, reportUrl: pick.url };
    let attempt = 0;
    let validatorReport: AgentReport<ValidatorOutput> | undefined;
    let houseFormat = '';

    outer: for (;;) {
      // --- gate 2: strategy -----------------------------------------------------------------
      let strat = await track(await agents.strategy({ item, evidence: ev, platform, keyword: pick.keyword, attempt }, deps));
      let dS = await gate('strategy', [evReport, strat], strategyMaterial(strat.summary, ev), evFacts);
      while (dS.action === 'retry') {
        if (!deps.limits.canRetry()) return await finish('needs_human', `strategy gate: retries exhausted (${dS.reason})`);
        deps.limits.useRetry();
        totalRetries++;
        attempt++;
        strat = await track(await agents.strategy({ item, evidence: ev, platform, keyword: pick.keyword, attempt }, deps));
        dS = await gate('strategy', [evReport, strat], strategyMaterial(strat.summary, ev), evFacts);
      }
      if (dS.action === 'stop') return await finish('needs_human', `strategy gate: ${dS.reason}`);
      if (dS.action === 'regenerate') {
        if (!deps.limits.canRegenerate()) return await finish('needs_human', `strategy gate: regenerations exhausted (${dS.reason})`);
        deps.limits.useRegeneration();
        deps.limits.resetRetries();
        attempt++;
        await control(`regenerate after strategy gate: ${dS.reason}`);
        continue outer;
      }

      // --- gate 3: draft (writer + validator) -----------------------------------------------
      // What the supervisor said about the strategy cannot change the strategy agent's deterministic choices,
      // but it can steer the draft: its instructions and concerns go to the writer.
      houseFormat = [layoutSection(deps.config, platform, strat.output.variant.layout), platformSection(deps.config, platform)].filter(Boolean).join('\n');
      let previousDraft: string | undefined;
      for (;;) {
        const writerInstructions = corrections.size ? [...corrections].map((c) => `- ${c}`).join('\n') : undefined;
        let written: Awaited<ReturnType<Agents['writer']>>;
        try {
          written = await track(await agents.writer({ item, evidence: ev, strategy: strat.output, platform, ...(writerInstructions ? { instructions: writerInstructions } : {}), ...(previousDraft ? { previousDraft } : {}) }, deps));
        } catch (error) {
          const message = (error as Error).message;
          if (error instanceof ShutdownError) throw error;
          await control(`writer failed: ${message}`);
          if (deps.limits.canRetry()) {
            deps.limits.useRetry();
            totalRetries++;
            continue;
          }
          return await finish('needs_human', `writer failed and retries are exhausted: ${message}`);
        }
        const vReport = await track(
          await agents.validator({ item, evidence: ev, strategy: strat.output, draft: written.output, platform, keyword: pick.keyword, minUsefulWords: MIN_USEFUL_WORDS[platform], ...(writerInstructions ? { instructions: writerInstructions } : {}) }, deps),
        );
        lastValidator = vReport;
        const dD = await gate('draft', [evReport, strat, written, vReport], draftMaterial(vReport.output, ev, houseFormat), {
          ...evFacts,
          validatorPassed: vReport.output.passed,
          hardFails: vReport.output.hardFails,
        });
        // Keep every draft and why it was accepted or rejected, so a rejected post can be read later.
        draftNo++;
        try {
          await ledger.saveDraft(draftNo, vReport.output.text || written.output.text, draftVerdict(vReport.output, dD));
        } catch (error) {
          await control(`could not save draft ${draftNo}: ${(error as Error).message}`);
        }
        if (dD.action === 'proceed') {
          validatorReport = vReport;
          break outer;
        }
        if (dD.action === 'retry') {
          if (!deps.limits.canRetry()) return await finish('needs_human', `draft gate: retries exhausted (${dD.reason})`);
          deps.limits.useRetry();
          totalRetries++;
          previousDraft = vReport.output.markdown || written.output.text;
          continue;
        }
        if (dD.action === 'regenerate') {
          if (!deps.limits.canRegenerate()) return await finish('needs_human', `draft gate: regenerations exhausted (${dD.reason})`);
          deps.limits.useRegeneration();
          deps.limits.resetRetries();
          attempt++;
          await control(`regenerate after draft gate: ${dD.reason}`);
          continue outer;
        }
        return await finish('needs_human', `draft gate: ${dD.reason}`, vReport.output.text || null, vReport.output.score);
      }
    }

    // --- gate 4: final (the learning agent runs inside finish, with the real status) --------
    const v = validatorReport!.output;
    const dF = await gate('final', [validatorReport!], draftMaterial(v, ev, houseFormat), {
      ...evFacts,
      validatorPassed: v.passed,
      hardFails: v.hardFails,
    });
    if (dF.action !== 'proceed') return await finish('needs_human', `final gate: ${dF.reason}`, v.text, v.score);

    // --- Sheet write: only after every gate, only when asked ---------------------------------
    let written: RowResult['written'] = null;
    if (job.writeSheet) {
      try {
        const w = await track(await agents.write(deps.sheets, platform, pick, v.text));
        written = w.output;
        if (!w.output.verified) return await finish('needs_human', `Sheet read-back mismatch at ${w.output.cell}`, v.text, v.score, written);
      } catch (error) {
        return await finish('needs_human', `Sheet not written: ${(error as Error).message}`, v.text, v.score);
      }
    }
    return await finish('approved', v.reason, v.text, v.score, written);
  } catch (error) {
    if (error instanceof ShutdownError) throw error;
    const message = (error as Error).message;
    await control(`crashed: ${message}`);
    return finish('needs_human', `crashed: ${message}`);
  }
}
