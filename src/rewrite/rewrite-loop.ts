import type { LoadedConfig } from '../config/index.js';
import { parseModelOutput, type LlmProvider, type ParseOutcome } from '../contracts.js';
import { BudgetExceededError, ShutdownError } from '../errors.js';
import type { Budget } from '../safety/budget.js';
import type { ShutdownController } from '../safety/shutdown.js';
import type { Fact, PlatformId, ValidationIssue, ValidationReport } from '../schemas/index.js';
import { applyFixers, DEFAULT_FIXERS, type Fixer } from '../validation/fixers.js';
import { classifyOutcome } from '../validation/validate-draft.js';
import { buildRewritePrompt } from './rewrite-prompt.js';

export interface GeneratedText {
  text: string;
  factIds: string[];
}

export type AttemptKind = 'initial' | 'rewrite' | 'fixer';

export interface Attempt {
  index: number;
  kind: AttemptKind;
  /** 0 for the initial text; otherwise the rewrite round that produced it. */
  round: number;
  /** The text of this attempt ('' when the model reply was unusable). */
  text: string;
  /** null when the attempt produced no text to validate (incomplete reply, parse failure, provider error). */
  report: ValidationReport | null;
  factIds: string[];
  /** Ids of deterministic fixers that changed the text (kind 'fixer'). */
  fixes?: string[];
  /** Why the attempt was unusable or rejected. */
  failure?: string;
  /** True when this attempt's text became the working text. */
  adopted: boolean;
}

export type RewriteStatus = 'approved' | 'needs_human';

export interface RewriteResult {
  status: RewriteStatus;
  reason: string;
  /** Best working text (the last adopted one). null only if the initial generation itself failed. */
  text: string | null;
  factIds: string[];
  finalReport: ValidationReport | null;
  attempts: Attempt[];
  /** LLM rewrite rounds started (each consumes one round whether or not it produced usable text). */
  rounds: number;
}

export interface LoopLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

export interface RewriteLoopOptions {
  initial: () => Promise<GeneratedText>;
  provider: LlmProvider;
  /** Validate a text. The loop never inspects the text itself, only the report. */
  validate: (text: string) => ValidationReport | Promise<ValidationReport>;
  facts: readonly Fact[];
  platform: PlatformId;
  config: LoadedConfig;
  /** Hard bound on LLM rewrite rounds. Must be a positive integer. */
  maxRounds: number;
  budget?: Budget;
  shutdown?: ShutdownController;
  logger?: LoopLogger;
  /** Ken Research report URL to keep in the text (UTM applied by the prompt). */
  sourceUrl?: string;
  fixers?: readonly Fixer[];
  humanCodes?: ReadonlySet<string>;
  /** Reply parser. Default: strict parseModelOutput. Pass parseModelOutputLenient for small/free models. */
  parse?: (raw: string) => ParseOutcome;
  /** Token cap forwarded to the provider on rewrite calls. */
  maxOutputTokens?: number;
  /** Post layout id the rewrite must keep. */
  layout?: string;
  /** Source notes shown to the model in rewrite prompts. */
  notes?: readonly { id: string; text: string; tier?: string }[];
  supervisorInstructions?: string;
}

function hardCodes(report: ValidationReport): Set<string> {
  return new Set(report.issues.filter((i) => i.severity === 'hard_fail').map((i) => i.code));
}

function stopReason(e: unknown): string | null {
  if (e instanceof BudgetExceededError) return `budget_exceeded: ${e.message}`;
  if (e instanceof ShutdownError) return `shutdown: ${e.message}`;
  return null;
}

/**
 * generate -> deterministic fixers -> validate -> (LLM rewrite from the exact
 * failures -> fixers -> validate)* with a hard round bound. Never loops
 * forever and never retries blindly: each rewrite prompt lists the specific
 * problems of the current text.
 *
 * A rewrite is REJECTED (not adopted) when it introduces a competitor mention,
 * or introduces new hard failures without reducing the number of distinct
 * failing codes. An incomplete reply or a reply that does not parse counts as
 * a failed attempt and is never treated as content.
 */
export async function runRewriteLoop(opts: RewriteLoopOptions): Promise<RewriteResult> {
  if (!Number.isInteger(opts.maxRounds) || opts.maxRounds < 0) {
    throw new RangeError('maxRounds must be a non-negative integer');
  }
  const fixers = opts.fixers ?? DEFAULT_FIXERS;
  const attempts: Attempt[] = [];
  const push = (a: Omit<Attempt, 'index'>): Attempt => {
    const full = { ...a, index: attempts.length };
    attempts.push(full);
    return full;
  };
  const log = (level: 'info' | 'warn', obj: Record<string, unknown>, msg: string): void => opts.logger?.[level](obj, msg);

  let rounds = 0;
  let current: { text: string; factIds: string[]; report: ValidationReport } | null = null;
  const finish = (status: RewriteStatus, reason: string): RewriteResult => {
    log(status === 'approved' ? 'info' : 'warn', { status, reason, rounds }, 'rewrite loop finished');
    return {
      status,
      reason,
      text: current?.text ?? null,
      factIds: current?.factIds ?? [],
      finalReport: current?.report ?? null,
      attempts,
      rounds,
    };
  };

  /** Runs fixers on `text`; records a 'fixer' attempt when something changed. */
  const fixAndValidate = async (
    text: string,
    report: ValidationReport,
    factIds: string[],
    round: number,
  ): Promise<{ text: string; report: ValidationReport }> => {
    const fixed = applyFixers(text, { platform: opts.platform, config: opts.config }, fixers);
    if (fixed.applied.length === 0) return { text, report };
    const fixedReport = await opts.validate(fixed.text);
    push({ kind: 'fixer', round, text: fixed.text, report: fixedReport, factIds, fixes: fixed.applied.map((a) => a.id), adopted: false });
    return { text: fixed.text, report: fixedReport };
  };

  // --- initial -----------------------------------------------------------------
  let generated: GeneratedText;
  try {
    generated = await opts.initial();
  } catch (e) {
    const reason = stopReason(e);
    if (reason) return finish('needs_human', reason);
    throw e;
  }
  const initialReport = await opts.validate(generated.text);
  push({ kind: 'initial', round: 0, text: generated.text, report: initialReport, factIds: generated.factIds, adopted: true });
  const fixedInitial = await fixAndValidate(generated.text, initialReport, generated.factIds, 0);
  const lastFixer = attempts[attempts.length - 1]!;
  if (lastFixer.kind === 'fixer') lastFixer.adopted = true;
  current = { text: fixedInitial.text, factIds: generated.factIds, report: fixedInitial.report };

  let carried: ValidationIssue[] = [];
  const notes: string[] = [];

  // --- rewrite rounds ------------------------------------------------------------
  for (;;) {
    const outcome = classifyOutcome(current.report, opts.humanCodes ? { humanCodes: opts.humanCodes } : {});
    if (outcome === 'pass') return finish('approved', 'passed validation');
    if (outcome === 'needs_human') {
      return finish('needs_human', `human required: ${[...hardCodes(current.report)].join(', ')}`);
    }
    if (rounds >= opts.maxRounds) {
      return finish('needs_human', `rewrite rounds exhausted (${opts.maxRounds}); still failing: ${[...hardCodes(current.report)].join(', ')}`);
    }

    try {
      opts.shutdown?.assertRunning();
      opts.budget?.consume();
    } catch (e) {
      const reason = stopReason(e);
      if (reason) return finish('needs_human', reason);
      throw e;
    }
    rounds++;

    const hard = current.report.issues.filter((i) => i.severity === 'hard_fail');
    const issues = [...hard, ...carried.filter((c) => !hard.some((h) => h.code === c.code))];
    const prompt = buildRewritePrompt({
      text: current.text,
      issues,
      facts: opts.facts,
      platform: opts.platform,
      config: opts.config,
      ...(opts.sourceUrl !== undefined ? { sourceUrl: opts.sourceUrl } : {}),
      ...(opts.layout !== undefined ? { layout: opts.layout } : {}),
      ...(opts.notes && opts.notes.length > 0 ? { sourceNotes: opts.notes } : {}),
      notes,
      ...(opts.supervisorInstructions ? { supervisorInstructions: opts.supervisorInstructions } : {}),
    });
    notes.length = 0;
    log('info', { round: rounds, codes: [...hardCodes(current.report)] }, 'rewrite round');

    let reply;
    try {
      reply = await opts.provider.generate({
        prompt,
        purpose: 'rewrite',
        expectLong: true,
        ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      });
    } catch (e) {
      const reason = stopReason(e);
      if (reason) return finish('needs_human', reason);
      push({ kind: 'rewrite', round: rounds, text: '', report: null, factIds: [], failure: `provider_error: ${(e as Error).message}`, adopted: false });
      notes.push('The previous attempt failed to return a reply; answer again in the required format.');
      continue;
    }

    if (!reply.complete) {
      push({ kind: 'rewrite', round: rounds, text: '', report: null, factIds: [], failure: 'incomplete_reply', adopted: false });
      notes.push('Your previous reply was cut off. Reply again, completely, ending with the end marker.');
      continue;
    }
    const parsed = (opts.parse ?? parseModelOutput)(reply.text);
    if (!parsed.ok) {
      push({ kind: 'rewrite', round: rounds, text: '', report: null, factIds: [], failure: `parse_failure: ${parsed.reason}`, adopted: false });
      notes.push(`Your previous reply could not be parsed (${parsed.reason}). Use exactly the required output format.`);
      continue;
    }

    const candidateText = parsed.output.text;
    const candidateFactIds = parsed.output.factIds;
    const candidateReport = await opts.validate(candidateText);
    const rewriteAttempt = push({ kind: 'rewrite', round: rounds, text: candidateText, report: candidateReport, factIds: candidateFactIds, adopted: false });
    const fixed = await fixAndValidate(candidateText, candidateReport, candidateFactIds, rounds);
    const fixerAttempt = fixed.text !== candidateText ? attempts[attempts.length - 1]! : null;

    const before = hardCodes(current.report);
    const after = hardCodes(fixed.report);
    const introduced = [...after].filter((c) => !before.has(c));
    const rejected = introduced.includes('COMPETITOR_MENTION') || (introduced.length > 0 && after.size >= before.size);
    if (rejected) {
      const failure = `rejected: introduced ${introduced.join(', ')}`;
      (fixerAttempt ?? rewriteAttempt).failure = failure;
      carried = fixed.report.issues.filter((i) => i.severity === 'hard_fail' && introduced.includes(i.code));
      notes.push('Your previous rewrite introduced new problems (listed below); that rewrite was discarded. Revise the CURRENT TEXT again.');
      continue;
    }

    (fixerAttempt ?? rewriteAttempt).adopted = true;
    carried = [];
    current = { text: fixed.text, factIds: candidateFactIds, report: fixed.report };
  }
}
