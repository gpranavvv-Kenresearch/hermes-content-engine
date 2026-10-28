import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Choosing an explicit architecture records usage in .sessions; keep tests off the real file.
vi.mock('../../src/agents/blogStructures.js', async (original) => {
  const real = await original<typeof import('../../src/agents/blogStructures.js')>();
  return { ...real, chooseStructure: (mode: string) => (/^(rotate|random)/.test(mode) ? (mode.endsWith('formats') ? 'f-exec-brief' : 'decision-brief') : mode) };
});

import type { BlogChatSession, BlogGenResult } from '../../src/agents/blogGenAgent.js';
import { buildReviseInstruction, processBlogRow, type BlogRowDeps, type OpenChatParams } from '../src/orchestrator.js';
import { BlogLedger, BlogStateStore } from '../src/state.js';
import { BlogLimits, BlogSupervisor } from '../src/supervisor.js';
import type { BlogEvidence } from '../src/evidence.js';
import { makeBlog, REPORT_URL } from './fixtures.js';

const row = { rowIndex: 12, title: 'Brazil Seed Market', targetUrl: REPORT_URL };
const good: BlogEvidence = { pageLoaded: true, finalUrl: REPORT_URL, redirected: false, verifiedFigures: 3, notes: 4, evidenceText: '8.7 12.1 4.8', pageText: 'Market size USD 8.7 billion in 2025.', summary: 'Report page loaded.' };

type Reply = Record<string, unknown>;
const script = (replies: Partial<Record<'evidence' | 'structure' | 'draft' | 'final', Reply[]>>) => {
  const asked: string[] = [];
  const queues = Object.fromEntries(Object.entries(replies).map(([k, v]) => [k, [...(v ?? [])]]));
  const ask = async (prompt: string) => {
    const gate = /## GATE\n(\w+)/.exec(prompt)![1]!;
    asked.push(gate);
    const next = queues[gate]?.shift();
    if (!next) throw new Error(`no scripted reply left for gate ${gate}`);
    return JSON.stringify({ gate, reason: 'ok', ...next });
  };
  return { ask, asked };
};

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'blogorch-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function setup(replies: Parameters<typeof script>[0], opts: { evidence?: BlogEvidence; blogs?: BlogGenResult[]; revisions?: BlogGenResult[]; verify?: { ok: boolean; reason?: string }[]; structureMode?: string } = {}) {
  const s = script(replies);
  const limits = new BlogLimits();
  const store = new BlogStateStore(dir);
  const events: string[] = [];
  const chats: { params: OpenChatParams; generate: number; revise: string[]; closed: number }[] = [];
  const blogs = [...(opts.blogs ?? [makeBlog()])];
  const revisions = [...(opts.revisions ?? [makeBlog()])];
  const saved: { html: string }[] = [];
  const verifies = [...(opts.verify ?? [{ ok: true }])];

  const deps: BlogRowDeps = {
    supervisor: new BlogSupervisor(s.ask, 'ROLE', limits),
    limits,
    ledger: new BlogLedger(dir, 'run1', (l) => events.push(l)),
    store,
    evidence: async () => opts.evidence ?? good,
    openChat: async (params) => {
      const rec = { params, generate: 0, revise: [] as string[], closed: 0 };
      chats.push(rec);
      const session: BlogChatSession = {
        generate: async () => { rec.generate++; return blogs.shift() ?? makeBlog(); },
        revise: async (i) => { rec.revise.push(i); return revisions.shift() ?? makeBlog(); },
        close: async () => { rec.closed++; },
      };
      return session;
    },
    finishArticle: async ({ blog }) => blog.html + '<!-- finished -->',
    save: async (_row, data) => { saved.push({ html: data.html }); },
    verify: async () => verifies.shift() ?? { ok: true },
    structureMode: opts.structureMode ?? 'v1.3',
  };
  return { deps, s, limits, store, chats, saved, events };
}

const proceed = { action: 'proceed' };

describe('processBlogRow', () => {
  it('writes an article that passes every gate', async () => {
    const t = setup({ evidence: [proceed], draft: [proceed], final: [proceed] });
    const r = await processBlogRow(row, t.deps);
    expect(r.status).toBe('written');
    expect(t.s.asked).toEqual(['evidence', 'draft', 'final']);
    expect(t.saved).toHaveLength(1);
    expect(t.saved[0]!.html).toContain('<!-- finished -->');
    expect(t.chats).toHaveLength(1);
    expect(t.chats[0]!.params.url).toBe(REPORT_URL);
    expect(await t.store.loadApprovedDraft(12)).toBeNull();
  });

  it('skips a row whose report page did not load without spending a Hermes call', async () => {
    const t = setup({}, { evidence: { ...good, pageLoaded: false, summary: 'The report page did not load: HTTP 404' } });
    const r = await processBlogRow(row, t.deps);
    expect(r.status).toBe('skipped');
    expect(t.s.asked).toEqual([]);
    expect(t.chats).toHaveLength(0);
  });

  it('treats a temporary report-fetch failure as retryable, not as a skipped row', async () => {
    const t = setup({}, { evidence: { ...good, pageLoaded: false, transient: true, summary: 'The report page did not load: Timed out after 20000ms' } });
    await expect(processBlogRow(row, t.deps)).rejects.toThrow(/EVIDENCE_FETCH_TRANSIENT/);
    expect(t.s.asked).toEqual([]);
  });

  it('writes the article against the redirected URL', async () => {
    const final = 'https://www.kenresearch.com/industry-reports/brazil-seeds-and-genetics-market';
    const t = setup({ evidence: [proceed], draft: [proceed], final: [proceed] }, { evidence: { ...good, finalUrl: final, redirected: true }, blogs: [{ ...makeBlog(), html: makeBlog().html.split(REPORT_URL).join(final) }] });
    await processBlogRow(row, t.deps);
    expect(t.chats[0]!.params.url).toBe(final);
  });

  it('sends a draft retry to the SAME chat and checks the corrected draft', async () => {
    const t = setup(
      { evidence: [proceed], draft: [{ action: 'retry', instructions: '1. Cut the longest paragraph.' }, proceed], final: [proceed] },
      { revisions: [makeBlog({ unboldedNumber: false })] },
    );
    const r = await processBlogRow(row, t.deps);
    expect(r.status).toBe('written');
    expect(t.chats).toHaveLength(1);
    expect(t.chats[0]!.revise).toHaveLength(1);
    expect(t.chats[0]!.revise[0]).toContain('1. Cut the longest paragraph.');
    expect(t.chats[0]!.revise[0]).toContain('change nothing else');
    expect(t.s.asked).toEqual(['evidence', 'draft', 'draft', 'final']);
  });

  it('falls back to the reason when the supervisor sends empty instructions', async () => {
    const t = setup({ evidence: [proceed], draft: [{ action: 'retry', instructions: '', reason: 'Paragraph 4 is 97 words.' }, proceed], final: [proceed] });
    await processBlogRow(row, t.deps);
    expect(t.chats[0]!.revise[0]).toContain('Paragraph 4 is 97 words.');
  });

  it('will not let the supervisor wave through structural garbage', async () => {
    const t = setup(
      { evidence: [proceed], draft: [proceed, proceed], final: [proceed] },
      { blogs: [makeBlog({ table: true })], revisions: [makeBlog()] },
    );
    const r = await processBlogRow(row, t.deps);
    expect(r.status).toBe('written');
    expect(t.chats[0]!.revise).toHaveLength(1);
    expect(t.chats[0]!.revise[0]).toContain('table');
  });

  it('restarts in a fresh chat with the corrections when the supervisor asks to regenerate', async () => {
    const t = setup({ evidence: [proceed], draft: [{ action: 'regenerate', instructions: '1. The thesis is wrong.' }, proceed], final: [proceed] });
    const r = await processBlogRow(row, t.deps);
    expect(r.status).toBe('written');
    expect(t.chats).toHaveLength(2);
    expect(t.chats[0]!.closed).toBeGreaterThanOrEqual(1);
    expect(t.chats[1]!.params.promptSuffix).toContain('1. The thesis is wrong.');
  });

  it('gives up with needs_human when the supervisor stops at the draft gate', async () => {
    const t = setup({ evidence: [proceed], draft: [{ action: 'stop', reason: 'figures look invented' }] });
    const r = await processBlogRow(row, t.deps);
    expect(r.status).toBe('needs_human');
    expect(r.reason).toContain('figures look invented');
    expect(t.saved).toHaveLength(0);
  });

  it('stops after the fix budget is used up instead of looping', async () => {
    const retry = { action: 'retry', instructions: '1. Fix.' };
    const t = setup({ evidence: [proceed], draft: [retry, retry, retry, retry, retry, retry] });
    const r = await processBlogRow(row, t.deps);
    expect(['needs_human', 'written']).toContain(r.status);
    expect(t.chats[0]!.revise.length).toBeLessThanOrEqual(3);
    expect(t.chats.length).toBeLessThanOrEqual(2);
  });

  it('final gate can only proceed or stop, never retry', async () => {
    const t = setup({ evidence: [proceed], draft: [proceed], final: [{ action: 'retry', instructions: 'x' }] });
    const r = await processBlogRow(row, t.deps);
    expect(r.status).toBe('needs_human');
    expect(t.saved).toHaveLength(0);
  });

  it('keeps the approved draft when the Sheet write cannot be verified, and resumes from it without opening a chat', async () => {
    const first = setup({ evidence: [proceed], draft: [proceed], final: [proceed] }, { verify: [{ ok: false, reason: 'row empty' }, { ok: false, reason: 'row empty' }] });
    const r1 = await processBlogRow(row, first.deps);
    expect(r1.status).toBe('needs_human');
    expect(await first.store.loadApprovedDraft(12)).not.toBeNull();

    const second = setup({ final: [proceed] });
    // Same on-disk store as the first attempt.
    second.deps.store = first.store;
    const r2 = await processBlogRow(row, second.deps);
    expect(r2.status).toBe('written');
    expect(second.chats).toHaveLength(0);
    expect(second.s.asked).toEqual(['final']);
    expect(await first.store.loadApprovedDraft(12)).toBeNull();
  });

  it('uses a forced architecture without second-guessing it', async () => {
    const t = setup({ evidence: [proceed], draft: [proceed], final: [proceed] }, { structureMode: 'question-ladder' });
    const r = await processBlogRow(row, t.deps);
    expect(r.structure).toBe('question-ladder');
    expect(t.chats[0]!.params.structure).toBe('question-ladder');
    expect(t.s.asked).toEqual(['evidence', 'draft', 'final']);
  });

  it('lets the supervisor switch a rotated architecture once at the structure gate', async () => {
    const t = setup({ evidence: [proceed], structure: [{ action: 'retry', structure: 'regulation-to-opportunity' }], draft: [proceed], final: [proceed] }, { structureMode: 'rotate' });
    const r = await processBlogRow(row, t.deps);
    expect(r.structure).toBe('regulation-to-opportunity');
    expect(t.chats[0]!.params.structure).toBe('regulation-to-opportunity');
  });

  it('closes the chat even when generation throws', async () => {
    const t = setup({ evidence: [proceed] });
    t.deps.openChat = async () => ({
      generate: async () => { throw new Error('STALLED: stuck'); },
      revise: async () => makeBlog(),
      close: async () => { t.events.push('closed'); },
    });
    await expect(processBlogRow(row, t.deps)).rejects.toThrow('STALLED');
    expect(t.events).toContain('closed');
  });
});

describe('buildReviseInstruction', () => {
  it('asks for the full deliverable again with only the listed changes', () => {
    const text = buildReviseInstruction('1. Shorten paragraph 2.');
    expect(text).toContain('1. Shorten paragraph 2.');
    expect(text).toContain('COMPLETE deliverable');
    expect(text).toContain('change nothing else');
  });
});
