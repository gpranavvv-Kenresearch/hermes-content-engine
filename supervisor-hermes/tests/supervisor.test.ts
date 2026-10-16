import { describe, expect, it } from 'vitest';
import { RunLimits } from '../src/limits.js';
import { Supervisor, extractJson, type DecideInput } from '../src/supervisor.js';

const input: DecideInput = { gate: 'draft', reports: [], material: 'DRAFT TEXT', history: [], limitsNote: 'regenerations left: 2' };
const ok = JSON.stringify({ gate: 'draft', action: 'proceed', reason: 'specific and supported' });

describe('extractJson', () => {
  it('finds the first balanced object inside prose and fences', () => {
    expect(extractJson('Sure.\n```json\n{"a":1}\n```\nthanks {"b":2}')).toEqual({ a: 1 });
  });
  it('handles braces inside strings', () => {
    expect(extractJson('{"reason":"use {x} here","n":1}')).toEqual({ reason: 'use {x} here', n: 1 });
  });
  it('throws when there is no object', () => {
    expect(() => extractJson('no json')).toThrow();
  });
});

describe('Supervisor.decide', () => {
  it('returns a valid decision', async () => {
    const s = new Supervisor(async () => `Here you go: ${ok}`, 'ROLE', new RunLimits());
    const out = await s.decide(input);
    expect(out.failedClosed).toBe(false);
    expect(out.decision.action).toBe('proceed');
  });
  it('sends the role, the gate, the material and the history in the prompt', async () => {
    let seen = '';
    const s = new Supervisor(
      async (p) => {
        seen = p;
        return ok;
      },
      'ROLE TEXT',
      new RunLimits(),
    );
    await s.decide({ ...input, history: [{ gate: 'draft', action: 'retry', reason: 'enough facts', instructions: 'Remove the unsupported ranking.', concerns: ['Keep both questions.'] }] });
    expect(seen).toContain('ROLE TEXT');
    expect(seen).toContain('draft');
    expect(seen).toContain('DRAFT TEXT');
    expect(seen).toContain('enough facts');
    expect(seen).toContain('Required corrections: Remove the unsupported ranking.');
    expect(seen).toContain('Checklist findings: Keep both questions.');
  });
  it('fails closed on invalid JSON, wrong gate, unknown action and Hermes errors', async () => {
    const cases = [
      async () => 'not json',
      async () => JSON.stringify({ gate: 'final', action: 'proceed', reason: 'x' }),
      async () => JSON.stringify({ gate: 'draft', action: 'approve', reason: 'x' }),
      async (): Promise<string> => {
        throw new Error('Hermes timed out');
      },
    ];
    for (const ask of cases) {
      const out = await new Supervisor(ask, 'ROLE', new RunLimits()).decide(input);
      expect(out.failedClosed).toBe(true);
      expect(out.decision.action).toBe('stop');
    }
  });
  it('fails closed when the Hermes call budget is spent, without calling Hermes', async () => {
    const limits = new RunLimits({ maxHermesCalls: 0 });
    let called = false;
    const out = await new Supervisor(
      async () => {
        called = true;
        return ok;
      },
      'ROLE',
      limits,
    ).decide(input);
    expect(called).toBe(false);
    expect(out.failedClosed).toBe(true);
  });
});
