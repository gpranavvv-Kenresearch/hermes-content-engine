import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/store.js';
import { config, sampleFact } from '../../tests/fixtures/validation/helpers.js';
import type { AgentDeps } from '../src/agents/deps.js';
import type { EvidenceOutput } from '../src/agents/evidence.js';
import { Ledger } from '../src/ledger.js';
import { RunLimits } from '../src/limits.js';
import { processRow, type Agents } from '../src/orchestrator.js';
import type { DecideInput } from '../src/supervisor.js';
import type { AgentReport, Decision } from '../src/types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const pick = { rowIndex: 5, url: 'https://www.kenresearch.com/industry-reports/x', title: 'X Market', keyword: 'x market' };
const evidence: AgentReport<EvidenceOutput> = {
  agent: 'evidence' as const,
  summary: 's',
  concerns: [],
  output: { itemId: 'i', reportPageLoaded: true, facts: [], notes: [], mode: 'figures' as const, verifiedFigures: 2, sources: [pick.url] },
};
const strategy = {
  agent: 'strategy' as const,
  summary: 's',
  concerns: [],
  output: { personaId: 'cxo', personaReason: 'r', brief: {} as never, variant: { layout: 'bullet-insights' } as never, styleExamples: [], techniques: [] },
};
const writer = (text = 'draft') => ({ agent: 'writer' as const, summary: 's', concerns: [], output: { text, factIds: [], promptVersion: 'v' } });
const validator = (passed: boolean) => ({
  agent: 'validator' as const,
  summary: 's',
  concerns: [],
  output: {
    passed,
    status: passed ? ('approved' as const) : ('needs_human' as const),
    reason: 'r',
    text: 'final text',
    markdown: 'final text',
    hardFails: passed ? [] : ['THIN_CONTENT'],
    reviewCodes: [],
    score: 0.8,
    rewriteRounds: 0,
    attempts: [],
  },
});
const learning = { agent: 'learning' as const, summary: 's', concerns: [], output: { newLessons: [], hermesMemory: 'not applicable' } };

function setup(script: Array<Decision['action']>, opts: { validators?: boolean[]; evidenceOverride?: typeof evidence } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'orch-'));
  dirs.push(root);
  const gatesSeen: string[] = [];
  let i = 0;
  const supervisor = {
    async decide(input: DecideInput) {
      gatesSeen.push(input.gate);
      const action = script[i++] ?? 'stop';
      return {
        decision: { gate: input.gate, action, reason: 'scripted', instructions: action === 'proceed' ? undefined : 'be more specific', concerns: [] } as Decision,
        failedClosed: false,
      };
    },
  };
  const validators = [...(opts.validators ?? [true])];
  const writes: string[] = [];
  const learnCalls: string[] = [];
  const agents: Agents = {
    evidence: async () => opts.evidenceOverride ?? evidence,
    strategy: async () => strategy,
    writer: async () => writer(),
    validator: async () => validator(validators.shift() ?? true),
    learning: async (input) => {
      learnCalls.push(input.status);
      return learning;
    },
    write: async (_api, _p, _pick, text) => {
      writes.push(text);
      return { agent: 'sheet', summary: 's', concerns: [], output: { cell: 'M5', verified: true } };
    },
  };
  const deps = { config, store: new MemoryStore(), now: () => new Date('2026-10-14T10:00:00Z'), limits: new RunLimits(), sheets: { tab: 't', read: async () => [], writeCell: async () => {} } } as unknown as AgentDeps;
  const ctx = { deps, supervisor, ledger: new Ledger(root, 'run_t'), agents, runId: 'run_t' };
  return { ctx, gatesSeen, writes, learnCalls, root };
}
const job = { pick, platform: 'linkedin' as const, writeSheet: false, supplementary: 'ken-gov' as const };

describe('processRow', () => {
  it('runs all four gates and approves when the supervisor proceeds each time', async () => {
    const { ctx, gatesSeen } = setup(['proceed', 'proceed', 'proceed', 'proceed']);
    const r = await processRow(job, ctx);
    expect(r.status).toBe('approved');
    expect(gatesSeen).toEqual(['evidence', 'strategy', 'draft', 'final']);
    expect(r.text).toBe('final text');
    expect(r.written).toBeNull();
  });
  it('regenerates once when the supervisor rejects the draft, then approves', async () => {
    const { ctx, gatesSeen } = setup(['proceed', 'proceed', 'regenerate', 'proceed', 'proceed', 'proceed']);
    const r = await processRow(job, ctx);
    expect(r.status).toBe('approved');
    expect(r.regenerations).toBe(1);
    expect(gatesSeen).toEqual(['evidence', 'strategy', 'draft', 'strategy', 'draft', 'final']);
  });
  it('ends needs_human when regenerations are exhausted', async () => {
    const { ctx } = setup(['proceed', 'proceed', 'regenerate', 'proceed', 'regenerate', 'proceed', 'regenerate']);
    ctx.deps.limits = new RunLimits({ maxRegenerations: 2 });
    const r = await processRow(job, ctx);
    expect(r.status).toBe('needs_human');
    expect(r.regenerations).toBe(2);
    expect(r.reason).toContain('regenerations exhausted');
  });
  it('code overrides a supervisor proceed when the validator failed: retries the writer', async () => {
    const { ctx } = setup(['proceed', 'proceed', 'proceed', 'proceed', 'proceed'], { validators: [false, true] });
    const r = await processRow(job, ctx);
    expect(r.status).toBe('approved');
    expect(r.retries).toBe(1);
  });
  it('stops at the evidence gate when the report page did not load, without calling later agents', async () => {
    const failed = { ...evidence, output: { ...evidence.output, reportPageLoaded: false, verifiedFigures: 0 } };
    const { ctx, gatesSeen } = setup(['proceed'], { evidenceOverride: failed });
    const r = await processRow(job, ctx);
    expect(r.status).toBe('needs_human');
    expect(gatesSeen).toEqual(['evidence']);
  });
  it('writes the Sheet only when asked and only after the final gate', async () => {
    const a = setup(['proceed', 'proceed', 'proceed', 'proceed']);
    await processRow({ ...job, writeSheet: true }, a.ctx);
    expect(a.writes).toEqual(['final text']);
    const b = setup(['proceed', 'proceed', 'proceed', 'stop']);
    const r = await processRow({ ...job, writeSheet: true }, b.ctx);
    expect(b.writes).toEqual([]);
    expect(r.status).toBe('needs_human');
  });
  it('records the whole run in the ledger', async () => {
    const { ctx, root } = setup(['proceed', 'proceed', 'proceed', 'proceed']);
    await processRow(job, ctx);
    const events = await Ledger.read(root, 'run_t');
    expect(events.filter((e) => e.type === 'decision').length).toBe(4);
    expect(events.some((e) => e.type === 'agent' && e.agent === 'validator')).toBe(true);
    expect(events.at(-1)!.type).toBe('result');
  });
  it('a writer that keeps throwing ends needs_human after the retry limit', async () => {
    const { ctx } = setup(['proceed', 'proceed']);
    ctx.agents!.writer = async () => {
      throw new Error('writer: unparseable reply (missing_end)');
    };
    const r = await processRow(job, ctx);
    expect(r.status).toBe('needs_human');
    expect(r.reason).toContain('unparseable');
    expect(r.retries).toBe(3);
  });
  it('a crash inside an agent becomes needs_human instead of killing the batch', async () => {
    const { ctx } = setup(['proceed']);
    ctx.agents!.evidence = async () => {
      throw new Error('boom');
    };
    const r = await processRow(job, ctx);
    expect(r.status).toBe('needs_human');
    expect(r.reason).toContain('boom');
  });
  it('shows the supervisor the evidence at the strategy gate, not only the strategy summary', async () => {
    const { ctx } = setup(['proceed', 'proceed', 'proceed', 'proceed']);
    const materials: Record<string, string> = {};
    const inner = ctx.supervisor;
    ctx.supervisor = {
      decide: async (i) => {
        materials[i.gate] = i.material;
        return inner.decide(i);
      },
    };
    await processRow(job, ctx);
    expect(materials.strategy).toContain('FACTS:');
    expect(materials.strategy).toContain('NOTES:');
  });
  it('passes the supervisor concerns from the strategy gate on to the writer', async () => {
    const { ctx } = setup(['proceed', 'proceed', 'proceed', 'proceed']);
    let seen: string | undefined;
    ctx.agents!.writer = async (input) => {
      seen = input.instructions;
      return writer();
    };
    ctx.supervisor = {
      decide: async (i) => ({
        decision: { gate: i.gate, action: 'proceed', reason: 'ok', concerns: i.gate === 'strategy' ? ['keep China CAGR scoped to 2020-2025'] : [] } as Decision,
        failedClosed: false,
      }),
    };
    await processRow(job, ctx);
    expect(seen).toContain('keep China CAGR scoped to 2020-2025');
  });
  it('shows the entire allowed evidence and the actual house format at draft and final review', async () => {
    const full = {
      ...evidence,
      output: {
        ...evidence.output,
        facts: Array.from({ length: 7 }, (_, i) => ({ ...sampleFact, id: `F${i + 1}`, period: String(2025 + i) })),
        notes: Array.from({ length: 12 }, (_, i) => ({ id: `N${i + 1}`, text: i === 11 ? 'India provides the fastest percentage-growth profile.' : `Source observation ${i + 1}.`, sourceUrl: pick.url })),
      },
    };
    const { ctx, root } = setup(['proceed', 'proceed', 'proceed', 'proceed'], { evidenceOverride: full });
    const seen: DecideInput[] = [];
    const original = ctx.supervisor;
    ctx.supervisor = { decide: async (input) => { seen.push(input); return original.decide(input); } };
    expect((await processRow(job, ctx)).status).toBe('approved');
    for (const input of seen) {
      expect(input.material).toContain('[F7]');
      expect(input.material).toContain('[N12] India provides the fastest percentage-growth profile.');
    }
    for (const input of seen.filter((i) => i.gate === 'draft' || i.gate === 'final')) {
      expect(input.material).toContain('HOUSE FORMAT');
      expect(input.material).toContain('ONE discussion question after the link');
      expect(input.material).not.toContain('ONE closing question');
      expect(input.material).toContain('bullet');
    }
    expect(JSON.parse(readFileSync(path.join(root, 'runs', 'run_t', 'evidence.json'), 'utf8')).notes).toHaveLength(12);
  });
  it('keeps corrections through retries, validator rewrites and regeneration, editing the last validated draft', async () => {
    const { ctx } = setup(['proceed', 'proceed', 'retry', 'retry', 'regenerate', 'proceed', 'proceed', 'proceed']);
    const original = ctx.supervisor;
    let review = 0;
    ctx.supervisor = { decide: async (input) => {
      const result = await original.decide(input);
      if (input.gate === 'evidence') result.decision.concerns = ['Use only supplied evidence.'];
      if (input.gate === 'strategy') result.decision.concerns = ['Keep country and region distinct.'];
      if (input.gate === 'draft') {
        result.decision.instructions = ['Remove the unsupported ranking.', 'Cut the repeated summary.', 'Use a different supported angle.'][review++];
      }
      return result;
    } };
    const writerInputs: Parameters<Agents['writer']>[0][] = [];
    const validatorInputs: Parameters<Agents['validator']>[0][] = [];
    ctx.agents!.writer = async (input) => { writerInputs.push(input); return writer(); };
    ctx.agents!.validator = async (input) => { validatorInputs.push(input); return validator(true); };
    const result = await processRow(job, ctx);
    expect(result.status).toBe('approved');
    expect(writerInputs).toHaveLength(4);
    expect(writerInputs[0]!.previousDraft).toBeUndefined();
    expect(writerInputs[1]!.previousDraft).toBe('final text');
    expect(writerInputs[2]!.previousDraft).toBe('final text');
    expect(writerInputs[3]!.previousDraft).toBeUndefined();
    for (const index of [2, 3]) {
      expect(writerInputs[index]!.instructions).toContain('Remove the unsupported ranking.');
      expect(writerInputs[index]!.instructions).toContain('Cut the repeated summary.');
      expect(writerInputs[index]!.instructions).toContain('Keep country and region distinct.');
      expect(writerInputs[index]!.instructions).toContain('Use only supplied evidence.');
    }
    expect(writerInputs[3]!.instructions).toContain('Use a different supported angle.');
    expect(validatorInputs.map((i) => i.instructions)).toEqual(writerInputs.map((i) => i.instructions));
  });
  it('saves every draft with its verdict, including the rejected one', async () => {
    const { ctx, root } = setup(['proceed', 'proceed', 'retry', 'proceed', 'proceed']);
    await processRow(job, ctx);
    const dir = path.join(root, 'runs', 'run_t', 'drafts');
    expect(readFileSync(path.join(dir, '01.txt'), 'utf8')).toBe('final text');
    const first = readFileSync(path.join(dir, '01-verdict.txt'), 'utf8');
    expect(first).toContain('retry');
    expect(first).toContain('scripted');
    expect(first).toContain('be more specific');
    expect(readFileSync(path.join(dir, '02-verdict.txt'), 'utf8')).toContain('proceed');
  });
  it('a failing draft save never breaks the run', async () => {
    const { ctx } = setup(['proceed', 'proceed', 'proceed', 'proceed']);
    ctx.ledger.saveDraft = async () => {
      throw new Error('disk full');
    };
    const r = await processRow(job, ctx);
    expect(r.status).toBe('approved');
  });
  it('a supervisor that fails closed stops the row', async () => {
    const { ctx } = setup([]);
    ctx.supervisor = { decide: async (i) => ({ decision: { gate: i.gate, action: 'stop', reason: 'supervisor unavailable or invalid: x', concerns: [] }, failedClosed: true }) };
    const r = await processRow(job, ctx);
    expect(r.status).toBe('needs_human');
    expect(r.reason).toContain('supervisor unavailable');
  });
  it('learning runs after the Sheet write with the real status, and the approved draft is saved only then', async () => {
    const a = setup(['proceed', 'proceed', 'proceed', 'proceed']);
    await processRow({ ...job, writeSheet: true }, a.ctx);
    expect(a.learnCalls).toEqual(['approved']);
    expect((await a.ctx.deps.store.list('supervisor-hermes-drafts')).length).toBe(1);
  });
  it('a row that ends needs_human after a draft still gets a learning trace, with status needs_human, and saves no draft', async () => {
    const b = setup(['proceed', 'proceed', 'stop']);
    const r = await processRow(job, b.ctx);
    expect(r.status).toBe('needs_human');
    expect(b.learnCalls).toEqual(['needs_human']);
    expect((await b.ctx.deps.store.list('supervisor-hermes-drafts')).length).toBe(0);
  });
  it('a final-gate stop is recorded as needs_human, not approved', async () => {
    const c = setup(['proceed', 'proceed', 'proceed', 'stop']);
    await processRow(job, c.ctx);
    expect(c.learnCalls).toEqual(['needs_human']);
  });
  it('no learning call when the row never reached a draft', async () => {
    const failed = { ...evidence, output: { ...evidence.output, reportPageLoaded: false, verifiedFigures: 0 } };
    const d = setup(['proceed'], { evidenceOverride: failed });
    const r = await processRow(job, d.ctx);
    expect(d.learnCalls).toEqual([]);
    expect(r.noEvidence).toBe(true);
  });
  it('a supervisor failing closed at the evidence gate is NOT marked as missing evidence', async () => {
    const { ctx } = setup([]);
    ctx.supervisor = { decide: async (i) => ({ decision: { gate: i.gate, action: 'stop', reason: 'supervisor unavailable or invalid: x', concerns: [] }, failedClosed: true }) };
    const r = await processRow(job, ctx);
    expect(r.noEvidence).toBe(false);
  });
});
