# Supervisor Hermes: agent-wise social text generation

Date: 2026-10-14. Status: draft for review.

## Purpose

Today `runSocialJob` (src/social/runner.ts) is one script: evidence, strategy, draft, validate, repair, learning run in a fixed order and Hermes is only the text model inside the draft and rewrite calls. Nothing watches the steps.

Goal: the same Facebook and LinkedIn text, produced by **separate agents, each with its own role, input and output contract**, with a **Hermes supervisor on top** that reads every agent's report and decides whether the run proceeds, retries, regenerates or stops. A draft the supervisor judges poor is regenerated instead of passed on.

Success looks like:
- One command makes N posts from the next N Sheet rows, each agent's work and each supervisor decision recorded and readable.
- A bad draft is regenerated automatically within fixed limits; an unfixable one ends as `needs_human` and writes nothing.
- The existing engine (`src/`, `hce:*` and `legacy:*` commands, 872 tests) is unchanged in behaviour and still works.

## Non-goals

- No posting to social platforms. The posting agent still owns that.
- No new fact sources. Facts still come only from Ken Research and government pages (src/config/source-policy.config.ts).
- The supervisor does not replace validation. It adds a judgment layer on top of it.
- No autonomous scheduling in this work; `scripts/register-schedule.ps1` is out of scope.

## Location and reuse

New folder `supervisor-hermes/` at the project root. Nothing in `src/` is edited. It imports the primitives that `src/` already exports and composes them in agent-sized pieces:

| Primitive (existing) | Used by |
|---|---|
| `pickNextRow`, `readSocialSheet`, `writeGeneratedPost`, `createSheetsApi` (src/sheets) | sheet agent |
| `gatherEvidence`, `gatherSupplementaryEvidence`, `selectBriefFacts` (src/evidence, src/pipeline) | evidence agent |
| `selectPersona`, `buildBrief`, `sampleVariant`, `VariationHistory`, `loadStyleExamples`, `loadTechniques` | strategy agent |
| `buildDraftPrompt`, `parseModelOutput`, `HermesProvider` | writer agent |
| `validateText`, `applyFixers`, `runRewriteLoop`, `scoreContent`, `checkClaims` | validator agent |
| `recordLearning`, `loadLessons`, `loadRecentRepairTraces` | learning agent |

`generateContent` bundles strategy, drafting and validation in one function, so the new agents re-compose its lower-level calls instead of calling it. This duplicates roughly 100 lines of wiring on purpose; it is the price of not touching `src/`.

Two config edits are needed: add `supervisor-hermes/**/*.ts` to `tsconfig.json` `include`, and `supervisor-hermes/tests/**/*.test.ts` to `vitest.config.ts` `include`. `package.json` gets new `hermes:*` scripts.

## Layout

```
supervisor-hermes/
  README.md
  roles/                 one markdown file per agent plus supervisor.md (role text sent to Hermes)
  src/
    types.ts             zod contracts for every agent input/output and the Decision
    ledger.ts            append-only event log per run (jsonl)
    budget.ts            Hermes call budget and regenerate/retry counters
    supervisor.ts        Hermes supervisor session, decision parsing, gate rules
    gates.ts             hard rules the supervisor cannot override
    orchestrator.ts      runs the agents in order, applies decisions, handles retry/regenerate/stop
    agents/
      sheet.ts  evidence.ts  strategy.ts  writer.ts  validator.ts  learning.ts
    cli.ts               hermes:run, hermes:status
  tests/                 unit tests with a fake Hermes
```

## Agents

Each agent is a module exporting `run(input) -> AgentReport<Output>` plus its `role` text. The report carries `output`, `summary` (what it did, in a few sentences), `concerns` (anything it doubts) and `evidenceRefs` (ids it relied on). An agent never calls another agent and never advances the run; only the orchestrator does, after a decision.

| Agent | Role | Hermes? | Output |
|---|---|---|---|
| sheet | Pick the next eligible row (same rules as src/sheets/social-sheet.ts), choose the primary keyword, and at the end write one Post cell | no (code) | row, url, title, keyword; write result |
| evidence | Fetch the report page, extract verified facts and source notes, run supplementary search when no 2024+ figure exists, fall back to a number-free mode when 3+ notes exist | no (code) | facts, notes, mode (`figures` or `qualitative`) |
| strategy | Persona, angle, hook, tone, layout, opener; style examples and method packs; build the brief | no (code) | brief, variant, prompt inputs |
| writer | Produce the draft and targeted rewrites from the prompt, the supervisor's instructions and verified lessons | yes (Hermes session) | draft text, fact ids |
| validator | Run fixers and the ~40 checks, bounded rewrite rounds through the writer, claim check, score | no (code) | report, final text, pass/fail, score |
| learning | Save the repair trace, promote lessons, ask Hermes to store one procedure after an approved run | yes (one memory call) | trace, lessons |

Evidence, strategy, validator and sheet are deterministic on purpose: facts and acceptance must not depend on a model. Hermes is used where language is produced (writer), where judgment is added (supervisor) and where it stores procedure (learning).

## Supervisor

A stateless Hermes call per gate; each call carries the run's earlier decisions, so it behaves as one session without relying on session resume. It is started with `roles/supervisor.md` and receives, at each gate, the compact `AgentReport`s so far, the budget left and the rules in force. It must answer with JSON only:

```json
{ "gate": "evidence|strategy|draft|final", "action": "proceed|retry|regenerate|stop",
  "reason": "...", "instructions": "text for the next attempt, optional", "concerns": ["..."] }
```

Gates:
1. **evidence**: enough verified, in-scope facts or notes? Is the mode right?
2. **strategy**: do persona, angle, hook and layout suit the facts and platform?
3. **draft** (after the validator): the text is read against the evidence. Is it specific, on topic, free of unsupported implications, and in the house voice?
4. **final**: after the learning agent, a last confirmation before the Sheet write.

Actions: `proceed` moves on; `retry` re-runs the same agent (writer or strategy) with the supervisor's `instructions`; `regenerate` discards the draft and strategy and starts the strategy and writer again with a new variant seed and the supervisor's `instructions`; `stop` ends the run as `needs_human`.

## Rules the supervisor cannot override (gates.ts)

- Zero verified facts and fewer than 3 usable notes: `stop`, whatever it says.
- The validator reports any hard-fail issue: `proceed` is rejected and treated as `retry` (within limits) or `stop`.
- The Sheet agent writes only when the validator passed, the supervisor said `proceed` at gates 3 and 4, and `--write-sheet` was given. It keeps every existing guard (row still holds the same report, status and URL empty, cell empty, read-back).
- The supervisor can only be stricter than the code, never more lenient.
- Invalid JSON, an unknown action, a Hermes error or timeout: the orchestrator treats the decision as `stop` (fail closed) and records why.

## Limits (budget.ts)

Defaults, all overridable by flags: `regenerate` 2 per row, writer `retry` 3 per attempt, Hermes calls per row 20 (writer, supervisor, learning together), per-call timeout 180 s (as `HermesProvider`), batch stops after 3 failed rows in a row. Hitting any limit ends the row as `needs_human` with the reason. Expect about 8 to 15 Hermes calls and several minutes per post; every call counts against the ChatGPT/Codex subscription.

## Ledger

`output/supervisor-hermes/runs/<runId>/events.jsonl`, one event per line: agent started/finished with its report, supervisor request/decision, retry/regenerate/stop, Sheet write. `hermes:status <runId>` prints the run as a timeline. `output/` is already git-ignored. Final result is also written to `output/supervisor-hermes/runs/<runId>/result.json` with the same fields as the existing `SocialJobResult` plus the decisions and the number of regenerations.

## CLI

```
npm run hermes:run -- --platform li|fb [--count N] [--keyword ...] [--row R] [--write-sheet] [--background]
npm run hermes:status -- <runId>
```

Same defaults as `hce:next`: row and keyword picked from the Sheet, local output unless `--write-sheet`, `--count` 1 to 25, `--count` not combined with `--row`.

## Errors

Every agent failure is a recorded event and a supervisor gate, not an exception that kills the batch: a failed row is marked, the batch continues until the failure limit. Evidence 404 or fetch failure stops that row (this also closes today's gap where a 404 report URL still led to a draft from an unrelated report: the evidence agent reports `reportPage: failed` and gate 1 plus the fixed rule below stop the row).

Fixed rule added in the evidence agent: if the report page itself failed to load, supplementary evidence is not used to write a post for that report. Only a loaded report page can anchor a draft.

## Testing

Unit tests with a fake Hermes and fake agents, no network and no real Sheet:
- gates: hard fail cannot be proceeded; zero facts always stops; supervisor cannot loosen anything.
- orchestrator: retry and regenerate respect their limits and carry the instructions forward; budget exhaustion ends as `needs_human`; failed rows do not stop the batch until the failure limit.
- supervisor: valid JSON accepted; invalid JSON, unknown action and Hermes errors fail closed.
- Sheet: no write without `--write-sheet`, none unless every condition above holds, existing row guards still apply.
- ledger: events are appended in order and `hermes:status` reads them back.
- agents: each contract validates its output; evidence agent refuses supplementary-only drafting when the report page failed.
Run `npm run typecheck` and the full suite; the 872 existing tests must still pass.

The first real Hermes run is a manual pilot with the user (local output only), as with the existing engine.

## Assumptions to confirm

1. `supervisor-hermes/` is the folder name (the user said "supervisor hermes"; a hyphen avoids a space in paths).
2. The supervisor judges the draft at gate 3 but code decides facts and validation.
3. Roughly 8 to 15 Hermes calls per post is acceptable.
4. Agents are modules driven by the orchestrator, with Hermes calls per gate and per writer attempt. They are not separate OS processes.
