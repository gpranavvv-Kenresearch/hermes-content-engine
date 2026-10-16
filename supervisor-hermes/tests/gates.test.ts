import { describe, expect, it } from 'vitest';
import { enforceGate, type GateFacts } from '../src/gates.js';
import type { Decision } from '../src/types.js';

const d = (gate: Decision['gate'], action: Decision['action']): Decision => ({ gate, action, reason: 'because', concerns: [] });
const base: GateFacts = { gate: 'evidence', reportPageLoaded: true, verifiedFigures: 2, usableNotes: 5, retriesLeft: true };

describe('enforceGate', () => {
  it('stops when the report page did not load, whatever the supervisor said', () => {
    const out = enforceGate(d('evidence', 'proceed'), { ...base, reportPageLoaded: false });
    expect(out.decision.action).toBe('stop');
    expect(out.overridden).toBe(true);
  });
  it('stops with no figure and fewer than 3 notes', () => {
    expect(enforceGate(d('evidence', 'proceed'), { ...base, verifiedFigures: 0, usableNotes: 2 }).decision.action).toBe('stop');
    expect(enforceGate(d('evidence', 'proceed'), { ...base, verifiedFigures: 0, usableNotes: 3 }).decision.action).toBe('proceed');
  });
  it('turns retry/regenerate at the evidence gate into stop', () => {
    expect(enforceGate(d('evidence', 'retry'), base).decision.action).toBe('stop');
    expect(enforceGate(d('evidence', 'regenerate'), base).decision.action).toBe('stop');
  });
  it('cannot proceed past a validator hard fail: retry while retries remain, else stop', () => {
    const failed = { ...base, gate: 'draft' as const, validatorPassed: false, hardFails: ['THIN_CONTENT'] };
    expect(enforceGate(d('draft', 'proceed'), failed).decision.action).toBe('retry');
    expect(enforceGate(d('draft', 'proceed'), { ...failed, retriesLeft: false }).decision.action).toBe('stop');
  });
  it('lets the supervisor be stricter than the validator', () => {
    const out = enforceGate(d('draft', 'regenerate'), { ...base, gate: 'draft', validatorPassed: true });
    expect(out.decision.action).toBe('regenerate');
    expect(out.overridden).toBe(false);
  });
  it('final gate accepts only proceed or stop', () => {
    expect(enforceGate(d('final', 'retry'), { ...base, gate: 'final', validatorPassed: true }).decision.action).toBe('stop');
    expect(enforceGate(d('final', 'proceed'), { ...base, gate: 'final', validatorPassed: true }).decision.action).toBe('proceed');
  });
  it('keeps the original reasoning visible when it overrides', () => {
    const out = enforceGate(d('evidence', 'proceed'), { ...base, reportPageLoaded: false });
    expect(out.decision.reason).toContain('supervisor said proceed');
  });
});
