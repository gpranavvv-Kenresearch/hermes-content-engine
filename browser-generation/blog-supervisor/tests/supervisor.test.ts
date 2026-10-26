import { describe, expect, it } from 'vitest';
import { BlogDecisionSchema, HermesUnavailableError } from '../src/types.js';
import { BlogLimits, BlogSupervisor, buildBlogSupervisorPrompt } from '../src/supervisor.js';

const input = { gate: 'draft' as const, material: 'ARTICLE', history: [], limitsNote: 'n' };
const make = (replies: (string | Error)[], limits = new BlogLimits()) => {
  let i = 0;
  const ask = async () => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    if (r instanceof Error) throw r;
    return r;
  };
  return { sup: new BlogSupervisor(ask, 'ROLE', limits), calls: () => i, limits };
};
const ok = () => 'Sure. {"gate":"draft","action":"retry","reason":"fix it","instructions":"1. Cut paragraph 3."}';

describe('BlogDecisionSchema', () => {
  it('trims over-long free text instead of rejecting it', () => {
    const parsed = BlogDecisionSchema.parse({ gate: 'draft', action: 'retry', reason: 'r'.repeat(2000), concerns: ['c'.repeat(900)] });
    expect(parsed.reason.length).toBe(800);
    expect(parsed.concerns[0]!.length).toBe(400);
  });
  it('still rejects an unknown action or gate', () => {
    expect(() => BlogDecisionSchema.parse({ gate: 'draft', action: 'maybe', reason: 'x' })).toThrow();
    expect(() => BlogDecisionSchema.parse({ gate: 'images', action: 'stop', reason: 'x' })).toThrow();
  });
});

describe('BlogSupervisor', () => {
  it('parses a JSON object out of surrounding prose', async () => {
    const { sup } = make([ok()]);
    const r = await sup.decide(input);
    expect(r.failedClosed).toBe(false);
    expect(r.decision.action).toBe('retry');
    expect(r.decision.instructions).toContain('Cut paragraph 3');
  });
  it('asks once more after an invalid reply', async () => {
    const { sup, calls } = make(['not json', ok()]);
    expect((await sup.decide(input)).decision.action).toBe('retry');
    expect(calls()).toBe(2);
  });
  it('fails closed after two invalid replies', async () => {
    const { sup } = make(['nope', '{"gate":"final","action":"proceed","reason":"x"}']);
    const r = await sup.decide(input);
    expect(r.failedClosed).toBe(true);
    expect(r.decision.action).toBe('stop');
  });
  it('treats an unreachable Hermes as infrastructure, not a verdict on the article', async () => {
    const { sup } = make([new Error('Hermes could not start: ENOENT')]);
    await expect(sup.decide(input)).rejects.toBeInstanceOf(HermesUnavailableError);
  });
  it('stops spending calls at the budget', async () => {
    const limits = new BlogLimits({ maxHermesCalls: 1 });
    const { sup } = make([ok()], limits);
    await sup.decide(input);
    await expect(sup.decide(input)).rejects.toThrow();
  });
  it('builds a prompt with role, gate, limits, history and material', () => {
    const p = buildBlogSupervisorPrompt('ROLE', { ...input, history: [{ gate: 'evidence', action: 'proceed', reason: 'fine', concerns: [] }] });
    expect(p).toContain('ROLE');
    expect(p).toContain('## GATE\ndraft');
    expect(p).toContain('evidence: proceed (fine)');
    expect(p).toContain('ARTICLE');
  });
});
