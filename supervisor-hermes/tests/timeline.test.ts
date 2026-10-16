import { describe, expect, it } from 'vitest';
import { formatTimeline } from '../src/timeline.js';

describe('formatTimeline', () => {
  it('prints one line per event with the gate decision and any override', () => {
    const out = formatTimeline([
      { at: '2026-10-14T10:00:00.000Z', type: 'agent', agent: 'evidence', data: { summary: 'Report page loaded.' } },
      { at: '2026-10-14T10:00:30.000Z', type: 'decision', gate: 'evidence', data: { final: { action: 'proceed', reason: 'enough facts' }, overridden: false, failedClosed: false } },
      { at: '2026-10-14T10:01:00.000Z', type: 'decision', gate: 'draft', data: { final: { action: 'retry', reason: 'validator hard fails' }, overridden: true, failedClosed: false } },
      { at: '2026-10-14T10:02:00.000Z', type: 'result', data: { status: 'needs_human', reason: 'draft gate: stop' } },
    ]);
    expect(out).toContain('evidence');
    expect(out).toContain('proceed');
    expect(out).toMatch(/draft.*retry.*overridden by code/);
    expect(out).toContain('needs_human');
  });
  it('flags a supervisor that failed closed', () => {
    const out = formatTimeline([{ at: '2026-10-14T10:00:00.000Z', type: 'decision', gate: 'final', data: { final: { action: 'stop', reason: 'x' }, overridden: false, failedClosed: true } }]);
    expect(out).toContain('supervisor failed closed');
  });
  it('says so for an empty run', () => {
    expect(formatTimeline([])).toContain('no events');
  });
});
