import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkClaims } from '../../src/evidence/index.js';
import { loadTechniques } from '../../src/repos/techniques.js';
import { MemoryStore } from '../../src/store/store.js';
import { payloadLength } from '../../src/utils/text.js';
import { FakeLlmProvider, config, reply, sampleFact, utmLink, wrapReply } from '../../tests/fixtures/validation/helpers.js';
import type { AgentDeps } from '../src/agents/deps.js';
import type { EvidenceOutput } from '../src/agents/evidence.js';
import { runStrategyAgent } from '../src/agents/strategy.js';
import { runValidatorAgent } from '../src/agents/validator.js';
import { runWriterAgent } from '../src/agents/writer.js';
import { Ledger } from '../src/ledger.js';
import { RunLimits, countedProvider } from '../src/limits.js';
import { MIN_USEFUL_WORDS, processRow, realAgents } from '../src/orchestrator.js';
import { Supervisor } from '../src/supervisor.js';

const item = { id: 'item-x', title: 'Examplestan Widget Market', reportUrl: sampleFact.sourceUrl };
const keyword = 'Examplestan widget market';
const evidence: EvidenceOutput = {
  itemId: item.id, reportPageLoaded: true, facts: [sampleFact],
  notes: [{ id: 'N1', text: 'Premium segments are gaining share as buyers prioritize longer warranties and service.', sourceUrl: item.reportUrl }],
  mode: 'figures', verifiedFigures: 1, sources: [item.reportUrl],
};
const good = `Ken Research finds the Examplestan widget market reached USD 4.2 billion in 2025. Premium segments are gaining share as buyers prioritize longer warranties and service. ${utmLink('x')} #Widgets`;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup(text = good) {
  const provider = new FakeLlmProvider(Array.from({ length: 8 }, () => reply(wrapReply(text, ['F1']))));
  const limits = new RunLimits();
  const header = ['targetUrl', 'title', 'X Post', 'X Post URL', 'X Status', 'LinkedIn Post'];
  const row = [item.reportUrl, item.title, '', '', '', 'existing LI text'];
  const writes = new Map<string, string>();
  const deps: AgentDeps = {
    config, store: new MemoryStore(), claimChecker: checkClaims, writer: countedProvider(provider, limits), limits,
    now: () => new Date('2026-10-15T10:00:00Z'),
    sheets: {
      tab: 'Social Media',
      async read(range) { return range === '1:1' ? [header] : range === '5:5' ? [row] : [[writes.get(range) ?? '']]; },
      async writeCell(cell, value) { writes.set(cell, value); },
    },
  };
  return { provider, deps, writes };
}

describe('X supervisor support', () => {
  it('uses concise source-safe variants and the reviewed B2B/search techniques without LI examples', async () => {
    const { deps, provider } = setup();
    const strategy = (await runStrategyAgent({ item, evidence, platform: 'x', keyword, attempt: 0 }, deps)).output;
    expect(strategy.variant.layout).toBeUndefined();
    expect(strategy.styleExamples).toEqual([]);
    expect(['stat-first', 'contrast', 'implication', 'plain-statement']).toContain(strategy.variant.opener);
    expect(strategy.variant.structure).not.toBe('myth-reality');
    expect(loadTechniques('x').items.some(t => t.repo === 'coreyhaines31/marketingskills')).toBe(true);
    await runWriterAgent({ item, evidence, strategy, platform: 'x' }, deps);
    const prompt = provider.requests[0]!.prompt;
    expect(prompt).toContain('X POST CONTRACT');
    expect(prompt).toContain('primary keyword naturally');
    expect(prompt).toContain('business consideration');
    expect(prompt).toContain('Every URL counts as 23 characters');
    expect(prompt).not.toContain('SELECTED STYLE EXAMPLES');
    expect(prompt).not.toContain('ONE discussion question after the link');
    expect(prompt).not.toContain('Wrap every mention');
  });

  it('passes real X validation without long-form length or bold requirements', async () => {
    const { deps } = setup();
    const strategy = (await runStrategyAgent({ item, evidence, platform: 'x', keyword, attempt: 0 }, deps)).output;
    const report = await runValidatorAgent({ item, evidence, strategy, draft: { text: good, factIds: ['F1'], promptVersion: 'v' }, platform: 'x', keyword, minUsefulWords: MIN_USEFUL_WORDS.x }, deps);
    expect(report.output.hardFails).toEqual([]);
    expect(report.output.passed).toBe(true);
    expect(report.output.text).toBe(good);
    expect(good.length).toBeGreaterThan(280); // The long report URL is still only 23 X characters.
    expect(payloadLength(good, config.platformLimits.x)).toBeLessThanOrEqual(280);
  });

  it('runs all four gates before writing only X Post, then verifies read-back', async () => {
    const { deps, writes } = setup();
    const root = mkdtempSync(path.join(tmpdir(), 'x-supervisor-'));
    dirs.push(root);
    const gates: string[] = [];
    const role = readFileSync(new URL('../roles/supervisor.md', import.meta.url), 'utf8');
    const supervisor = new Supervisor(async (prompt, purpose) => {
      expect(prompt).toContain('Platform: x.');
      expect(prompt).toContain('X POST CONTRACT');
      expect(writes.size).toBe(0);
      const gate = purpose.replace('supervisor-', '');
      gates.push(gate);
      return JSON.stringify({ gate, action: 'proceed', reason: 'supported', concerns: [] });
    }, role, deps.limits);
    const result = await processRow({ pick: { ...item, url: item.reportUrl, rowIndex: 5, keyword }, platform: 'x', writeSheet: true, supplementary: 'off' }, {
      deps, supervisor, ledger: new Ledger(root, 'x-test'), runId: 'x-test',
      agents: { ...realAgents, evidence: async () => ({ agent: 'evidence', summary: 'loaded', concerns: [], output: evidence }) },
    });
    expect(result.status).toBe('approved');
    expect(gates).toEqual(['evidence', 'strategy', 'draft', 'final']);
    expect(result.written).toEqual({ cell: 'C5', verified: true });
    expect([...writes.entries()]).toEqual([['C5', good]]);
    expect((await deps.store.list('social-repair-traces')).length).toBe(1);
  });

  it('keeps an over-limit post out of the Sheet even if the supervisor says proceed', async () => {
    const { deps, writes } = setup(`${good} ${'Premium segments are gaining share. '.repeat(12)}`);
    deps.limits = new RunLimits({ maxRetries: 0, maxRegenerations: 0 });
    const root = mkdtempSync(path.join(tmpdir(), 'x-rejected-'));
    dirs.push(root);
    const result = await processRow({ pick: { ...item, url: item.reportUrl, rowIndex: 5, keyword }, platform: 'x', writeSheet: true, supplementary: 'off' }, {
      deps, runId: 'x-bad', ledger: new Ledger(root, 'x-bad'),
      supervisor: new Supervisor(async (_prompt, purpose) => JSON.stringify({ gate: purpose.replace('supervisor-', ''), action: 'proceed', reason: 'ok' }), '', deps.limits),
      agents: { ...realAgents, evidence: async () => ({ agent: 'evidence', summary: 'loaded', concerns: [], output: evidence }) },
    });
    expect(result.status).toBe('needs_human');
    expect(writes.size).toBe(0);
    expect(result.decisions.find(d => d.gate === 'draft')?.action).not.toBe('proceed');
  });
});
