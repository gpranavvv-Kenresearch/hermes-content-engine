# Hermes Content Engine

Standalone TypeScript workspace for Ken Research Facebook and LinkedIn text. It reuses the proven evidence extraction, claim checks, style rules, bounded rewrite loop and Google Sheet adapter from the existing posting project, then adds a Hermes writing route, primary-keyword and depth gates, cross-run repair traces, and reviewed writing methods. It does not contain social posting code.

For a fresh machine, begin with the [complete setup and operating guide](docs/SETUP.md). The root [requirements.txt](requirements.txt) is the concise environment and dependency checklist; this remains a TypeScript project installed with `npm ci`, not `pip`.

## Current state

The workspace and Node dependencies are prepared. `.env` contains **paths only** to the existing posting-agent `.env` and `.accounts/google-service-account.json`; those secrets were not copied. The new workflow defaults to local output. `next --write-sheet` is an explicit Sheet handoff and writes one Post cell only after validator approval, with exact read-back. The existing publisher may consume a populated Post cell, so use local drafting for the first pilot.

Install/sign in to Hermes with your ChatGPT/Codex account and set `HCE_HERMES_BIN` when its executable is not on `PATH`. The engine uses Hermes's documented `chat --oneshot --query-file - --format stream-json --provider openai-codex` interface. [Hermes CLI documentation](https://hermes-agent.nousresearch.com/docs/reference/cli-commands) and [credential documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-pools).

The full suite and TypeScript typecheck are run before release; use the commands in `docs/SETUP.md` to verify the current checkout. Runtime credentials, Sheet IDs, generated output and browser sessions are not stored in Git.

## What you need to set up

1. Install the [native Windows Hermes Agent](https://github.com/NousResearch/hermes-agent#windows-native-powershell) and open a new PowerShell window. Confirm `hermes --version` works.
2. Run `hermes model`, choose **ChatGPT or Codex Subscription**, and sign in to your GPT account. If browser login is required by your organization, Hermes documents `hermes auth add openai-codex --browser`. Select a model supported by your subscription, then verify a simple `hermes chat --oneshot -q "Say ready" --provider openai-codex` call. Run `hermes skills trust` in this Git repository to enable its `.hermes/skills/ken-social-text` procedure. Your account limits still apply.
3. In this folder run `npm run hce:doctor -- --check-sheet`. It checks the configured file paths and reads the Sheet header without changing the Sheet. If the original posting-agent folder moves, remove the private `.env` after reviewing it and run `./scripts/setup-local.ps1 -PostingAgentPath '<new absolute path>'`.
4. Inspect `config/brand.config.ts`, `config/platform-limits.config.ts`, `config/campaign.config.ts` and your approved post examples. Supply `--keyword` for each pilot item when the preferred phrase differs from title inference. The current Sheet reader also accepts a `seoKeywords`, `Primary Keyword`, `SEO Keyword`, `Keyword` or `Keywords` column if present.
5. Run two or three real report URLs through local drafting. Compare the FB/LI results and validation traces before enabling a Sheet write or schedule.

Ollama is available as `--brain ollama` for local inference. `--brain chain` explicitly uses the configured Ollama/API provider chain and may consume API quota. The default is `--brain hermes`. No token or service-account JSON is passed to Hermes by the engine; it receives the evidence-backed writing prompt and relevant procedural lessons.

## Commands

Run these in this folder. Quote a URL or title containing `&` or spaces in PowerShell.

```powershell
npm run hce:doctor -- --check-sheet
npm run hce:draft -- --url 'https://www.kenresearch.com/<real-report>' --title 'India Solar Power Market' --keyword 'India solar power market' --platform both
npm run hce:next -- --platform fb
npm run hce:next -- --platform li --brain ollama
npm run hce:history -- --platform fb
```

`draft` writes local results under `output/social-runs/` and the engine's detailed store under `output/store/`. With `--platform both`, the two versions reuse the first run's evidence pack and receive separate strategy/layout choices. `next` reads the next eligible row from the configured Social Media Sheet; it also writes locally by default. When a tested post is ready for the existing publisher, explicitly run:

```powershell
npm run hce:next -- --platform fb --row 123 --keyword 'approved primary phrase' --write-sheet
```

Add `--count N` (1 to 25) to `next` to make N approved posts from the next N eligible rows in one run, for example `npm run hce:next -- --platform fb --count 5` to compare variation locally, or add `--write-sheet` to fill N Post cells. Each row is used once per run. Rows with no verified facts are skipped (up to `--max-rows`, default 5), and the run stops after 3 failed rows in a row. A summary lists each approved row. `--count` cannot be combined with `--row`.

That command refuses a processed or already-filled row and reads the written cell back. `--background` enables the existing source policy's neutral, number-free background mode. By default, supplementary figures remain Ken Research/government only. `--retry-skipped` retries URLs previously blocked by missing evidence.

After choosing a time and confirming the computer will be running, `scripts/register-schedule.ps1 -At 'HH:mm' -Platform both` registers a Windows daily generation task using **machine local time**. Add `-WriteSheet` only when Sheet handoff is ready. `scripts/run-generation.ps1` is the direct batch entry point. Scheduled runs use the same Windows account as the task, which must have Hermes login and access to the credential paths. The exact schedule has not been chosen yet.
Each scheduled execution writes a local transcript under `output/schedule/` in addition to the structured run and repair records. Inspect Windows Task Scheduler history and these files to diagnose failures.

## Supervisor Hermes (agent-wise run)

The unattended runner supports X, FB, LI and Tumblr with saved progress and bounded recovery. Check it without generating or writing anything using `npm run hermes:overnight -- --check --write-sheet`. When ready, `.\scripts\run-overnight.ps1 -WriteSheet -Background` starts the requested 60/75/45/60 profile. See [overnight operation and recovery](supervisor-hermes/OVERNIGHT.md).

Three top-level commands cover the automated loop:

```powershell
# Generate/resume X 60 + Facebook 75 + LinkedIn 45 + Tumblr 60 and write approved posts to Sheet
npm run hermes:generate-all

# Analyse all four platforms, ask Hermes for evidence-linked corrections, and replace each active prompt-guidance slot
npm run performance:auto-all

# Run feedback first, then resume or start the complete generation batch
npm run hermes:full-cycle
```

The feedback command updates future posts. It replaces the bounded active guidance for each platform rather than appending text to the prompt; failed or evidence-insufficient platforms retain their previous valid guidance. To schedule the complete cycle with Windows Task Scheduler, run `npm run hermes:schedule-all -- -At "22:00"`. The machine must be powered on and connected. An unfinished checkpoint is resumed on the next invocation, so a 240-post target is not silently reduced when it exceeds one night.

`supervisor-hermes/` runs X, LinkedIn and Facebook jobs as separate agents (sheet, evidence, strategy, writer, validator, learning) with a Hermes supervisor that decides at four gates whether to proceed, retry, regenerate or stop. Try `npm run hermes:run -- --platform x --count 10` or `--platform li` / `fb` (local output only; add `--write-sheet` to fill the corresponding Post cells). X uses a concise plain-text B2B insight; LI/FB retain their ten approved formats. See [supervisor-hermes/README.md](supervisor-hermes/README.md). The commands above are unchanged.

## Directory map

| Directory | Job |
|---|---|
| `src/social/` | New CLI, Hermes adapter, per-platform runner, repair lessons and traces |
| `src/evidence/` | Host policy, safe fetching, source validation, fact/qualitative note extraction |
| `src/pipeline/` | Evidence plan, supplementary research and draft generation |
| `src/strategy/` | Personas, angles, hooks, layouts, style examples, keyword brief and variation history |
| `src/validation/` | Source/claim/brand/layout checks plus required keyword and useful-word gates |
| `src/rewrite/` | Bounded local fixes and targeted model rewrites |
| `src/repos/`, `config/techniques/` | GitHub review/intake and the approved writing methods used in prompts |
| `src/sheets/` | Read pending Sheet rows and guarded single-cell Post write |
| `.hermes/skills/` | Project-specific procedure for interactive Hermes use |
| `browser-generation/` | Single image, six-slide PDF and blog-plus-images Playwright workflows |
| `scripts/` | Local resource linking and optional scheduled generation |
| `output/store/` | Local drafts, evidence plans, variants, repair lessons and attempt traces |
| `output/social-runs/` | Reviewable final result for each social job |
| `output/schedule/` | Timestamped execution logs for the optional daily task |
| `tests/` | Deterministic verification fixtures and unit/integration tests |

`output/`, `.env`, `.sessions/` and `node_modules/` are excluded from Git. The original posting-agent directory still owns actual social publishing; this workspace owns generation and the proposed Sheet handoff.

## How variation works

For every report/platform job the engine first selects a persona based on the available facts and campaign. The existing `VariationHistory` persists prior choices. Its sampler prefers less-used **tone, opener, structure, length class, CTA, angle and hook** combinations for the item. Facebook currently uses the approved numbered layout. LinkedIn rotates between numbered points and bullet insights, preferring the less-used layout. The inherited myth/reality template is excluded from new social jobs because its opening can invent a supposed public belief. FB and LI are generated as separate drafts with their own platform limits and hashtag bands. A duplicate check compares a new draft with prior output for the same item and may choose another variant within the model budget.

This is controlled variation in presentation. Facts, geography, periods, source attribution, brand rules and the required primary keyword remain fixed for the job. `hce:history` shows recent selections and learned repair procedures. The resulting JSON artifact records the exact variant for each post.

Every failed attempt records its check codes, action and outcome. On a later run, Hermes receives the recent outcome summaries as cautions and only receives a reusable repair procedure after a later draft passes validation; proven procedures are scoped to FB or LI. Market figures and draft text are kept out of Hermes's persistent procedural memory.

## GitHub methods

Two reviewed method packs are active: [Marketing Skills](https://github.com/coreyhaines31/marketingskills) for audience/platform writing and evidence-based editing, and [Anthropic's marketing skills](https://github.com/anthropics/knowledge-work-plugins/tree/main/marketing/skills) for brand terminology and claim review. The existing GEO method pack also remains available. See [repository research](docs/architecture/repository-research-2026-10-14.md) for licenses, inspected files and exact snapshots.

To consider another repository, run the existing `repo:intake` command with its GitHub URL, read its source files and license, then use `repo:adopt` for selected techniques. These commands produce candidates for `config/techniques/`; they do not execute third-party writing apps in this pipeline. The [architecture plan](docs/architecture/social-text-engine-plan-2026-10-14.md) describes the further commit-pinning and benchmark checks planned for larger-scale intake.

## Known limits

- Hermes authentication and an end-to-end Hermes draft await your account setup. `hce:doctor` checks installation and paths but cannot validate a future OAuth login by itself.
- Keyword presence and a minimum useful-word count are hard gates. The local score and review warnings remain editorial signals; calibrate them on your pilot before making a numeric quality threshold authoritative.
- The existing publisher still has generation fallbacks. The planned ready-package contract is needed before this workspace fully replaces that behavior for production FB/LI posting.
- The Sheet adapter checks the source row and confirms write-back, but Google Sheets does not give this workflow an atomic row lock. Use one generation writer until a stronger queue/commit contract is implemented.
- A PC that is asleep, logged out of the necessary account, or unable to reach Hermes/Google cannot complete a scheduled run. Review failed task history and `output/` traces.
