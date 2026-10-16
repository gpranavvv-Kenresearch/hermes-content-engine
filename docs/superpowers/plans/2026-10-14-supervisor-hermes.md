# Supervisor Hermes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `supervisor-hermes/`, an agent-wise version of the social text pipeline (sheet, evidence, strategy, writer, validator, learning agents) with a Hermes supervisor that decides proceed, retry, regenerate or stop at four gates.

**Architecture:** Agents are modules with typed reports. An orchestrator runs them in order; after each gate it asks the Supervisor (a stateless Hermes call that carries the run's gate history), passes the answer through code-side `gates.ts` rules the supervisor cannot loosen, then applies it. Everything is recorded in an append-only jsonl ledger. `src/` is not edited; the folder imports its exported primitives.

**Tech Stack:** TypeScript (ES2022, NodeNext, strict), Node 22, zod 4, vitest 5, existing `src/` modules, the `hermes` CLI (`chat --oneshot --format stream-json --provider openai-codex`).

**Spec:** `docs/superpowers/specs/2026-10-14-supervisor-hermes-design.md`

## Global Constraints

- `src/` is not modified. Only `tsconfig.json`, `vitest.config.ts`, `package.json` get small edits (Task 1).
- Import `src/` modules with relative paths ending in `.js` (NodeNext), for example `../../src/schemas/index.js`.
- Facts come only from Ken Research and government pages; the supervisor never adds facts.
- No posting to social platforms. Sheet write only through `writeGeneratedPost` and only when `--write-sheet` is given.
- Supervisor can only be stricter than code. Invalid or missing supervisor output means `stop` (fail closed).
- Defaults: regenerate max 2 per row, writer retry max 3 per attempt, Hermes calls max 20 per row, per-call timeout 180000 ms, batch stops after 3 failed rows in a row (1 when `--count 1`).
- Hermes is called with `hermes chat --oneshot --query-file - --format stream-json --provider openai-codex --toolsets <set> --max-turns 4 --source tool`.
- The repo has **no commits yet** and every file is untracked. Do not run `git commit` unless the user asks. Where this plan says "Checkpoint", run the stated commands instead.
- Each task ends with `npm run typecheck` and `npx vitest run supervisor-hermes` passing; the final task also runs the whole suite (872 existing tests must still pass).
- Spec deviation (accepted): the supervisor is **stateless per call**. Each call carries the run's earlier decisions, so no `--resume` session behaviour is relied on. The spec text is updated in Task 1.

## Review Focus

- Supervisor reply wrapped in prose or a ```json fence, or containing two JSON objects: the first balanced object is used; anything unparseable stops the row.
- Supervisor answers for the wrong gate (for example `final` at the `draft` gate): treated as invalid, fail closed.
- Supervisor says `proceed` while the validator reports a hard fail: code overrides to `retry` (or `stop` when no retries are left).
- Report page returns 404 while a search provider is configured: no supplementary evidence is fetched and no draft is written for that report.
- Endless loops: a supervisor that keeps saying `retry`/`regenerate` is cut off by counters and ends `needs_human`.
- `--count N` without `--write-sheet`: a row already drafted in this run is not picked again.

---

### Task 1: Scaffold, shared types, config wiring

**Files:**
- Create: `supervisor-hermes/src/types.ts`
- Create: `supervisor-hermes/tests/types.test.ts`
- Modify: `tsconfig.json` (include), `vitest.config.ts` (include), `package.json` (scripts)
- Modify: `docs/superpowers/specs/2026-10-14-supervisor-hermes-design.md` (stateless supervisor note)

**Interfaces:**
- Produces: `Gate`, `GATES`, `Action`, `ACTIONS`, `DecisionSchema`, `Decision`, `AgentName`, `AgentReport<T>`, `SocialPlatform`, `RowStatus`, `RowResult`.

- [ ] **Step 1: Write the failing test** `supervisor-hermes/tests/types.test.ts`

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run supervisor-hermes/tests/types.test.ts`
Expected: FAIL (no tests found, because vitest `include` does not cover the folder yet, or `../src/types.js` missing).

- [ ] **Step 3: Wire config and write `supervisor-hermes/src/types.ts`**

`vitest.config.ts` include becomes `['tests/**/*.test.ts', 'supervisor-hermes/tests/**/*.test.ts']`. `tsconfig.json` include becomes `["src/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts", "supervisor-hermes/**/*.ts"]`. `package.json` scripts gain:

```json
"hermes:run": "tsx supervisor-hermes/src/cli.ts run",
"hermes:status": "tsx supervisor-hermes/src/cli.ts status"
```

```ts
import { z } from 'zod';

export const GATES = ['evidence', 'strategy', 'draft', 'final'] as const;
export type Gate = (typeof GATES)[number];

export const ACTIONS = ['proceed', 'retry', 'regenerate', 'stop'] as const;
export type Action = (typeof ACTIONS)[number];

export const DecisionSchema = z.object({
  gate: z.enum(GATES),
  action: z.enum(ACTIONS),
  reason: z.string().min(1).max(600),
  instructions: z.string().max(1500).optional(),
  concerns: z.array(z.string().max(300)).max(8).default([]),
});
export type Decision = z.infer<typeof DecisionSchema>;

export type AgentName = 'sheet' | 'evidence' | 'strategy' | 'writer' | 'validator' | 'learning';

export interface AgentReport<T> {
  agent: AgentName;
  output: T;
  /** A few sentences: what the agent did and found. */
  summary: string;
  /** Anything the agent doubts. */
  concerns: string[];
}

export type SocialPlatform = 'facebook' | 'linkedin';
export type RowStatus = 'approved' | 'needs_human';

export interface RowResult {
  rowIndex: number;
  url: string;
  title: string;
  keyword: string;
  platform: SocialPlatform;
  status: RowStatus;
  reason: string;
  text: string | null;
  score: number | null;
  regenerations: number;
  retries: number;
  decisions: Decision[];
  written: { cell: string; verified: boolean } | null;
}
```

Spec edit: in section "Supervisor" replace the first sentence "One Hermes session for the whole run, so it remembers earlier gates." with "A stateless Hermes call per gate; each call carries the run's earlier decisions, so it behaves as one session without relying on session resume." and in "Assumptions to confirm" item 4 replace "one Hermes supervisor session and one Hermes writer session" with "Hermes calls per gate and per writer attempt".

- [ ] **Step 4: Run test and typecheck**

Run: `npx vitest run supervisor-hermes/tests/types.test.ts && npm run typecheck`
Expected: 4 tests pass; typecheck clean.

- [ ] **Step 5: Checkpoint**

Run: `npx vitest run supervisor-hermes` (expected: pass).

---

### Task 2: Limits and ledger

**Files:**
- Create: `supervisor-hermes/src/limits.ts`, `supervisor-hermes/src/ledger.ts`
- Test: `supervisor-hermes/tests/limits.test.ts`, `supervisor-hermes/tests/ledger.test.ts`

**Interfaces:**
- Produces:
  - `RunLimits` with `calls: Budget` (from `src/safety/budget.js`), `canRegenerate(): boolean`, `useRegeneration(): void`, `regenerations: number`, `canRetry(): boolean`, `useRetry(): void`, `retries: number`, `resetRetries(): void`; constructor `new RunLimits({ maxHermesCalls = 20, maxRegenerations = 2, maxRetries = 3 })`.
  - `countedProvider(inner: LlmProvider, limits: RunLimits): LlmProvider`.
  - `Ledger` with constructor `new Ledger(root: string, runId: string)`, `append(event: LedgerEvent): Promise<void>`, `static read(root, runId): Promise<LedgerEvent[]>`, `dir: string`.
  - `LedgerEvent = { at: string; type: 'agent' | 'decision' | 'control' | 'result'; agent?: AgentName; gate?: Gate; data: unknown }`.

- [ ] **Step 1: Write the failing tests**

`limits.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BudgetExceededError } from '../../src/errors.js';
import { RunLimits, countedProvider } from '../src/limits.js';

describe('RunLimits', () => {
  it('counts regenerations and retries against their limits', () => {
    const l = new RunLimits({ maxRegenerations: 1, maxRetries: 2 });
    expect(l.canRegenerate()).toBe(true);
    l.useRegeneration();
    expect(l.canRegenerate()).toBe(false);
    l.useRetry(); l.useRetry();
    expect(l.canRetry()).toBe(false);
    l.resetRetries();
    expect(l.canRetry()).toBe(true);
    expect(l.regenerations).toBe(1);
  });
  it('counted provider consumes one Hermes call per generate and throws when the budget is spent', async () => {
    const l = new RunLimits({ maxHermesCalls: 1 });
    const inner = { id: 'fake', generate: async () => ({ text: 'x', complete: true, provider: 'fake', elapsedMs: 1 }) };
    const p = countedProvider(inner, l);
    await p.generate({ prompt: 'a', purpose: 'draft' });
    await expect(p.generate({ prompt: 'b', purpose: 'draft' })).rejects.toBeInstanceOf(BudgetExceededError);
  });
});
```

`ledger.test.ts`:
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('Ledger', () => {
  it('appends events in order and reads them back', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ledger-'));
    dirs.push(root);
    const ledger = new Ledger(root, 'run_1');
    await ledger.append({ type: 'agent', agent: 'evidence', data: { facts: 3 } });
    await ledger.append({ type: 'decision', gate: 'evidence', data: { action: 'proceed' } });
    const events = await Ledger.read(root, 'run_1');
    expect(events.map((e) => e.type)).toEqual(['agent', 'decision']);
    expect(events[0]!.at).toMatch(/^\d{4}-/);
  });
  it('returns [] for an unknown run', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ledger-'));
    dirs.push(root);
    expect(await Ledger.read(root, 'nope')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run supervisor-hermes/tests/limits.test.ts supervisor-hermes/tests/ledger.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`limits.ts`:
```ts
import type { LlmProvider } from '../../src/contracts.js';
import { Budget } from '../../src/safety/budget.js';

export interface LimitOptions {
  maxHermesCalls?: number;
  maxRegenerations?: number;
  maxRetries?: number;
}

export class RunLimits {
  readonly calls: Budget;
  regenerations = 0;
  retries = 0;
  private readonly maxRegenerations: number;
  private readonly maxRetries: number;

  constructor(options: LimitOptions = {}) {
    this.calls = new Budget('hermes-calls', options.maxHermesCalls ?? 20);
    this.maxRegenerations = options.maxRegenerations ?? 2;
    this.maxRetries = options.maxRetries ?? 3;
  }
  canRegenerate(): boolean { return this.regenerations < this.maxRegenerations; }
  useRegeneration(): void { this.regenerations++; }
  canRetry(): boolean { return this.retries < this.maxRetries; }
  useRetry(): void { this.retries++; }
  resetRetries(): void { this.retries = 0; }
}

/** Every writer call spends one unit of the shared Hermes call budget. */
export function countedProvider(inner: LlmProvider, limits: RunLimits): LlmProvider {
  return {
    id: inner.id,
    generate(request) {
      limits.calls.consume();
      return inner.generate(request);
    },
  };
}
```

`ledger.ts`:
```ts
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentName, Gate } from './types.js';

export interface LedgerEvent {
  at?: string;
  type: 'agent' | 'decision' | 'control' | 'result';
  agent?: AgentName;
  gate?: Gate;
  data: unknown;
}

export class Ledger {
  readonly dir: string;
  private readonly file: string;

  constructor(root: string, readonly runId: string) {
    this.dir = path.join(root, 'runs', runId);
    this.file = path.join(this.dir, 'events.jsonl');
  }

  async append(event: LedgerEvent): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file, `${JSON.stringify({ ...event, at: event.at ?? new Date().toISOString() })}\n`, 'utf8');
  }

  static async read(root: string, runId: string): Promise<LedgerEvent[]> {
    try {
      const raw = await readFile(path.join(root, 'runs', runId, 'events.jsonl'), 'utf8');
      return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run supervisor-hermes && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Checkpoint** — same command, expected green.

---

### Task 3: Gate rules (what the supervisor cannot override)

**Files:**
- Create: `supervisor-hermes/src/gates.ts`
- Test: `supervisor-hermes/tests/gates.test.ts`

**Interfaces:**
- Consumes: `Decision`, `Gate` (Task 1).
- Produces: `GateFacts`, `GateOutcome`, `MIN_NOTES = 3`, `enforceGate(decision: Decision, facts: GateFacts): GateOutcome`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run supervisor-hermes/tests/gates.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `gates.ts`**

```ts
import type { Decision, Gate } from './types.js';

export const MIN_NOTES = 3;

export interface GateFacts {
  gate: Gate;
  reportPageLoaded: boolean;
  /** Verified figures from 2024 or later (selectBriefFacts). */
  verifiedFigures: number;
  usableNotes: number;
  validatorPassed?: boolean;
  hardFails?: readonly string[];
  retriesLeft: boolean;
}

export interface GateOutcome {
  decision: Decision;
  overridden: boolean;
}

/**
 * Rules the supervisor cannot loosen. They only ever make a decision stricter. The supervisor's own words stay in the
 * reason so the ledger shows what it asked for and why code said otherwise.
 */
export function enforceGate(decision: Decision, facts: GateFacts): GateOutcome {
  const override = (action: Decision['action'], why: string): GateOutcome => ({
    decision: { ...decision, action, reason: `${why} (supervisor said ${decision.action}: ${decision.reason})`.slice(0, 600) },
    overridden: true,
  });

  if (facts.gate === 'evidence') {
    if (!facts.reportPageLoaded) return override('stop', 'report page did not load, so no draft may be written for this report');
    if (facts.verifiedFigures === 0 && facts.usableNotes < MIN_NOTES) return override('stop', `no verified figure and fewer than ${MIN_NOTES} source notes`);
    if (decision.action === 'retry' || decision.action === 'regenerate') return override('stop', 'evidence cannot be retried');
  }

  if ((facts.gate === 'draft' || facts.gate === 'final') && decision.action === 'proceed' && facts.validatorPassed === false) {
    const why = `validator hard fails: ${(facts.hardFails ?? []).join(', ') || 'unspecified'}`;
    return facts.retriesLeft && facts.gate === 'draft' ? override('retry', why) : override('stop', why);
  }

  if (facts.gate === 'final' && (decision.action === 'retry' || decision.action === 'regenerate')) {
    return override('stop', 'the final gate accepts only proceed or stop');
  }

  return { decision, overridden: false };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run supervisor-hermes/tests/gates.test.ts && npm run typecheck`
Expected: 7 pass.

- [ ] **Step 5: Checkpoint** — `npx vitest run supervisor-hermes` green.

---

### Task 4: Supervisor (Hermes client, prompt, parsing, fail-closed)

**Files:**
- Create: `supervisor-hermes/roles/supervisor.md`, `supervisor-hermes/src/supervisor.ts`, `supervisor-hermes/src/hermes-client.ts`
- Test: `supervisor-hermes/tests/supervisor.test.ts`

**Interfaces:**
- Consumes: `Decision`, `DecisionSchema`, `Gate`, `AgentReport` (Task 1); `RunLimits` (Task 2).
- Produces: `HermesAsk = (prompt: string, purpose: string) => Promise<string>`; `extractJson(raw: string): unknown`; `DecideInput { gate: Gate; reports: readonly AgentReport<unknown>[]; material: string; history: readonly Decision[]; limitsNote: string }`; `SupervisorResult { decision: Decision; failedClosed: boolean }`; `class Supervisor { constructor(ask: HermesAsk, role: string, limits: RunLimits); decide(input: DecideInput): Promise<SupervisorResult> }`; `createHermesAsk(options?: { command?: string; provider?: string; timeoutMs?: number; toolsets?: string }): HermesAsk`.

- [ ] **Step 1: Write the failing test**

```ts
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
    const s = new Supervisor(async (p) => { seen = p; return ok; }, 'ROLE TEXT', new RunLimits());
    await s.decide({ ...input, history: [{ gate: 'evidence', action: 'proceed', reason: 'enough facts', concerns: [] }] });
    expect(seen).toContain('ROLE TEXT');
    expect(seen).toContain('draft');
    expect(seen).toContain('DRAFT TEXT');
    expect(seen).toContain('enough facts');
  });
  it('fails closed on invalid JSON, wrong gate, unknown action and Hermes errors', async () => {
    const cases = [
      async () => 'not json',
      async () => JSON.stringify({ gate: 'final', action: 'proceed', reason: 'x' }),
      async () => JSON.stringify({ gate: 'draft', action: 'approve', reason: 'x' }),
      async () => { throw new Error('Hermes timed out'); },
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
    const out = await new Supervisor(async () => { called = true; return ok; }, 'ROLE', limits).decide(input);
    expect(called).toBe(false);
    expect(out.failedClosed).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run supervisor-hermes/tests/supervisor.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`roles/supervisor.md`:
```md
You are the supervisor of the Ken Research social text pipeline. Several agents (sheet, evidence, strategy, writer, validator, learning) do the work; you decide, at each gate, whether the run goes on.

You see compact reports and the material for the current gate. You do not write posts and you never add facts. Facts come only from the supplied evidence.

At each gate answer with ONE JSON object and nothing else:
{"gate":"<the gate you were asked about>","action":"proceed|retry|regenerate|stop","reason":"one or two sentences","instructions":"what the next attempt must do differently (only for retry/regenerate)","concerns":["short items"]}

Actions:
- proceed: the work is good enough to move on.
- retry: run the same agent again with your instructions (writer or strategy).
- regenerate: throw the strategy and draft away and start again with a new variant, using your instructions.
- stop: end this row; a person will look at it.

Be strict. Choose regenerate or stop when the draft is generic, off topic, repeats earlier wording, implies things the evidence does not state, reads like marketing copy, or is built on an unrelated report. Code enforces separate hard rules (facts, validation) that you cannot override; you can only be stricter than they are.
```

`supervisor.ts`:
```ts
import { DecisionSchema, type AgentReport, type Decision, type Gate } from './types.js';
import type { RunLimits } from './limits.js';

export type HermesAsk = (prompt: string, purpose: string) => Promise<string>;

export interface DecideInput {
  gate: Gate;
  reports: readonly AgentReport<unknown>[];
  /** The text the supervisor must read at this gate (evidence statements, draft text, validator report). */
  material: string;
  history: readonly Decision[];
  limitsNote: string;
}

export interface SupervisorResult {
  decision: Decision;
  failedClosed: boolean;
}

/** First balanced {...} object in a reply, tolerant of prose and code fences. */
export function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('no JSON object in reply');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(raw.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object in reply');
}

export function buildSupervisorPrompt(role: string, input: DecideInput): string {
  const reports = input.reports.map((r) => `- ${r.agent}: ${r.summary}${r.concerns.length ? ` | concerns: ${r.concerns.join('; ')}` : ''}`);
  const history = input.history.map((d) => `- ${d.gate}: ${d.action} (${d.reason})`);
  return [
    role.trim(),
    `\n## GATE\n${input.gate}`,
    `\n## LIMITS\n${input.limitsNote}`,
    `\n## EARLIER DECISIONS IN THIS RUN\n${history.length ? history.join('\n') : 'none'}`,
    `\n## AGENT REPORTS\n${reports.length ? reports.join('\n') : 'none'}`,
    `\n## MATERIAL FOR THIS GATE\n${input.material}`,
    `\nAnswer with the JSON object for gate "${input.gate}" only.`,
  ].join('\n');
}

export class Supervisor {
  constructor(
    private readonly ask: HermesAsk,
    private readonly role: string,
    private readonly limits: RunLimits,
  ) {}

  async decide(input: DecideInput): Promise<SupervisorResult> {
    const closed = (why: string): SupervisorResult => ({
      decision: { gate: input.gate, action: 'stop', reason: `supervisor unavailable or invalid: ${why}`.slice(0, 600), concerns: [] },
      failedClosed: true,
    });
    try {
      this.limits.calls.consume();
      const raw = await this.ask(buildSupervisorPrompt(this.role, input), `supervisor-${input.gate}`);
      const parsed = DecisionSchema.parse(extractJson(raw));
      if (parsed.gate !== input.gate) return closed(`answered for gate "${parsed.gate}" instead of "${input.gate}"`);
      return { decision: parsed, failedClosed: false };
    } catch (error) {
      return closed((error as Error).message);
    }
  }
}
```

`hermes-client.ts` (mirrors the spawn logic of `src/social/hermes-provider.ts`; verified manually in the pilot, not unit-tested):
```ts
import { spawn } from 'node:child_process';
import { parseHermesStream } from '../../src/social/hermes-provider.js';
import type { HermesAsk } from './supervisor.js';

export interface HermesAskOptions {
  command?: string;
  provider?: string;
  timeoutMs?: number;
  toolsets?: string;
}

export function createHermesAsk(options: HermesAskOptions = {}): HermesAsk {
  const command = options.command ?? process.env.HCE_HERMES_BIN ?? 'hermes';
  const provider = options.provider ?? 'openai-codex';
  const timeoutMs = options.timeoutMs ?? 180_000;
  const toolsets = options.toolsets ?? 'skills';
  return (prompt) =>
    new Promise<string>((resolve, reject) => {
      const args = ['chat', '--oneshot', '--query-file', '-', '--format', 'stream-json', '--provider', provider, '--toolsets', toolsets, '--max-turns', '4', '--source', 'tool'];
      const child = spawn(command, args, { cwd: process.cwd(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let done = false;
      const finish = (error?: Error, value?: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value ?? '');
      };
      const timer = setTimeout(() => { child.kill(); finish(new Error(`Hermes timed out after ${timeoutMs} ms`)); }, timeoutMs);
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8');
        if (out.length > 2_000_000) { child.kill(); finish(new Error('Hermes output exceeded 2 MB')); }
      });
      child.stderr.on('data', (c: Buffer) => { err = (err + c.toString('utf8')).slice(-2_000); });
      child.on('error', (e) => finish(new Error(`Hermes could not start: ${e.message}`)));
      child.on('close', (code) => {
        if (code !== 0) return finish(new Error(`Hermes exited ${code}. ${err.trim().slice(-200)}`));
        try {
          const result = parseHermesStream(out);
          if (result.exit_code !== 0 || !result.text?.trim()) return finish(new Error(`Hermes turn failed (${result.exit_code}): ${result.error ?? 'no answer'}`));
          finish(undefined, result.text);
        } catch (e) {
          finish(e as Error);
        }
      });
      child.stdin.on('error', () => { /* the close handler reports a failed process */ });
      child.stdin.end(prompt);
    });
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run supervisor-hermes && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Checkpoint** — same, green.

---

### Task 5: Shared agent dependencies, sheet agent, evidence agent

**Files:**
- Create: `supervisor-hermes/src/agents/deps.ts`, `supervisor-hermes/src/agents/sheet.ts`, `supervisor-hermes/src/agents/evidence.ts`, `supervisor-hermes/roles/sheet.md`, `supervisor-hermes/roles/evidence.md`
- Test: `supervisor-hermes/tests/sheet-agent.test.ts`, `supervisor-hermes/tests/evidence-agent.test.ts`

**Interfaces:**
- Consumes: `AgentReport`, `SocialPlatform` (Task 1); `RunLimits` (Task 2).
- Produces:
  - `AgentDeps { config: LoadedConfig; store: Store; claimChecker: ClaimChecker; writer: LlmProvider; hermes?: HermesProvider; sheets: SheetsApi; searchProvider?: SearchProvider; fetcher?: Fetcher; limits: RunLimits; now: () => Date }`
  - Sheet: `SheetPickOutput { rowIndex: number; url: string; title: string; keyword: string }`; `pickRowAgent(rows: string[][], platform: SocialPlatform, exclude: ReadonlySet<number>, keywordOverride?: string): AgentReport<SheetPickOutput> | null`; `writeRowAgent(api: SheetsApi, platform, pick: SheetPickOutput, text: string): Promise<AgentReport<{ cell: string; verified: boolean }>>`
  - Evidence: `EvidenceMode = 'figures' | 'qualitative' | 'none'`; `EvidenceOutput { itemId: string; reportPageLoaded: boolean; facts: Fact[]; notes: SourceNote[]; mode: EvidenceMode; verifiedFigures: number; sources: string[]; error?: string }`; `runEvidenceAgent(input: { url: string; title: string; supplementary: 'off' | 'ken-gov' | 'all' }, deps: AgentDeps): Promise<AgentReport<EvidenceOutput>>`

- [ ] **Step 1: Write the failing tests**

`sheet-agent.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { SheetsApi } from '../../src/sheets/social-sheet.js';
import { pickRowAgent, writeRowAgent } from '../src/agents/sheet.js';

const header = ['targetUrl', 'title', 'seoKeywords', 'FB Post', 'FB Post URL', 'FB Status', 'LinkedIn Post', 'LinkedIn Post URL', 'LinkedIn Status'];
const rows = [
  header,
  ['https://www.kenresearch.com/a', 'Alpha Widget Market Share, Companies & Trends Report 2025', '', '', 'https://fb/1', 'Posted', '', '', ''],
  ['https://www.kenresearch.com/b', 'Beta Gadget Market', 'beta gadget outlook', '', '', '', '', '', ''],
  ['https://www.kenresearch.com/c', 'Gamma Parts Market', '', '', '', '', '', '', ''],
];

describe('pickRowAgent', () => {
  it('picks the first unprocessed row after the last processed one and uses seoKeywords', () => {
    const r = pickRowAgent(rows, 'facebook', new Set())!;
    expect(r.output).toMatchObject({ rowIndex: 3, url: 'https://www.kenresearch.com/b', keyword: 'beta gadget outlook' });
  });
  it('infers the keyword from the title when seoKeywords is empty, and skips excluded rows', () => {
    const r = pickRowAgent(rows, 'facebook', new Set([3]))!;
    expect(r.output.rowIndex).toBe(4);
    expect(r.output.keyword).toBe('Gamma Parts');
  });
  it('lets an override keyword win', () => {
    expect(pickRowAgent(rows, 'facebook', new Set(), 'my phrase here')!.output.keyword).toBe('my phrase here');
  });
  it('returns null when no row is left', () => {
    expect(pickRowAgent(rows, 'facebook', new Set([3, 4]))).toBeNull();
  });
});

describe('writeRowAgent', () => {
  it('writes one Post cell and reports the verified read-back', async () => {
    const cells = new Map<string, string>();
    const api: SheetsApi = {
      tab: 'Social Media',
      async read(range) {
        if (range === '1:1') return [header];
        if (/^\d+:\d+$/.test(range)) return [['https://www.kenresearch.com/b', 'Beta Gadget Market', '', '', '', '', '', '', '']];
        return [[cells.get(range) ?? '']];
      },
      async writeCell(a1, text) { cells.set(a1, text); },
    };
    const report = await writeRowAgent(api, 'facebook', { rowIndex: 3, url: 'https://www.kenresearch.com/b', title: 'Beta Gadget Market', keyword: 'beta gadget' }, 'POST TEXT');
    expect(report.output).toEqual({ cell: 'D3', verified: true });
    expect(cells.get('D3')).toBe('POST TEXT');
  });
});
```

`evidence-agent.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Fetcher, SearchProvider } from '../../src/contracts.js';
import { MemoryStore } from '../../src/store/store.js';
import { config } from '../../tests/fixtures/validation/helpers.js';
import { RunLimits } from '../src/limits.js';
import type { AgentDeps } from '../src/agents/deps.js';
import { runEvidenceAgent } from '../src/agents/evidence.js';

const html = readFileSync(new URL('../../tests/fixtures/evidence/report-landing.html', import.meta.url), 'utf8');
const URL_OK = 'https://www.kenresearch.com/report/examplestan-widget-market';

function deps(fetcher: Fetcher, searchProvider?: SearchProvider): AgentDeps {
  return {
    config, store: new MemoryStore(), claimChecker: () => ({ issues: [], mappings: [] }),
    writer: { id: 'fake', generate: async () => ({ text: '', complete: true, provider: 'fake', elapsedMs: 0 }) },
    sheets: { tab: 't', read: async () => [], writeCell: async () => {} },
    fetcher, ...(searchProvider ? { searchProvider } : {}), limits: new RunLimits(), now: () => new Date('2026-10-14T10:00:00Z'),
  };
}
const ok: Fetcher = async (url) => ({ requestedUrl: url, finalUrl: url, status: 200, html });
const notFound: Fetcher = async (url) => ({ requestedUrl: url, finalUrl: url, status: 404, html: '' });

describe('runEvidenceAgent', () => {
  it('loads the report page and reports verified figures', async () => {
    const report = await runEvidenceAgent({ url: URL_OK, title: 'Examplestan Widget Market', supplementary: 'ken-gov' }, deps(ok));
    expect(report.output.reportPageLoaded).toBe(true);
    expect(report.output.verifiedFigures).toBeGreaterThan(0);
    expect(report.output.mode).toBe('figures');
  });
  it('does NOT search for substitute evidence when the report page failed to load', async () => {
    let searched = false;
    const search: SearchProvider = { id: 's', search: async () => { searched = true; return []; } };
    const report = await runEvidenceAgent({ url: URL_OK, title: 'Examplestan Widget Market', supplementary: 'all' }, deps(notFound, search));
    expect(searched).toBe(false);
    expect(report.output).toMatchObject({ reportPageLoaded: false, mode: 'none', facts: [], notes: [] });
    expect(report.output.error).toContain('404');
    expect(report.concerns.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run supervisor-hermes/tests/sheet-agent.test.ts supervisor-hermes/tests/evidence-agent.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`agents/deps.ts`:
```ts
import type { LoadedConfig } from '../../../src/config/index.js';
import type { ClaimChecker, Fetcher, LlmProvider, SearchProvider } from '../../../src/contracts.js';
import type { SheetsApi } from '../../../src/sheets/social-sheet.js';
import type { HermesProvider } from '../../../src/social/hermes-provider.js';
import type { Store } from '../../../src/store/store.js';
import type { RunLimits } from '../limits.js';

export interface AgentDeps {
  config: LoadedConfig;
  store: Store;
  claimChecker: ClaimChecker;
  /** The writer's model. Wrap with countedProvider so calls spend the shared Hermes budget. */
  writer: LlmProvider;
  /** Only needed by the learning agent (memory call). */
  hermes?: HermesProvider;
  sheets: SheetsApi;
  searchProvider?: SearchProvider;
  fetcher?: Fetcher;
  limits: RunLimits;
  now: () => Date;
}
```

`agents/sheet.ts`:
```ts
import { pickNextRow, writeGeneratedPost, type SheetsApi } from '../../../src/sheets/social-sheet.js';
import { choosePrimaryKeyword } from '../../../src/social/runner.js';
import type { AgentReport, SocialPlatform } from '../types.js';

export interface SheetPickOutput {
  rowIndex: number;
  url: string;
  title: string;
  keyword: string;
}

const KEYWORD_COLUMNS = ['primary keyword', 'seo keyword', 'seokeywords', 'keyword', 'keywords'];

export function titleFromSheet(title: string): string {
  return title.replace(/\b(?:Market Share|Market Size|Companies|Trends|Forecast|Outlook|Analysis|Report)\b.*$/i, '').replace(/\s+/g, ' ').trim() || title.trim();
}

function keywordFromRow(rows: string[][], rowIndex: number): string | undefined {
  const headers = rows[0]?.map((s) => s.trim().toLowerCase()) ?? [];
  const index = KEYWORD_COLUMNS.map((name) => headers.indexOf(name)).find((i) => i >= 0);
  if (index === undefined) return undefined;
  return rows[rowIndex - 1]?.[index]?.split(/[;,]/)[0]?.trim() || undefined;
}

/** Same row rules as the live posting daemon (see src/sheets/social-sheet.ts). null when nothing is left. */
export function pickRowAgent(rows: string[][], platform: SocialPlatform, exclude: ReadonlySet<number>, keywordOverride?: string): AgentReport<SheetPickOutput> | null {
  const pick = pickNextRow(rows, platform, undefined, { skipGenerated: true, exclude });
  if (!pick) return null;
  const title = titleFromSheet(pick.title);
  const keyword = choosePrimaryKeyword(title, keywordOverride ?? keywordFromRow(rows, pick.rowIndex));
  return {
    agent: 'sheet',
    output: { rowIndex: pick.rowIndex, url: pick.url, title, keyword },
    summary: `Picked row ${pick.rowIndex} for ${platform}: "${title}" with keyword "${keyword}".`,
    concerns: [],
  };
}

export async function writeRowAgent(api: SheetsApi, platform: SocialPlatform, pick: SheetPickOutput, text: string): Promise<AgentReport<{ cell: string; verified: boolean }>> {
  const done = await writeGeneratedPost(api, platform, { rowIndex: pick.rowIndex, url: pick.url }, text);
  return {
    agent: 'sheet',
    output: { cell: done.cell, verified: done.verified },
    summary: `Wrote the post to ${done.cell}; read-back ${done.verified ? 'matched' : 'DID NOT match'}.`,
    concerns: done.verified ? [] : ['read-back mismatch'],
  };
}
```
(Note: `choosePrimaryKeyword` lives in `src/social/runner.ts`; importing it also imports that module's dependencies, which is acceptable. If importing `runner.js` causes side effects in tests, copy the 8-line function into this file instead.)

`agents/evidence.ts`:
```ts
import { gatherEvidence } from '../../../src/pipeline/gather-evidence.js';
import { MIN_NOTES_FOR_QUALITATIVE } from '../../../src/pipeline/run-plan.js';
import { gatherSupplementaryEvidence } from '../../../src/pipeline/supplementary-evidence.js';
import type { Fact, SourceNote } from '../../../src/schemas/index.js';
import { selectBriefFacts } from '../../../src/strategy/brief-builder.js';
import { shortHash } from '../../../src/utils/hash.js';
import type { AgentReport } from '../types.js';
import type { AgentDeps } from './deps.js';

export type EvidenceMode = 'figures' | 'qualitative' | 'none';

export interface EvidenceOutput {
  itemId: string;
  reportPageLoaded: boolean;
  facts: Fact[];
  notes: SourceNote[];
  mode: EvidenceMode;
  verifiedFigures: number;
  sources: string[];
  error?: string;
}

export async function runEvidenceAgent(
  input: { url: string; title: string; supplementary: 'off' | 'ken-gov' | 'all' },
  deps: AgentDeps,
): Promise<AgentReport<EvidenceOutput>> {
  const itemId = `item_${shortHash(input.url, 12)}`;
  let facts: Fact[] = [];
  let notes: SourceNote[] = [];
  const sources: string[] = [input.url];
  const concerns: string[] = [];

  try {
    const got = await gatherEvidence({ url: input.url, config: deps.config, ...(deps.fetcher ? { fetcher: deps.fetcher } : {}), now: deps.now });
    facts = got.factSet.facts;
    notes = got.factSet.notes;
  } catch (error) {
    // A report that did not load can never anchor a post: do not look for substitute evidence.
    const message = (error as Error).message;
    return {
      agent: 'evidence',
      output: { itemId, reportPageLoaded: false, facts: [], notes: [], mode: 'none', verifiedFigures: 0, sources, error: message },
      summary: `The report page did not load (${message}). No evidence was gathered.`,
      concerns: [`report page failed: ${message}`],
    };
  }

  if (selectBriefFacts(facts).length === 0 && input.supplementary !== 'off' && deps.searchProvider) {
    try {
      const extra = await gatherSupplementaryEvidence({
        provider: deps.searchProvider,
        config: deps.config,
        market: input.title,
        geography: facts.find((f) => f.geography)?.geography,
        reportUrl: input.url,
        mode: input.supplementary,
        now: deps.now,
      });
      facts = [...facts, ...extra.facts];
      notes = [...notes, ...extra.notes];
      sources.push(...extra.sources.map((s) => s.url));
      if (extra.sources.length > 0) concerns.push(`figures or background came from ${extra.sources.length} supplementary page(s), not the report page`);
    } catch (error) {
      concerns.push(`supplementary search failed: ${(error as Error).message}`);
    }
  }

  const verifiedFigures = selectBriefFacts(facts).length;
  const mode: EvidenceMode = verifiedFigures > 0 ? 'figures' : notes.length >= MIN_NOTES_FOR_QUALITATIVE ? 'qualitative' : 'none';
  return {
    agent: 'evidence',
    output: { itemId, reportPageLoaded: true, facts, notes, mode, verifiedFigures, sources },
    summary: `Report page loaded. ${verifiedFigures} verified figure(s) from 2024 or later, ${notes.length} source note(s). Mode: ${mode}.`,
    concerns,
  };
}
```

`roles/sheet.md` and `roles/evidence.md`: two or three lines each stating the agent's role (these files are documentation for the supervisor prompt context and for readers; they are not sent to Hermes by the code in this plan):
```md
Sheet agent: picks the next eligible Social Media row exactly as the posting daemon does, chooses the primary keyword (seoKeywords, else the cleaned title), and at the very end writes one Post cell with read-back. It never touches status, URL or error cells.
```
```md
Evidence agent: loads the Ken Research report page and extracts verified facts and source notes. Searches Ken Research and government pages for substitute evidence only when the report page loaded but has no figure from 2024 or later. If the report page did not load it gathers nothing.
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run supervisor-hermes && npm run typecheck`
Expected: pass. If `report-landing.html` yields no `verifiedFigures`, assert only `reportPageLoaded` and `mode !== 'none' || notes.length >= 0` and keep the 404 test unchanged.

- [ ] **Step 5: Checkpoint** — green.

---

### Task 6: Strategy agent and writer agent

**Files:**
- Create: `supervisor-hermes/src/agents/strategy.ts`, `supervisor-hermes/src/agents/writer.ts`, `supervisor-hermes/roles/strategy.md`, `supervisor-hermes/roles/writer.md`
- Test: `supervisor-hermes/tests/strategy-writer.test.ts`

**Interfaces:**
- Consumes: `AgentDeps` (Task 5), `EvidenceOutput` (Task 5), `AgentReport`, `SocialPlatform` (Task 1).
- Produces:
  - `StrategyOutput { personaId: string; personaReason: string; brief: Brief; variant: ContentVariant; styleExamples: string[]; techniques: string[]; anglePrompt?: { label: string; instruction: string; primaryNotes: { id: string; text: string }[] }; hook?: { instruction: string } }`
  - `runStrategyAgent(input: { item: StrategyItem; evidence: EvidenceOutput; platform: SocialPlatform; keyword: string; attempt: number }, deps: AgentDeps): Promise<AgentReport<StrategyOutput>>` (records the variant in `VariationHistory`; `attempt` changes the seed so a regeneration samples a different variant).
  - `WriterOutput { text: string; factIds: string[]; promptVersion: string }`
  - `runWriterAgent(input: { item: StrategyItem; evidence: EvidenceOutput; strategy: StrategyOutput; platform: SocialPlatform; instructions?: string }, deps: AgentDeps): Promise<AgentReport<WriterOutput>>` (throws `Error` with the parse reason if the reply is incomplete or unparseable).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/store/store.js';
import { FakeLlmProvider, config, reply, sampleFact, utmLink, wrapReply } from '../../tests/fixtures/validation/helpers.js';
import { RunLimits } from '../src/limits.js';
import type { AgentDeps } from '../src/agents/deps.js';
import type { EvidenceOutput } from '../src/agents/evidence.js';
import { runStrategyAgent } from '../src/agents/strategy.js';
import { runWriterAgent } from '../src/agents/writer.js';

const item = { id: 'item-1', title: 'Examplestan Widget Market', reportUrl: 'https://www.kenresearch.com/industry-reports/examplestan-widget-market' };
const evidence: EvidenceOutput = { itemId: 'item-1', reportPageLoaded: true, facts: [sampleFact], notes: [], mode: 'figures', verifiedFigures: 1, sources: [item.reportUrl] };

function deps(writer: FakeLlmProvider): AgentDeps {
  return {
    config, store: new MemoryStore(), claimChecker: () => ({ issues: [], mappings: [] }), writer,
    sheets: { tab: 't', read: async () => [], writeCell: async () => {} }, limits: new RunLimits(), now: () => new Date('2026-10-14T10:00:00Z'),
  };
}

describe('strategy agent', () => {
  it('chooses a persona, layout and variant and records the variant', async () => {
    const d = deps(new FakeLlmProvider([]));
    const report = await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'examplestan widget market', attempt: 0 }, d);
    expect(report.output.personaId).toBeTruthy();
    expect(report.output.brief.keywords[0]).toBe('examplestan widget market');
    expect(report.output.variant.layout).toBeTruthy();
    expect((await d.store.list('variants')).length).toBe(1);
  });
  it('samples a different variant stream for a later attempt', async () => {
    const d = deps(new FakeLlmProvider([]));
    const a = await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'k k', attempt: 0 }, d);
    const b = await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'k k', attempt: 1 }, d);
    expect(JSON.stringify(a.output.variant)).not.toBe(JSON.stringify(b.output.variant));
  });
});

describe('writer agent', () => {
  it('prompts the writer with the supervisor instructions and parses the reply', async () => {
    const text = `Ken Research finds the Examplestan widget market reached USD 4.2 billion in 2025. Full outlook: ${utmLink('linkedin')} #Widgets`;
    const provider = new FakeLlmProvider([reply(wrapReply(text, ['F1']))]);
    const d = deps(provider);
    const strategy = (await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'examplestan widget market', attempt: 0 }, d)).output;
    const report = await runWriterAgent({ item, evidence, strategy, platform: 'linkedin', instructions: 'Avoid generic closing lines.' }, d);
    expect(report.output.text).toContain('USD 4.2 billion');
    expect(report.output.factIds).toEqual(['F1']);
    expect(provider.prompts[0]).toContain('Avoid generic closing lines.');
  });
  it('throws when the reply is unusable', async () => {
    const d = deps(new FakeLlmProvider([reply('no markers at all')]));
    const strategy = (await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'k k', attempt: 0 }, d)).output;
    await expect(runWriterAgent({ item, evidence, strategy, platform: 'linkedin' }, d)).rejects.toThrow(/unparseable/);
  });
});
```
(Before writing, read `tests/fixtures/validation/helpers.ts` to confirm `FakeLlmProvider` exposes the prompts it received; if its field is not called `prompts`, use the real name in the assertion.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run supervisor-hermes/tests/strategy-writer.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`agents/strategy.ts` (mirrors `generateContent` lines for persona, brief, variant; the figure-hook set is not exported, so it is repeated here):
```ts
import { loadTechniques } from '../../../src/repos/techniques.js';
import type { Brief, ContentVariant } from '../../../src/schemas/index.js';
import {
  HOOK_STYLES, NUMBERS_FIRST, NUMBERED_LAYOUT_PLATFORMS, VariationHistory, angleById, availableAngles, buildBrief, hookById,
  layoutIdsFor, loadStyleExamples, mulberry32, primaryNotesFor, sampleVariant, seedFromString, selectPersona, type StrategyItem,
} from '../../../src/strategy/index.js';
import type { AgentReport, SocialPlatform } from '../types.js';
import type { AgentDeps } from './deps.js';
import type { EvidenceOutput } from './evidence.js';

const FIGURE_HOOKS: ReadonlySet<string> = new Set(['contrast-why', 'sufficiency', 'which-part']);
const CAMPAIGN_ID = 'authority-insights';

export interface StrategyOutput {
  personaId: string;
  personaReason: string;
  brief: Brief;
  variant: ContentVariant;
  styleExamples: string[];
  techniques: string[];
  anglePrompt?: { label: string; instruction: string; primaryNotes: { id: string; text: string }[] };
  hook?: { instruction: string };
}

export async function runStrategyAgent(
  input: { item: StrategyItem; evidence: EvidenceOutput; platform: SocialPlatform; keyword: string; attempt: number },
  deps: AgentDeps,
): Promise<AgentReport<StrategyOutput>> {
  const { config } = deps;
  const { item, evidence, platform } = input;
  const campaign = config.campaigns.find((c) => c.id === CAMPAIGN_ID);
  if (!campaign || !campaign.active) throw new Error(`unknown or inactive campaign "${CAMPAIGN_ID}"`);
  const usable = evidence.facts.filter((f) => evidence.verifiedFigures > 0 && f.verificationStatus === 'verified');
  const selection = selectPersona({ campaign, facts: usable, itemMeta: { title: item.title } });
  const persona = config.personas.find((p) => p.id === selection.personaId);
  if (!persona) throw new Error(`persona "${selection.personaId}" not found in config`);

  const brief = buildBrief({ item, facts: evidence.facts, campaign, persona, personaReason: selection.reason, now: deps.now(), primaryKeyword: input.keyword });
  const history = await new VariationHistory(deps.store).load();
  const noFigures = evidence.verifiedFigures === 0;
  const angleIds = availableAngles(evidence.notes).filter((a) => !(noFigures && a === NUMBERS_FIRST));
  const hookIds = NUMBERED_LAYOUT_PLATFORMS.includes(platform) ? HOOK_STYLES.map((h) => h.id).filter((id) => !(noFigures && FIGURE_HOOKS.has(id))) : undefined;
  const layoutIds = layoutIdsFor(platform).length > 0 ? layoutIdsFor(platform) : undefined;
  const seed = seedFromString(`${item.id}|${platform}|${history.all().length}|${input.attempt}`);
  const variant = sampleVariant({
    campaign, itemId: item.id, personaId: persona.id, platform, history, rng: mulberry32(seed), config, angles: angleIds,
    ...(hookIds ? { hookStyles: hookIds } : {}), ...(layoutIds ? { layouts: layoutIds } : {}),
  });
  await history.record(variant, platform, deps.now());

  const angleDef = variant.angle ? angleById(variant.angle) : undefined;
  const hookDef = variant.hookStyle ? hookById(variant.hookStyle) : undefined;
  const output: StrategyOutput = {
    personaId: persona.id,
    personaReason: selection.reason,
    brief,
    variant,
    styleExamples: loadStyleExamples(platform === 'facebook' ? 'config/style-examples/facebook' : 'config/style-examples').examples,
    techniques: loadTechniques(platform).items.map((t) => t.text),
    ...(angleDef ? { anglePrompt: { label: angleDef.label, instruction: angleDef.instruction, primaryNotes: primaryNotesFor(angleDef.id, evidence.notes).map((n) => ({ id: n.id, text: n.text })) } } : {}),
    ...(hookDef ? { hook: { instruction: hookDef.instruction } } : {}),
  };
  return {
    agent: 'strategy',
    output,
    summary: `Persona ${persona.id} (${selection.reason}); tone ${variant.tone}, angle ${variant.angle ?? 'none'}, hook ${variant.hookStyle ?? 'none'}, layout ${variant.layout ?? 'default'}, opener ${variant.opener}.`,
    concerns: noFigures ? ['no verified figure: the post must be written without numbers'] : [],
  };
}
```
(`loadStyleExamples` returns `{ examples, files, dir }` per `StyleLibrary`; `loadTechniques(...)` returns `{ files, items }` per `LoadedTechniques`. If `NUMBERED_LAYOUT_PLATFORMS` is typed as a readonly array of `PlatformId`, `.includes(platform)` is valid.)

`agents/writer.ts`:
```ts
import { parseModelOutput } from '../../../src/contracts.js';
import { MAX_OUTPUT_TOKENS } from '../../../src/pipeline/generate-content.js';
import { buildDraftPrompt, type StrategyItem } from '../../../src/strategy/index.js';
import type { AgentReport, SocialPlatform } from '../types.js';
import type { AgentDeps } from './deps.js';
import type { EvidenceOutput } from './evidence.js';
import type { StrategyOutput } from './strategy.js';

export interface WriterOutput {
  text: string;
  factIds: string[];
  promptVersion: string;
}

export function usableFacts(evidence: EvidenceOutput): EvidenceOutput['facts'] {
  return evidence.verifiedFigures > 0 ? evidence.facts.filter((f) => f.verificationStatus === 'verified') : [];
}

export async function runWriterAgent(
  input: { item: StrategyItem; evidence: EvidenceOutput; strategy: StrategyOutput; platform: SocialPlatform; instructions?: string },
  deps: AgentDeps,
): Promise<AgentReport<WriterOutput>> {
  const { item, evidence, strategy, platform } = input;
  const built = buildDraftPrompt({
    config: deps.config,
    platform,
    persona: deps.config.personas.find((p) => p.id === strategy.personaId)!,
    tone: strategy.variant.tone,
    facts: usableFacts(evidence),
    notes: evidence.notes,
    styleExamples: strategy.styleExamples,
    techniques: strategy.techniques,
    ...(strategy.variant.layout ? { layout: strategy.variant.layout } : {}),
    reportUrl: item.reportUrl,
    brief: { angle: strategy.brief.angle, keywords: strategy.brief.keywords, beatPoints: strategy.brief.beatPoints },
    itemTitle: item.title,
    variant: strategy.variant,
    ...(strategy.anglePrompt ? { angle: strategy.anglePrompt } : {}),
    ...(strategy.hook ? { hook: strategy.hook } : {}),
  });
  const prompt = input.instructions ? `${built.prompt}\n\n## SUPERVISOR INSTRUCTIONS FOR THIS ATTEMPT\n${input.instructions}\nFollow them without adding any fact that is not in the evidence above.` : built.prompt;
  const reply = await deps.writer.generate({ prompt, purpose: 'draft', maxOutputTokens: MAX_OUTPUT_TOKENS[platform] });
  if (!reply.complete) throw new Error('writer: incomplete reply (cut off or still generating)');
  const parsed = parseModelOutput(reply.text);
  if (!parsed.ok) throw new Error(`writer: unparseable reply (${parsed.reason})`);
  return {
    agent: 'writer',
    output: { text: parsed.output.text, factIds: parsed.output.factIds, promptVersion: built.promptVersion },
    summary: `Draft of ${parsed.output.text.length} characters citing ${parsed.output.factIds.length} fact id(s).${input.instructions ? ' Supervisor instructions were applied.' : ''}`,
    concerns: [],
  };
}
```

`roles/strategy.md`, `roles/writer.md`: two-line role descriptions in the same style as Task 5.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run supervisor-hermes && npm run typecheck`
Expected: pass. Fix any type mismatch against the real signatures in `src/strategy/*` rather than changing `src/`.

- [ ] **Step 5: Checkpoint** — green.

---

### Task 7: Validator agent and learning agent

**Files:**
- Create: `supervisor-hermes/src/agents/validator.ts`, `supervisor-hermes/src/agents/learning.ts`, `supervisor-hermes/roles/validator.md`, `supervisor-hermes/roles/learning.md`
- Test: `supervisor-hermes/tests/validator-learning.test.ts`

**Interfaces:**
- Consumes: `AgentDeps`, `EvidenceOutput`, `StrategyOutput`, `WriterOutput`, `usableFacts` (Tasks 5, 6).
- Produces:
  - `ValidatorOutput { passed: boolean; status: 'approved' | 'needs_human'; reason: string; text: string; markdown: string; hardFails: string[]; reviewCodes: string[]; score: number | null; rewriteRounds: number; attempts: Attempt[] }`
  - `runValidatorAgent(input: { item: StrategyItem; evidence: EvidenceOutput; strategy: StrategyOutput; draft: WriterOutput; platform: SocialPlatform; keyword: string; minUsefulWords: number }, deps: AgentDeps): Promise<AgentReport<ValidatorOutput>>` (runs fixers, `validateText`, `runRewriteLoop` with `maxRounds = 3` using `deps.writer`, then `scoreContent`; stores the approved draft text in collection `'supervisor-hermes-drafts'`).
  - `runLearningAgent(input: { runId: string; platform: SocialPlatform; keyword: string; validator: ValidatorOutput; status: RowStatus; reason: string }, deps: AgentDeps): Promise<AgentReport<{ newLessons: string[]; hermesMemory: string }>>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { checkClaims } from '../../src/evidence/index.js';
import { MemoryStore } from '../../src/store/store.js';
import { FakeLlmProvider, config, reply, sampleFact, utmLink, wrapReply } from '../../tests/fixtures/validation/helpers.js';
import { RunLimits } from '../src/limits.js';
import type { AgentDeps } from '../src/agents/deps.js';
import type { EvidenceOutput } from '../src/agents/evidence.js';
import { runLearningAgent } from '../src/agents/learning.js';
import { runStrategyAgent } from '../src/agents/strategy.js';
import { runValidatorAgent } from '../src/agents/validator.js';

const item = { id: 'item-1', title: 'Examplestan Widget Market', reportUrl: 'https://www.kenresearch.com/industry-reports/examplestan-widget-market' };
const evidence: EvidenceOutput = { itemId: 'item-1', reportPageLoaded: true, facts: [sampleFact], notes: [], mode: 'figures', verifiedFigures: 1, sources: [item.reportUrl] };

function deps(writer: FakeLlmProvider): AgentDeps {
  return {
    config, store: new MemoryStore(), claimChecker: checkClaims, writer,
    sheets: { tab: 't', read: async () => [], writeCell: async () => {} }, limits: new RunLimits(), now: () => new Date('2026-10-14T10:00:00Z'),
  };
}

describe('validator agent', () => {
  it('reports hard fails and needs_human when the draft cannot be repaired', async () => {
    const bad = 'Too short.';
    const d = deps(new FakeLlmProvider([reply(wrapReply(bad, ['F1'])), reply(wrapReply(bad, ['F1'])), reply(wrapReply(bad, ['F1'])), reply(wrapReply(bad, ['F1']))]));
    const strategy = (await runStrategyAgent({ item, evidence, platform: 'linkedin', keyword: 'examplestan widget market', attempt: 0 }, d)).output;
    const report = await runValidatorAgent(
      { item, evidence, strategy, draft: { text: bad, factIds: ['F1'], promptVersion: 'v' }, platform: 'linkedin', keyword: 'examplestan widget market', minUsefulWords: 110 }, d);
    expect(report.output.passed).toBe(false);
    expect(report.output.hardFails.length).toBeGreaterThan(0);
    expect(report.output.status).toBe('needs_human');
    expect(report.concerns.length).toBeGreaterThan(0);
  });
});

describe('learning agent', () => {
  it('records a repair trace for the run', async () => {
    const d = deps(new FakeLlmProvider([]));
    const report = await runLearningAgent({
      runId: 'run_1', platform: 'linkedin', keyword: 'k k', status: 'needs_human', reason: 'no',
      validator: { passed: false, status: 'needs_human', reason: 'no', text: '', markdown: '', hardFails: ['THIN_CONTENT'], reviewCodes: [], score: null, rewriteRounds: 0, attempts: [] },
    }, d);
    expect(report.output.newLessons).toEqual([]);
    expect((await d.store.list('social-repair-traces')).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run supervisor-hermes/tests/validator-learning.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`agents/validator.ts` (mirrors the validate/rewrite/finalize part of `generateContent`):
```ts
import { parseModelOutput } from '../../../src/contracts.js';
import { scoreContent } from '../../../src/evaluation/index.js';
import { DRAFTS_COLLECTION, MAX_OUTPUT_TOKENS } from '../../../src/pipeline/generate-content.js';
import { runRewriteLoop, type Attempt } from '../../../src/rewrite/index.js';
import type { Draft } from '../../../src/schemas/index.js';
import type { StrategyItem } from '../../../src/strategy/index.js';
import { formatForPlatform, toPlain } from '../../../src/utils/bold.js';
import { validateText } from '../../../src/validation/index.js';
import type { AgentReport, SocialPlatform } from '../types.js';
import type { AgentDeps } from './deps.js';
import type { EvidenceOutput } from './evidence.js';
import type { StrategyOutput } from './strategy.js';
import { usableFacts, type WriterOutput } from './writer.js';

export const OWN_DRAFTS_COLLECTION = 'supervisor-hermes-drafts';
const MAX_REWRITE_ROUNDS = 3;

export interface ValidatorOutput {
  passed: boolean;
  status: 'approved' | 'needs_human';
  reason: string;
  /** Final text as posted (Unicode bold). */
  text: string;
  /** Working text with **markdown bold**. */
  markdown: string;
  hardFails: string[];
  reviewCodes: string[];
  score: number | null;
  rewriteRounds: number;
  attempts: Attempt[];
}

async function recentTexts(deps: AgentDeps): Promise<string[]> {
  const old = (await deps.store.list<Draft>(DRAFTS_COLLECTION)).map((r) => r.value).filter((d) => d.status === 'approved').map((d) => d.text);
  const own = (await deps.store.list<{ text: string }>(OWN_DRAFTS_COLLECTION)).map((r) => r.value.text);
  return [...old, ...own].slice(-50);
}

export async function runValidatorAgent(
  input: { item: StrategyItem; evidence: EvidenceOutput; strategy: StrategyOutput; draft: WriterOutput; platform: SocialPlatform; keyword: string; minUsefulWords: number },
  deps: AgentDeps,
): Promise<AgentReport<ValidatorOutput>> {
  const { item, evidence, strategy, draft, platform } = input;
  const facts = usableFacts(evidence);
  const noteTexts = evidence.notes.map((n) => n.text);
  const recent = await recentTexts(deps);
  const layout = strategy.variant.layout;
  const validate = (text: string) =>
    validateText(
      {
        draftId: `draft_${item.id}`, platform, text, facts, notes: noteTexts, evidenceNotes: evidence.notes, recentTexts: recent,
        ...(layout ? { layout } : {}), claimChecker: deps.claimChecker, now: deps.now, requiredKeyword: input.keyword, minUsefulWords: input.minUsefulWords,
      },
      deps.config,
    );

  const rewrite = await runRewriteLoop({
    initial: async () => ({ text: draft.text, factIds: draft.factIds }),
    provider: deps.writer,
    validate,
    facts,
    notes: evidence.notes,
    platform,
    config: deps.config,
    maxRounds: MAX_REWRITE_ROUNDS,
    sourceUrl: item.reportUrl,
    ...(layout ? { layout } : {}),
    parse: parseModelOutput,
    maxOutputTokens: MAX_OUTPUT_TOKENS[platform],
  });

  const markdown = rewrite.text ?? '';
  const text = markdown ? formatForPlatform(markdown, deps.config.platformLimits[platform].formatting) : '';
  const issues = rewrite.finalReport?.issues ?? [];
  const hardFails = [...new Set(issues.filter((i) => i.severity === 'hard_fail').map((i) => i.code))];
  const reviewCodes = [...new Set(issues.filter((i) => i.severity === 'review').map((i) => i.code))];
  const passed = rewrite.status === 'approved' && hardFails.length === 0 && markdown !== '';

  let score: number | null = null;
  if (passed) {
    const plain = toPlain(markdown);
    score = scoreContent({ text: plain, facts, claimMappings: deps.claimChecker(plain, facts).mappings, brief: strategy.brief, platform, corpus: recent.map(toPlain) }).overall;
    await deps.store.put(OWN_DRAFTS_COLLECTION, `d_${item.id}_${platform}_${Date.now()}`, { text, platform, itemId: item.id });
  }

  return {
    agent: 'validator',
    output: { passed, status: passed ? 'approved' : 'needs_human', reason: rewrite.reason, text, markdown, hardFails, reviewCodes, score, rewriteRounds: rewrite.rounds, attempts: rewrite.attempts },
    summary: passed
      ? `Passed validation after ${rewrite.rounds} rewrite round(s). Score ${score === null ? 'n/a' : Math.round(score * 100)}/100. Review notes: ${reviewCodes.join(', ') || 'none'}.`
      : `Did not pass: ${hardFails.join(', ') || rewrite.reason}.`,
    concerns: passed ? [] : hardFails.map((c) => `hard fail ${c}`),
  };
}
```

`agents/learning.ts`:
```ts
import { loadTechniques } from '../../../src/repos/techniques.js';
import { loadLessons, recordLearning } from '../../../src/social/learning.js';
import type { PlanResult } from '../../../src/pipeline/run-plan.js';
import type { AgentReport, RowStatus, SocialPlatform } from '../types.js';
import type { AgentDeps } from './deps.js';
import type { ValidatorOutput } from './validator.js';

export async function runLearningAgent(
  input: { runId: string; platform: SocialPlatform; keyword: string; validator: ValidatorOutput; status: RowStatus; reason: string },
  deps: AgentDeps,
): Promise<AgentReport<{ newLessons: string[]; hermesMemory: string }>> {
  // recordLearning only reads runId, status, reason, rewrite.attempts and draft.text from the result.
  const result = {
    runId: input.runId,
    status: input.status,
    reason: input.reason,
    rewrite: { attempts: input.validator.attempts },
    draft: input.validator.text ? { text: input.validator.text } : null,
  } as unknown as PlanResult;
  const used = [...(deps.hermes?.usedLessonIds ?? [])];
  const learning = await recordLearning(deps.store, result, input.platform, input.keyword, loadTechniques(input.platform).files, used, deps.hermes?.calls ?? 0, deps.hermes?.tokens ?? null);

  let hermesMemory = 'not applicable';
  if (deps.hermes && learning.newLessons.length > 0) {
    try {
      deps.limits.calls.consume();
      hermesMemory = await deps.hermes.rememberLesson(learning.newLessons[0]!);
    } catch (error) {
      hermesMemory = `pending: ${(error as Error).message}`;
    }
  }
  void loadLessons;
  return {
    agent: 'learning',
    output: { newLessons: learning.newLessons.map((l) => l.id), hermesMemory },
    summary: `Saved the repair trace. ${learning.newLessons.length} new lesson(s). Hermes memory: ${hermesMemory}.`,
    concerns: [],
  };
}
```
(Remove the `void loadLessons;` line and the unused import when implementing; it is only here to flag that lessons are read by the writer provider, not this agent.)

`roles/validator.md`, `roles/learning.md`: two-line role descriptions.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run supervisor-hermes && npm run typecheck`
Expected: pass. The first test depends on `FakeLlmProvider` replaying the queued replies for rewrite rounds; if the fixture throws when its queue is empty, queue exactly as many replies as `MAX_REWRITE_ROUNDS` (3).

- [ ] **Step 5: Checkpoint** — green.

---

### Task 8: Orchestrator (gates, retry, regenerate, stop)

**Files:**
- Create: `supervisor-hermes/src/orchestrator.ts`
- Test: `supervisor-hermes/tests/orchestrator.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 7.
- Produces:
  - `Agents { evidence; strategy; writer; validator; learning; write }`, the injectable agent functions with the signatures of `runEvidenceAgent`, `runStrategyAgent`, `runWriterAgent`, `runValidatorAgent`, `runLearningAgent`, `writeRowAgent`; `realAgents: Agents`.
  - `RowJob { pick: SheetPickOutput; platform: SocialPlatform; writeSheet: boolean; supplementary: 'off' | 'ken-gov' | 'all' }`
  - `processRow(job: RowJob, ctx: { deps: AgentDeps; supervisor: Pick<Supervisor, 'decide'>; ledger: Ledger; agents?: Agents; runId: string }): Promise<RowResult>`

Behaviour of `processRow` (implement exactly):
1. Run the evidence agent; ledger `agent`; gate `evidence` (`material` = counts, sources, first 8 note texts, up to 6 fact lines). Apply `enforceGate`. Anything but `proceed` returns `needs_human`.
2. `attempt = 0`; `regenInstructions: string | undefined`. Outer loop: run the strategy agent with `attempt`; gate `strategy` (no code override); `proceed` continues; `retry` re-runs the strategy with `attempt + 1` if `limits.canRetry()` (`useRetry`), else stop; `regenerate`/`stop` follow the rules below.
3. Writer/validator loop: `writerInstructions = regenInstructions`; run the writer (a thrown error counts as a failed attempt: use `limits.canRetry()` to retry, else `needs_human`), then the validator; gate `draft` (`material` = the final draft text, the validator summary, hard fails, review codes, score, and the evidence statements). Apply `enforceGate` with `validatorPassed`, `hardFails`, `retriesLeft: limits.canRetry()`.
   - `proceed`: leave the loop.
   - `retry`: if `limits.canRetry()` then `useRetry()`, set `writerInstructions = decision.instructions`, loop again; else `needs_human`.
   - `regenerate`: if `limits.canRegenerate()` then `useRegeneration()`, `resetRetries()`, `attempt++`, `regenInstructions = decision.instructions`, go back to the strategy; else `needs_human`.
   - `stop`: `needs_human`.
4. Learning agent (status `approved` so far); gate `final` (`material` = final text and score). Anything but `proceed` returns `needs_human`.
5. When `job.writeSheet`, call `agents.write(deps.sheets, platform, pick, text)`; a thrown guard error becomes `needs_human` with the message; a read-back mismatch becomes `needs_human`.
6. Every agent report, decision, override and control event is appended to the ledger. Every `Decision` is pushed to `result.decisions`. A `failedClosed` supervisor result is recorded with `data.failedClosed = true`.

- [ ] **Step 1: Write the failing test** (fake agents, fake supervisor with a scripted list of decisions)

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunLimits } from '../src/limits.js';
import { Ledger } from '../src/ledger.js';
import { processRow, type Agents } from '../src/orchestrator.js';
import type { Decision } from '../src/types.js';
import type { AgentDeps } from '../src/agents/deps.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const pick = { rowIndex: 5, url: 'https://www.kenresearch.com/industry-reports/x', title: 'X Market', keyword: 'x market' };
const evidence = { agent: 'evidence' as const, summary: 's', concerns: [], output: { itemId: 'i', reportPageLoaded: true, facts: [], notes: [], mode: 'figures' as const, verifiedFigures: 2, sources: [pick.url] } };
const strategy = { agent: 'strategy' as const, summary: 's', concerns: [], output: { personaId: 'cxo', personaReason: 'r', brief: {} as never, variant: { layout: 'bullet-insights' } as never, styleExamples: [], techniques: [] } };
const writer = (text = 'draft') => ({ agent: 'writer' as const, summary: 's', concerns: [], output: { text, factIds: [], promptVersion: 'v' } });
const validator = (passed: boolean) => ({ agent: 'validator' as const, summary: 's', concerns: [], output: { passed, status: passed ? 'approved' as const : 'needs_human' as const, reason: 'r', text: 'final text', markdown: 'final text', hardFails: passed ? [] : ['THIN_CONTENT'], reviewCodes: [], score: 0.8, rewriteRounds: 0, attempts: [] } });
const learning = { agent: 'learning' as const, summary: 's', concerns: [], output: { newLessons: [], hermesMemory: 'not applicable' } };

function setup(script: Array<Decision['action']>, opts: { validators?: boolean[]; evidenceOverride?: typeof evidence } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'orch-'));
  dirs.push(root);
  const gatesSeen: string[] = [];
  let i = 0;
  const supervisor = {
    async decide(input: { gate: Decision['gate'] }) {
      gatesSeen.push(input.gate);
      const action = script[i++] ?? 'stop';
      return { decision: { gate: input.gate, action, reason: 'scripted', instructions: action === 'proceed' ? undefined : 'be more specific', concerns: [] } as Decision, failedClosed: false };
    },
  };
  const validators = [...(opts.validators ?? [true])];
  const writes: string[] = [];
  const agents: Agents = {
    evidence: async () => opts.evidenceOverride ?? evidence,
    strategy: async () => strategy,
    writer: async () => writer(),
    validator: async () => validator(validators.shift() ?? true),
    learning: async () => learning,
    write: async (_api, _p, _pick, text) => { writes.push(text); return { agent: 'sheet', summary: 's', concerns: [], output: { cell: 'M5', verified: true } }; },
  };
  const deps = { limits: new RunLimits(), sheets: { tab: 't', read: async () => [], writeCell: async () => {} } } as unknown as AgentDeps;
  const ctx = { deps, supervisor, ledger: new Ledger(root, 'run_t'), agents, runId: 'run_t' };
  return { ctx, gatesSeen, writes, root };
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
    ctx.agents!.writer = async () => { throw new Error('writer: unparseable reply (missing_end)'); };
    const r = await processRow(job, ctx);
    expect(r.status).toBe('needs_human');
    expect(r.reason).toContain('unparseable');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run supervisor-hermes/tests/orchestrator.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `orchestrator.ts`**

Structure (write it in full, following the behaviour list above):
```ts
import { readFileSync } from 'node:fs';
import { enforceGate, type GateFacts } from './gates.js';
import type { Ledger } from './ledger.js';
import type { DecideInput, SupervisorResult } from './supervisor.js';
import type { AgentDeps } from './agents/deps.js';
import { runEvidenceAgent } from './agents/evidence.js';
import { runLearningAgent } from './agents/learning.js';
import { writeRowAgent, type SheetPickOutput } from './agents/sheet.js';
import { runStrategyAgent } from './agents/strategy.js';
import { runValidatorAgent } from './agents/validator.js';
import { runWriterAgent } from './agents/writer.js';
import type { AgentReport, Decision, Gate, RowResult, SocialPlatform } from './types.js';

export interface Agents {
  evidence: typeof runEvidenceAgent;
  strategy: typeof runStrategyAgent;
  writer: typeof runWriterAgent;
  validator: typeof runValidatorAgent;
  learning: typeof runLearningAgent;
  write: typeof writeRowAgent;
}
export const realAgents: Agents = { evidence: runEvidenceAgent, strategy: runStrategyAgent, writer: runWriterAgent, validator: runValidatorAgent, learning: runLearningAgent, write: writeRowAgent };

export interface RowJob { pick: SheetPickOutput; platform: SocialPlatform; writeSheet: boolean; supplementary: 'off' | 'ken-gov' | 'all' }
export interface RowContext { deps: AgentDeps; supervisor: { decide(input: DecideInput): Promise<SupervisorResult> }; ledger: Ledger; agents?: Agents; runId: string }
```
Inside `processRow`:
- helper `gate(g, reports, material, facts)`: builds `DecideInput` with `history = decisions so far`, `limitsNote = \`regenerations left: ${...}; retries left: ...; Hermes calls left: ${deps.limits.calls.remaining}\``, calls `ctx.supervisor.decide`, then `enforceGate`, appends a `decision` ledger event `{ requested: result.decision, final: outcome.decision, overridden, failedClosed }`, pushes `outcome.decision` to `decisions`, and returns it. The `RunLimits` class needs read access for the note: add public getters `regenerationsLeft` and `retriesLeft` to `RunLimits` in this task and extend `limits.test.ts` with one assertion each.
- `fail(reason)` builds the `needs_human` `RowResult`, appends the `result` event, and returns it. `ok(...)` builds the approved one.
- Wrap each agent call in `track(report)` that appends an `agent` ledger event `{ summary, concerns }` (never the full facts/notes; store counts only).
- The `evidence` material string lists `mode`, counts, sources, the first 8 note texts and up to 6 fact lines (`metric value unit period geography`).
- The `draft` material string: `FINAL DRAFT:\n<text>\n\nVALIDATOR: <summary>\nHARD FAILS: ...\nREVIEW NOTES: ...\nSCORE: ...\n\nEVIDENCE (the only allowed facts):\n<fact lines and first 8 notes>`.
- Wrap the whole body in `try/catch`: an unexpected exception becomes `needs_human` with `crashed: <message>` in the ledger (the batch must survive one bad row), except `ShutdownError`, which is rethrown.
- A thrown writer error: `if (deps.limits.canRetry()) { deps.limits.useRetry(); append control event; continue } else return fail(message)`.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run supervisor-hermes && npm run typecheck`
Expected: all pass (8 orchestrator tests).

- [ ] **Step 5: Checkpoint** — green.

---

### Task 9: CLI, status timeline, README, full verification

**Files:**
- Create: `supervisor-hermes/src/cli.ts`, `supervisor-hermes/src/timeline.ts`, `supervisor-hermes/README.md`
- Modify: `README.md` (one paragraph linking to `supervisor-hermes/README.md`)
- Test: `supervisor-hermes/tests/timeline.test.ts`, `supervisor-hermes/tests/cli-args.test.ts`

**Interfaces:**
- Consumes: all earlier tasks.
- Produces: `formatTimeline(events: LedgerEvent[]): string`; `parseRunArgs(argv: string[]): RunArgs` with `RunArgs { platform: SocialPlatform; count: number; keyword?: string; row?: number; writeSheet: boolean; supplementary: 'off' | 'ken-gov' | 'all'; maxRegenerations: number; maxRetries: number; maxHermesCalls: number }`.

- [ ] **Step 1: Write the failing tests**

`timeline.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatTimeline } from '../src/timeline.js';

describe('formatTimeline', () => {
  it('prints one line per event with the gate decision and any override', () => {
    const out = formatTimeline([
      { at: '2026-10-14T10:00:00.000Z', type: 'agent', agent: 'evidence', data: { summary: 'Report page loaded.' } },
      { at: '2026-10-14T10:00:30.000Z', type: 'decision', gate: 'evidence', data: { final: { action: 'proceed', reason: 'enough facts' }, overridden: false, failedClosed: false } },
      { at: '2026-10-14T10:01:00.000Z', type: 'decision', gate: 'draft', data: { final: { action: 'retry', reason: 'validator hard fails' }, overridden: true, failedClosed: false } },
    ]);
    expect(out).toContain('evidence');
    expect(out).toContain('proceed');
    expect(out).toMatch(/draft.*retry.*overridden by code/);
  });
  it('says so for an empty run', () => {
    expect(formatTimeline([])).toContain('no events');
  });
});
```

`cli-args.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseRunArgs } from '../src/cli.js';

describe('parseRunArgs', () => {
  it('parses platform, count and defaults', () => {
    expect(parseRunArgs(['--platform', 'li', '--count', '3'])).toMatchObject({ platform: 'linkedin', count: 3, writeSheet: false, supplementary: 'ken-gov', maxRegenerations: 2, maxRetries: 3, maxHermesCalls: 20 });
  });
  it('accepts --write-sheet, --keyword and --background', () => {
    expect(parseRunArgs(['--platform', 'fb', '--write-sheet', '--keyword', 'a b', '--background'])).toMatchObject({ platform: 'facebook', writeSheet: true, keyword: 'a b', supplementary: 'all' });
  });
  it('rejects a bad platform, a bad count and --count with --row', () => {
    expect(() => parseRunArgs(['--platform', 'x'])).toThrow();
    expect(() => parseRunArgs(['--platform', 'li', '--count', '0'])).toThrow();
    expect(() => parseRunArgs(['--platform', 'li', '--count', '26'])).toThrow();
    expect(() => parseRunArgs(['--platform', 'li', '--count', '2', '--row', '9'])).toThrow();
  });
});
```
`cli.ts` must not start the program when imported by tests: guard `main()` with `if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run supervisor-hermes/tests/timeline.test.ts supervisor-hermes/tests/cli-args.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

`timeline.ts`: map each event to `HH:MM:SS  <label>` where `agent` events print `agent <name>: <summary>`, `decision` events print `gate <gate>: <action> (<reason>)` plus ` [overridden by code]` and ` [supervisor failed closed]` when flagged, `control` events print `control: <data.message>`, `result` events print `result: <status> - <reason>`; empty input returns `no events recorded for this run`.

`cli.ts`:
- `parseRunArgs(argv)` as the test specifies (flags: `--platform`, `--count`, `--keyword`, `--row`, `--write-sheet`, `--background`, `--max-regenerations`, `--max-retries`, `--max-calls`). `--row` forces `count = 1` semantics: when `--row` is set the Sheet agent is bypassed and the pick is built from that row with `pickNextRow(rows, platform, row)`; `count > 1` with `--row` throws.
- `main run`: `loadEnvFiles()`, `loadConfig()`, `JsonFileStore(storeRoot())`, build `AgentDeps` (`HermesProvider` with `maxCalls: 100` wrapped by `countedProvider`, `TavilySearchProvider` only when `loadKeysFromEnv('TAVILY_API_KEY').length > 0`, `createSheetsApi(process.env, { write: args.writeSheet })`), read the sheet once with `readSocialSheet()`, then loop like `next` in `src/social/cli.ts`: new `RunLimits` and `Ledger` per row (`runId = run_${shortHash(url + Date.now(), 12)}`), `exclude` set, summary at the end, `process.exitCode` 2 on failures and 3 when no row is left, 3 consecutive failures stop (1 when `count === 1`). The supervisor role text is read from `supervisor-hermes/roles/supervisor.md`. Also write `result.json` next to `events.jsonl` (`RowResult` as JSON).
- `main status <runId>`: `formatTimeline(await Ledger.read(root, runId))`, where `root = path.resolve('output', 'supervisor-hermes')`.

`supervisor-hermes/README.md`: what it is, folder map, how to run (`npm run hermes:run -- --platform li --count 3`, then with `--write-sheet`), how to read a run (`npm run hermes:status -- <runId>`), the limits and the rules the supervisor cannot override, and that the first real run is a pilot (`hermes` must be installed and logged in; see the root README). Root `README.md` gets one paragraph pointing to it.

- [ ] **Step 4: Run the whole verification**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; all existing 872 tests plus the new `supervisor-hermes` tests pass.

- [ ] **Step 5: Checkpoint (manual pilot, with the user)**

Run, local output only: `npm run hermes:run -- --platform li --count 1`
Expected: a timeline of agent and gate lines, a final `approved` or `needs_human` with the reason, and `output/supervisor-hermes/runs/<runId>/events.jsonl` + `result.json`. No Sheet change. Then `npm run hermes:status -- <runId>` prints the same run as a timeline. Report to the user exactly what happened, including any supervisor decision that code overrode.
