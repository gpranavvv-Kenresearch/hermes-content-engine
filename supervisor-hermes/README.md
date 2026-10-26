# Supervisor Hermes

For unattended multi-platform targets, checkpoint/resume, quota cooldowns and crash recovery, see [OVERNIGHT.md](OVERNIGHT.md). The default overnight profile is X 60, FB 75, LI 45 and Tumblr 60; it starts only when its command is run.

Agent-wise version of the Ken Research X/Tumblr/Facebook/LinkedIn text pipeline. Six agents each do one job and report back; a Hermes supervisor reads every report at four gates and decides whether the run goes on, retries, regenerates or stops. The existing commands (`hce:*`, `legacy:*`) still work. Shared draft and rewrite prompts preserve the house format across both pipelines.

Design: `docs/superpowers/specs/2026-10-14-supervisor-hermes-design.md`. Plan: `docs/superpowers/plans/2026-10-14-supervisor-hermes.md`.

## Run it

```powershell
# 3 posts from the next 3 Sheet rows, local output only (nothing is written to the Sheet)
npm run hermes:run -- --platform li --count 3

# same, and fill the "LinkedIn Post" cell of each approved row
npm run hermes:run -- --platform li --count 3 --write-sheet

# X uses the same four gates and writes only each approved row's "X Post" cell
npm run hermes:run -- --platform x --count 10 --write-sheet

# read back what happened in one run
npm run hermes:status -- <runId>
```

Options: `--platform x|fb|li|tumblr` (`twitter` also means `x`), `--count 1-25`, `--keyword "..."` (otherwise `seoKeywords`, then the cleaned title), `--row N` (one fixed row, not with `--count`), `--write-sheet`, `--background` (also allow number-free background pages), `--retry-skipped` (try again rows an earlier run found to have no usable evidence; they are otherwise skipped, as in `hce:next`), `--max-regenerations` (2), `--max-retries` (3), `--max-calls` (20 Hermes calls per row).

Requires Hermes installed and logged in (`hermes chat --oneshot -q "Say ready" --provider openai-codex`) and the same `.env` as the main engine. Each post takes several Hermes calls (roughly 8 to 15) and several minutes, and counts against your ChatGPT/Codex limits.

## How a row runs

```
sheet agent (pick row, keyword)
 -> evidence agent        -> GATE 1 evidence
 -> strategy agent        -> GATE 2 strategy
 -> writer + validator    -> GATE 3 draft   (proceed | retry writer | regenerate | stop)
 -> learning agent        -> GATE 4 final
 -> sheet agent writes the Post cell (only with --write-sheet)
```

| Agent | File | Uses Hermes? |
|---|---|---|
| sheet | `src/agents/sheet.ts` | no |
| evidence | `src/agents/evidence.ts` | no |
| strategy | `src/agents/strategy.ts` | no |
| writer | `src/agents/writer.ts` | yes (draft and rewrites) |
| validator | `src/agents/validator.ts` | no (rewrites go through the writer's model) |
| learning | `src/agents/learning.ts` | one memory call after an approved repair |
| supervisor | `src/supervisor.ts` | yes, one call per gate |

Role texts are in `roles/`. `roles/supervisor.md` is what the supervisor is given.

## What the supervisor cannot override (`src/gates.ts`)

- The report page did not load, or there is no verified figure and fewer than 3 source notes: the row stops. No draft is written from a substitute report.
- The validator reports a hard fail: `proceed` becomes `retry` (or `stop` when retries are used up).
- The final gate accepts only `proceed` or `stop`.
- The Sheet is written only after all gates pass, only with `--write-sheet`, and with the existing guards (row still holds the same report, status and URL empty, Post cell empty, read-back).
- If Hermes fails, times out or answers with invalid JSON or the wrong gate, the row stops.

The supervisor can only be stricter than the code.

## Review contract and retries

The supervisor uses a fixed checklist: evidence support, hard validation, the selected house format, and concrete readability defects. It receives all allowed facts and source notes (including their IDs), plus the same layout and platform limits used by the writer. A supported qualitative claim does not require a separate numeric fact.

LinkedIn and Facebook share ten user-approved formats: **insight brief**, **short narrative**, **evidence to decision**, **country contrast**, **one-stat spotlight**, **baseline to forecast**, **two-lens comparison**, **source-quote analysis**, **evaluation checklist**, and **market watchlist**. All ten were approved on 15 October 2026. Further additions or structural changes require sample review and explicit user approval. Country contrast needs notes naming at least three countries; spotlight needs a verified fact; timeline needs comparable verified values with years, units, market and geography; quote analysis needs a primary-source note and validates the exact excerpt. Claims still require source support. Only the selected format enters the prompt. Narrative formats do not require a list.

Both platforms use a short lead (statement, statistic, source quote or one question hook), one central idea, distinct supporting insights, a neutral report link and **one discussion question after the link**. Repeated figures and country-dominance summaries should be merged. Every Ken Research mention is bold. The remaining text is plain by default, with at most one additional short figure emphasis. Deterministic fixers restore missing brand bold before validation; required brand spans never consume the optional figure allowance. The target is 1,000–1,700 characters, within the 2,280-character hard cap. Links and hashtag counts follow each platform's configuration.

Several figures in one sentence may share a geography stated once, while periods and differing country/regional/global scopes must remain clear. See `docs/architecture/linkedin-formats-2026-10-15.md` for the GitHub references and concise prompt contract.

X uses a separate concise contract: one standalone plain-text insight, the primary keyword naturally near the start, an attributed finding and one business implication when the evidence supports it. It keeps one report link, suggests 1-2 topical hashtags, targets at most 256 characters and enforces the existing 280-character cap with every URL counted as 23. It does not require a discussion question, bold text, a long-form layout or LI's useful-word minimum. The supervisor receives the X rules at every gate; the same source, year, keyword, claim and Sheet guards remain active. X techniques were adapted from [Corey Haines's social and copywriting guidance](https://github.com/coreyhaines31/marketingskills/tree/55ff469422c3592dac45bcad08dfb40221981c02/skills/social); see `docs/architecture/x-supervisor-2026-10-15.md`. Natural keywords help topical clarity; this change makes no ranking or reach guarantee.

The first draft review should list all blockers together. Retries edit the last validated draft and keep prior corrections, rather than starting a new post. The same corrections reach every validator rewrite and survive regeneration. New unsupported claims still block approval; subjective new style preferences should not create another retry. These editorial decisions are model instructions; hard validation and failure limits remain enforced by code.

## Limits

Regenerations 2 per row, writer retries 3 per attempt, Hermes calls 20 per row. A batch stops after 3 failed rows in a row (1 when `--count 1`). Hitting a limit ends the row as `needs_human`.

## Where things are saved

`output/supervisor-hermes/runs/<runId>/events.jsonl` (every agent report and decision) and `result.json`. Variant history, repair traces and lessons use the main engine's `output/store/`, so both pipelines learn from each other.

New runs also save `evidence.json` with the exact gathered facts and notes, and `drafts/NN.txt` with each draft's verdict beside it. Older runs may not have an evidence snapshot.

## Tests

`npx vitest run supervisor-hermes` (fake Hermes, fake Sheet, no network). Use a local pilot without `--write-sheet` to assess editorial behavior after prompt changes.
