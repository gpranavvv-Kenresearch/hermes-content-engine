import type { BlogDecision, BlogGate } from './types.js';

export interface BlogGateFacts {
  gate: BlogGate;
  reportPageLoaded: boolean;
  /** Structural garbage found by code (no H1, fewer than 3 H2s, unfilled template, and so on). */
  hardFails: readonly string[];
  revisionsLeft: number;
  regenerationsLeft: number;
}

export interface BlogGateOutcome {
  decision: BlogDecision;
  overridden: boolean;
}

/**
 * Rules the supervisor cannot loosen. They only ever make a decision stricter; the supervisor's own words stay in
 * the reason so the ledger shows what it asked for and why code said otherwise.
 */
export function enforceBlogGate(decision: BlogDecision, facts: BlogGateFacts): BlogGateOutcome {
  const override = (action: BlogDecision['action'], why: string, extra: Partial<BlogDecision> = {}): BlogGateOutcome => ({
    decision: { ...decision, ...extra, action, reason: `${why} (supervisor said ${decision.action}: ${decision.reason})`.slice(0, 800) },
    overridden: true,
  });

  if (facts.gate === 'evidence') {
    if (!facts.reportPageLoaded) return override('stop', 'the report page did not load, so no article may be written for this report');
    if (decision.action !== 'proceed' && decision.action !== 'stop') return override('stop', 'evidence cannot be retried');
  }

  if (facts.gate === 'structure') {
    if (decision.action === 'regenerate') return override('retry', 'the structure gate can only keep or switch the architecture');
  }

  if (facts.gate === 'draft' && decision.action === 'proceed' && facts.hardFails.length > 0) {
    const why = `structural problems found by code: ${facts.hardFails.join('; ')}`;
    const instructions = `${facts.hardFails.map((f, i) => `${i + 1}. Fix: ${f}.`).join(' ')} Change nothing else.`;
    if (facts.revisionsLeft > 0) return override('retry', why, { instructions });
    if (facts.regenerationsLeft > 0) return override('regenerate', why, { instructions });
    return override('stop', why);
  }

  if (facts.gate === 'draft' && decision.action === 'retry' && facts.revisionsLeft <= 0) {
    return facts.regenerationsLeft > 0
      ? override('regenerate', 'no same-chat fix requests are left')
      : override('stop', 'no fix requests or fresh restarts are left');
  }

  if (facts.gate === 'draft' && decision.action === 'regenerate' && facts.regenerationsLeft <= 0) {
    return facts.revisionsLeft > 0 ? override('retry', 'no fresh restarts are left, so the problems go back to the same chat') : override('stop', 'no restarts or fix requests are left');
  }

  if (facts.gate === 'final') {
    if (decision.action === 'retry' || decision.action === 'regenerate') return override('stop', 'the final gate accepts only proceed or stop');
    if (decision.action === 'proceed' && facts.hardFails.length > 0) return override('stop', `structural problems in the final article: ${facts.hardFails.join('; ')}`);
  }

  return { decision, overridden: false };
}
