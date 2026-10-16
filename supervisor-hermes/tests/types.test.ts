import { describe, expect, it } from 'vitest';
import { ACTIONS, DecisionSchema, GATES } from '../src/types.js';

describe('DecisionSchema', () => {
  it('accepts a valid decision and defaults concerns to []', () => {
    const d = DecisionSchema.parse({ gate: 'draft', action: 'regenerate', reason: 'generic wording' });
    expect(d.concerns).toEqual([]);
    expect(d.action).toBe('regenerate');
  });
  it('rejects an unknown action or gate', () => {
    expect(DecisionSchema.safeParse({ gate: 'draft', action: 'approve', reason: 'x' }).success).toBe(false);
    expect(DecisionSchema.safeParse({ gate: 'later', action: 'stop', reason: 'x' }).success).toBe(false);
  });
  it('requires a non-empty reason', () => {
    expect(DecisionSchema.safeParse({ gate: 'final', action: 'stop', reason: '' }).success).toBe(false);
  });
  it('lists the four gates and four actions', () => {
    expect([...GATES]).toEqual(['evidence', 'strategy', 'draft', 'final']);
    expect([...ACTIONS]).toEqual(['proceed', 'retry', 'regenerate', 'stop']);
  });
});
