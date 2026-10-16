# Verification — 16 October 2026

## Completed checks

- `npm run typecheck`: passed after the implementation and integration changes.
- `npm test -- --maxWorkers=4`: **1,131 tests passed across 86 files**, including the generator/supervisor regression suite, Performance Engine tests and all-platform automation checks.
- CLI end-to-end test passed (`performance-engine/tests/cli.test.ts`), exercising import -> learning -> reporting -> rejection of premature policy application. Synthetic data stayed in a temporary local directory; none was sent to the production Sheet.
- Public collector fixture tests cover the no-key FxTwitter contract, LinkedIn JSON-LD, Facebook visible counters, Tumblr notes, compact counts, optional fresh-browser fallback and account-free tracking. Missing values remain null.
- Native platform adapter contracts are tested with offline X, Facebook, LinkedIn member/organization and Tumblr responses. These tests verify parsing, missing-value handling and request shape, not real account authorization.
- Tested URL identity and invalid homepages, explicit owner mapping, UTC/7/14-day boundaries, missing versus zero, first-party CSV parsing, old-window exclusion, persistent cooldown, blocked-account isolation, restart/checkpoint idempotency, atomic files and writer locks.
- Tested sparse Sheet updates, preservation of legacy columns, occupied columns without headers, duplicate-ID rejection, uncertain append reconciliation, outbox replay, source-token redaction, mature-cohort eligibility, bootstrap checks, fresh evidence requirements, conflicting cohorts, approved-format preservation, bounded weights, account/expiry fallback and controlled experiment allocation.

## Live Sheet pilot

Source: the configured `Social Media` tab. Output: the configured `Algo Reports` tab. The private spreadsheet ID is supplied through `CE_SHEET_ID` and is not stored in Git.

- Recognized **265** published-URL records after supporting Facebook share aliases. **120** cells were excluded as invalid/off-platform URLs/homepages or duplicate published-post IDs; counts/reasons appear in the discovery report.
- Registered a bounded **12** real published posts, not the entire sheet.
- The earlier **4** attempted due observations were marked **blocked** by the previous native-only implementation. They remain historical records. The current public collector no longer blocks merely because an analytics account is unmapped.
- Existing first six headers remained intact. Added structured `PE ...` headers; total columns are **42**.
- Verified **28 engine records** at rows **63–90**, with **zero duplicate IDs**: 12 post registrations, 4 blocked observations, 2 reports, 1 learning-coverage record, 1 proposed experiment, 7 research references and 1 capability inventory.
- Readback exposed Google Sheets' formatted-number rounding. Fixed by reading unformatted values and verifying numeric precision. Retried the persisted outbox without duplicate append; all pending records reconciled.
- Latest research-metadata update: **7 verified**, **0 pending**, **0 errors**. Local status also confirms zero pending Sheet records.
- An additional implementation/test-summary record is written separately after this verification; it reports software checks rather than audience performance.

Evidence artifacts (ignored runtime output): `output/performance-engine/live-sheet-verification.json`, `state/last-discovery.json`, durable outbox and local report files.

## Remaining external acceptance work

- Correct Tumblr homepage cells to actual published post URLs and fix other invalid/homepage URLs. Public Facebook share aliases can now be followed without a native Graph ID.
- Supply exact publication times when a public page does not expose them, plus verified content/strategy metadata for legacy posts. New supervisor generations produce strategy handoffs.
- Run one public-URL pilot per platform and compare visible counts with the page. Optional official API/import pilots are still needed if private impressions, reach or owner analytics are required.
- Allow new posts to reach real 7/14-day windows before assessing performance. Existing cumulative counts cannot reconstruct missed snapshots.
- Query-driven Tavily/GPT ideation, optional model commentary and recurring scheduling have not been live-tested/activated in this setup. Curated research, deterministic reporting and offline experiment controls have been tested.

No experiment, live policy, social post or recurring task was activated. GPT/Hermes remains the writer; Ollama is an optional advisory reviewer only.
