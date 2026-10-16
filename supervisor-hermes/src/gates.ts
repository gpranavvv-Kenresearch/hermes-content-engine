import type { Decision, Gate } from './types.js';

export const MIN_NOTES = 3;

export interface GateFacts {
  gate: Gate;
  reportPageLoaded: boolean;
  /** Verified figures from 2024 or later (selectBriefFacts). */
  verifiedFigures: number;
  usableNotes: number;
  validatorPassed?: boolean;
  hardFails?: readonly string[];
  retriesLeft: boolean;
}

export interface GateOutcome {
  decision: Decision;
  overridden: boolean;
}

/**
 * Rules the supervisor cannot loosen. They only ever make a decision stricter. The supervisor's own words stay in the
 * reason so the ledger shows what it asked for and why code said otherwise.
 */
export function enforceGate(decision: Decision, facts: GateFacts): GateOutcome {
  const override = (action: Decision['action'], why: string): GateOutcome => ({
    decision: { ...decision, action, reason: `${why} (supervisor said ${decision.action}: ${decision.reason})`.slice(0, 600) },
    overridden: true,
  });

  if (facts.gate === 'evidence') {
    if (!facts.reportPageLoaded) return override('stop', 'report page did not load, so no draft may be written for this report');
    if (facts.verifiedFigures === 0 && facts.usableNotes < MIN_NOTES) return override('stop', `no verified figure and fewer than ${MIN_NOTES} source notes`);
    if (decision.action === 'retry' || decision.action === 'regenerate') return override('stop', 'evidence cannot be retried');
  }

  if ((facts.gate === 'draft' || facts.gate === 'final') && decision.action === 'proceed' && facts.validatorPassed === false) {
    const why = `validator hard fails: ${(facts.hardFails ?? []).join(', ') || 'unspecified'}`;
    return facts.retriesLeft && facts.gate === 'draft' ? override('retry', why) : override('stop', why);
  }

  if (facts.gate === 'final' && (decision.action === 'retry' || decision.action === 'regenerate')) {
    return override('stop', 'the final gate accepts only proceed or stop');
  }

  return { decision, overridden: false };
}
