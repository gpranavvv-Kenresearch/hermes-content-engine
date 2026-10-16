# Performance Engine operations

Published URLs come from **Social Media**. Every user-facing output goes to the existing **Algo Reports** tab. Existing indexing reports and daily-count fields are preserved. The engine adds `PE ...` columns with numeric metrics, stable IDs and readable explanations. GPT/Hermes keeps writing social posts and rewrites.

## Start here

From the Hermes Content Engine project directory:

```powershell
npm run performance:doctor
npm run performance:discover -- --limit 25
npm run performance:run -- --limit 25 --write-sheet --sync-limit 100
npm run performance:status
```

`doctor` checks Sheet access and reports the public collector plus any optional native capability without printing credential values. `run` discovers a bounded number of new published posts, processes due observations, evaluates mature cohorts, loads research proposals, generates a report and optionally syncs records. Without `--write-sheet`, outputs stay local in a durable outbox. Exit code 2 means some records still await Sheet sync; rerun `performance:sync -- --write-sheet --sync-limit 100`.

## One-command test advisory loop

```powershell
$testState = "output/performance-engine/test-loop-$(Get-Date -Format yyyyMMdd-HHmmss)"
npm run performance:test-loop -- --platform linkedin --state-dir "$testState" --limit 100 --write-sheet --sync-limit 300
```

`test-loop` is an immediate, suggestions-only end-to-end test. It discovers published URLs from `Social Media`, visits every selected public post without waiting for day 7/day 14, stores visible metrics, derives comparable content-pattern findings, loads reviewed research, asks Hermes for evidence-linked SEO and B2B analysis, writes per-post reviews and proposed prompt modifications, generates the performance report and syncs everything to `Algo Reports`. It never edits a generation prompt, applies a policy, starts an experiment or publishes content. If Hermes or live research is unavailable, the run records that limitation and produces a deterministic advisory instead of losing the collected observations.

When `TAVILY_API_KEY` is configured, `test-loop` also attempts source-linked live research using the measured weak patterns. Without it, the loop uses reviewed curated sources. All external material is treated as untrusted data and remains a test hypothesis.

For a `test-loop`, the shared `Algo Reports` tab receives one readable platform summary row. Columns H:M are fixed as **Platform**, **Rows Read**, **Content Analysis**, **Reach / Likes / Comments**, **Prompt Change Suggestion**, and **Why Suggested**. X, Facebook, LinkedIn and Tumblr all use these same columns. Detailed posts, observations, findings, research and the complete Hermes advisory remain in the run's local state directory for audit and recovery; the summary never applies a prompt or policy change.

Use `performance:auto-loop` for the closed production-learning loop. It performs the same collection and Hermes analysis, then atomically **replaces** the active guidance for that platform under `output/performance-engine/active-guidance/`. It also keeps a versioned recovery copy. The next Supervisor Hermes generation automatically reads the active platform guidance in its fixed writing-techniques slot. A later learning run replaces the slot; rules are never appended indefinitely and the approved LinkedIn/Facebook format pool remains unchanged.

```powershell
npm run performance:auto-loop -- --platform linkedin --state-dir "output/performance-engine/auto-linkedin" --limit 100 --write-sheet --sync-limit 300
```

To activate the latest saved Hermes advisory without repeating collection or model analysis:

```powershell
npm run performance:guidance -- --platform linkedin --state-dir "output/performance-engine/<saved-run>"
```

The primary collector follows each validated public post URL and reads structured data and visible counters. X single posts first use the no-key FxTwitter route used by x-tweet-fetcher. LinkedIn, Facebook and Tumblr use direct page metadata/visible labels. Set `PE_PUBLIC_BROWSER=1` to retry pages with a fresh headless Playwright context when direct HTML contains no counters; it does not import cookies or a login session. A login wall or hidden metric is a coverage gap, not zero engagement.

## Public collection and optional native accounts

No account file is required for public URL tracking. Copy `config/accounts.example.json` to `config/accounts.json` only when you later want official first-party analytics as an optional fallback. Set `PE_NATIVE_FALLBACK=1` to enable that fallback. The local mapping contains environment-variable names, never key values. Supply credentials through the existing `.env` / `CE_ENV_FILE` mechanism or process environment.

- **X:** authorized X API bearer token and post-lookup access. Optional numeric author ID verifies ownership. Public metrics are distinct from unavailable private click data.
- **LinkedIn:** account-specific token and active API version. Member analytics needs `r_member_postAnalytics`; organizations need appropriate reporting access. Supply the exact share/ugcPost URN; activity URLs are not assumed to be share URNs.
- **Facebook:** Page token, numeric Page ID and supported Graph version. Basic reactions/comments/shares are collected when returned. Optional `facebookInsights` maps verified metric names to impressions/reach/views/clicks; live names/permissions must be checked. A `share/p/...` URL is an alias requiring `nativePostId` for API lookup.
- **Tumblr:** API key and blog name. Aggregate notes remain `notes`; missing impressions/like-share breakdowns remain unknown.

Public collection does not claim account ownership. Optional native ownership is explicit. Accounts without a token can use public collection or first-party analytics imports. Groq/OpenRouter/NVIDIA keys are not social analytics credentials.

## Track a link or due posts

```powershell
npm run performance:inspect -- --url "https://x.com/HANDLE/status/POST_ID"
npm run performance:track -- --limit 25 --write-sheet --sync-limit 100
npm run performance:track -- --late --limit 10
```

`inspect` is an account-free on-demand public lookup and is labeled `late/ad-hoc` when a publication time is available. Normal tracking uses actual publication time at day 7/day 14 with a configurable 24-hour grace. Missed windows remain missed; current counts never reconstruct an old checkpoint. `--late` explicitly collects current visible observations of older posts. Blocked/retry states have persisted cooldowns; `--force-retry` bypasses cooldown after the public page becomes available.

Identity survives moved Sheet rows. Invalid homepages/off-platform URLs appear in discovery reports. Exact published-text/report/platform matches attach supervisor strategy handoffs; unmatched legacy content remains unclassified.

## Enrich metadata

Create a JSON array and run `npm run performance:enrich -- --file PATH_TO_JSON`:

```json
[
  {
    "postUrl": "https://www.facebook.com/share/p/REPLACE/",
    "accountId": "ken-facebook",
    "nativePostId": "123456_789012",
    "publishedAt": "2026-10-16T06:00:00Z",
    "contentType": "text",
    "distribution": "organic",
    "strategy": { "layout": "insight-brief", "angle": "growth-drivers" }
  }
]
```

Placeholders must be replaced with actual verified values. `nativeUrn` supports LinkedIn, e.g. `urn:li:share:1234567890123456789`. Never infer an old strategy/date just to make a post eligible. Publication time with observations attached cannot be silently changed.

## Import first-party exports

```powershell
npm run performance:import -- --file "C:\path\normalized-analytics.csv"
npm run performance:learn
npm run performance:report -- --write-sheet --sync-limit 100
```

Import accepts a JSON array or normalized CSV with quoted commas/newlines. Required fields: `postUrl, accountId, publishedAt, observedAt, source, scope`.

Optional CSV numeric columns: `impressions, reach, views, likes, reactions, comments, shares, quotes, clicks, saves, notes`; blank means unknown. JSON puts these in `metrics`. Optional metadata: `contentType`, `distribution`, `nativeUrn`, `nativePostId`, and strategy IDs (`layout`, `angle`, `hook`, `opener`, `tone`, `topic`, `closing`; under `strategy` for JSON).

Timestamps require timezone. `source` identifies the original dated export. `scope` is `organic`, `all` or `unknown`; `distribution` is `organic`, `paid` or `unknown`. Import measurements actually available at `observedAt`. Day-20 cumulative counts are not day-14 counts. Identical imports are idempotent; different observed checkpoint values cannot overwrite history. Unknown content/distribution is reported but excluded from pattern decisions.

## Learning and policies

```powershell
npm run performance:learn
npm run performance:policy -- --platform linkedin --account ACCOUNT_ID --write-sheet
npm run performance:rollback -- --version POLICY_VERSION --write-sheet
```

Initial thresholds: 10 pattern posts, 30 comparable baseline posts and at least 100 impressions per eligible post. These are operational starting points, not statistical proof. Cohorts match account/platform, age, source, metric signature, content type and distribution. Reactions are not added to their constituent likes; notes/video views are not impressions.

States: watch, reduce, paused and retest. Advancing needs weekly reviews and additional observations actually collected after the prior review, including fresh pattern evidence. Bootstrap uncertainty must support weakness. Retain historical posts; one weak post never bans a market.

Policy application is separate from analysis. Only qualified reductions/pauses can be applied. Set explicit generator account context with `PE_ACCOUNT_LINKEDIN`, `PE_ACCOUNT_FACEBOOK`, `PE_ACCOUNT_X` or `PE_ACCOUNT_TUMBLR`. Missing/malformed/expired/account-mismatched policies fall back to the approved sampler. Policies expire and support rollback. LI/FB keep the same approved ten-format definitions.

## Research and replacement experiments

```powershell
npm run performance:research -- --write-sheet
npm run performance:research -- --query "B2B LinkedIn industry insights practical discussion questions" --platform linkedin
npm run performance:experiment -- --id EXPERIMENT_ID --action start --platform linkedin --account ACCOUNT_ID --write-sheet
npm run performance:experiment -- --id EXPERIMENT_ID --action pause --platform linkedin --account ACCOUNT_ID --write-sheet
```

Default research loads reviewed GitHub sources. `--query` uses Tavily plus GPT/Hermes for source-linked hypotheses. `research --file FILE` loads reviewed Source records. No external repo is executed or leaders' posts copied. Analytics-reference repos do not become content experiments.

Starting a test requires an existing-format content source and exact account/platform scope. Deterministic allocation is at most 20%, one active test per account/platform, with a 42-day expiry. Only selected generator items receive one concise evidence-safe technique. `--action complete` ends a test; it does not prove or promote the idea. Reports show attributed posts and mature measurable observations. New structures require samples and explicit approval under root `AGENTS.md`.

## Reports, recovery and optional model review

```powershell
npm run performance:report -- --write-sheet
npm run performance:report -- --explain hermes
npm run performance:report -- --explain ollama
```

Code calculates numeric findings. Optional GPT/Hermes/Ollama adds clearly labeled advisory notes only. Ollama does not write posts or apply policies. The report works without LLM access. Full readable findings and numeric fields go into `Algo Reports`; local Markdown/JSON is an extra copy.

Local state is `output/performance-engine/state` (override with `PE_STATE_DIR`/`--state-dir`). A single local writer lock, atomic files, persistent cooldowns and durable outbox support restart. Sync reconstructs records from stored observations after an interrupted enqueue. Stable IDs/sparse writes/readback preserve legacy fields and prevent routine duplicates. Sheet requests are paced; uncertain append is reconciled instead of blindly retried.

No social post, login, strategy change, experiment or scheduled task is silently activated. Invoke the CLI daily through your chosen scheduler once accounts are ready; setup has not registered a schedule. Run `npm run typecheck` and `npm test -- --maxWorkers=4`. Offline platform contract tests do not establish real account permission.
