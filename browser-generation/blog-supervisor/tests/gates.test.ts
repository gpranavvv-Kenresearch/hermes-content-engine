import { describe, expect, it } from 'vitest';
import { enforceBlogGate } from '../src/gates.js';
import type { BlogDecision } from '../src/types.js';

const d = (gate: BlogDecision['gate'], action: BlogDecision['action'], extra: Partial<BlogDecision> = {}): BlogDecision => ({ gate, action, reason: 'because', concerns: [], ...extra });
const facts = (gate: BlogDecision['gate'], over: Record<string, unknown> = {}) => ({ gate, reportPageLoaded: true, hardFails: [] as string[], revisionsLeft: 3, regenerationsLeft: 1, ...over });

describe('enforceBlogGate', () => {
  it('stops when the report page did not load, whatever the supervisor said', () => {
    const out = enforceBlogGate(d('evidence', 'proceed'), facts('evidence', { reportPageLoaded: false }));
    expect(out.decision.action).toBe('stop');
    expect(out.overridden).toBe(true);
  });
  it('evidence cannot be retried', () => {
    expect(enforceBlogGate(d('evidence', 'retry'), facts('evidence')).decision.action).toBe('stop');
  });
  it('structure gate cannot regenerate; it becomes a retry', () => {
    expect(enforceBlogGate(d('structure', 'regenerate'), facts('structure')).decision.action).toBe('retry');
  });
  it('turns proceed into a same-chat fix when code found structural problems', () => {
    const out = enforceBlogGate(d('draft', 'proceed'), facts('draft', { hardFails: ['2 tables'] }));
    expect(out.decision.action).toBe('retry');
    expect(out.decision.instructions).toContain('2 tables');
  });
  it('falls back to a fresh chat, then to stop, when fix requests run out', () => {
    expect(enforceBlogGate(d('draft', 'proceed'), facts('draft', { hardFails: ['x'], revisionsLeft: 0 })).decision.action).toBe('regenerate');
    expect(enforceBlogGate(d('draft', 'proceed'), facts('draft', { hardFails: ['x'], revisionsLeft: 0, regenerationsLeft: 0 })).decision.action).toBe('stop');
    expect(enforceBlogGate(d('draft', 'retry'), facts('draft', { revisionsLeft: 0, regenerationsLeft: 0 })).decision.action).toBe('stop');
    expect(enforceBlogGate(d('draft', 'regenerate'), facts('draft', { regenerationsLeft: 0 })).decision.action).toBe('retry');
  });
  it('lets a clean draft through unchanged', () => {
    const out = enforceBlogGate(d('draft', 'proceed'), facts('draft'));
    expect(out.overridden).toBe(false);
    expect(out.decision.action).toBe('proceed');
  });
  it('final gate accepts only proceed or stop, and never proceeds past structural problems', () => {
    expect(enforceBlogGate(d('final', 'retry'), facts('final')).decision.action).toBe('stop');
    expect(enforceBlogGate(d('final', 'regenerate'), facts('final')).decision.action).toBe('stop');
    expect(enforceBlogGate(d('final', 'proceed'), facts('final', { hardFails: ['1 unresolved image placeholder(s)'] })).decision.action).toBe('stop');
  });
});
