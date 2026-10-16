# Validation and rewrite layer (Phase 3)

Everything here is free and offline: pure functions over text plus an injected
LLM provider and an injected claim checker.

```
generate -> deterministic fixers -> validateText -> pass | rewrite | needs_human
                                          ^                   |
                                          +-- LLM rewrite <---+  (bounded rounds, exact failures in every prompt)
```

Code map

| Path | Purpose |
|---|---|
| `src/validation/checks/hard-fail.ts` | Blocking checks (competitor, dashes, length, link, UTM, placeholder, title) |
| `src/validation/checks/model-artifacts.ts` | Refusal, degenerate output, reasoning leak, prompt echo, safety-classifier leak |
| `src/validation/checks/review.ts` | Non-blocking quality checks |
| `src/validation/checks/ai-tells.ts` | **Curation file**: AI-tell phrases, weak-evidence patterns, promo phrases |
| `src/validation/dedup.ts` | Exact and near-duplicate detection, `calibrateThreshold` |
| `src/validation/fixers.ts` | Deterministic, idempotent auto-fixes |
| `src/validation/validate-draft.ts` | `validateDraft`, `validateText`, `classifyOutcome`, `REMEDIATION` |
| `src/validation/vale.ts`, `scripts/gen-vale-styles.ts` | Vale style generation from the brand config |
| `src/rewrite/rewrite-prompt.ts`, `rewrite-loop.ts` | Rewrite prompt and the bounded loop |

## Public API

- `validateDraft({ draft, facts, recentTexts, claimChecker, dedupThresholds?, now? }, config) -> ValidationReport`
- `validateText({ draftId, platform, text, ... }, config)` (same, without a `Draft`; used by the rewrite loop)
- `classifyOutcome(report, { humanCodes? }) -> 'pass' | 'rewrite' | 'needs_human'`
- `applyFixers(text, { platform, config }) -> { text, applied[] }`
- `runRewriteLoop({ initial, provider, validate, facts, platform, config, maxRounds, budget?, shutdown?, logger?, sourceUrl? }) -> RewriteResult`
- `buildRewritePrompt({ text, issues, facts, platform, config, sourceUrl?, notes? })`

Brand presence requires a substantive body mention. A name appearing only in a hashtag, URL, or report-link label fails `MISSING_BRAND_MENTION`; Unicode bold is normalized before checking. Writers should attribute a supplied Ken Research finding early, while preserving official-source attribution. LI/FB closing-question quality is steered by concise varied prompts and supervisor review, not a subjective hard-fail score. Their single-question ending and approved format pool remain unchanged; X has no mandatory question.
- `checkDuplicates`, `normalizedHash`, `calibrateThreshold`

`passed` is true exactly when there is no `hard_fail` issue. Issue order is
deterministic: hard failures first (checks run in a fixed order), then review
issues; the duplicate check and the claim checker sit between the two groups
before sorting.

## Codes and who fixes them

`auto_fix` = a deterministic fixer repairs it before any LLM call.
`llm_rewrite` = needs the rewrite loop. `human` = a person should look; the
loop does not try to fix it (review-severity codes marked `human` are simply
reported, they never block).
This table is checked against `REMEDIATION` in `validate-draft.ts` by a test.

| Code | Remediation | Severity | Notes |
|---|---|---|---|
| `COMPETITOR_MENTION` | llm_rewrite | hard_fail | Prompt states the rule generically; never names firms |
| `BANNED_CHARACTER` | auto_fix | hard_fail | Em/en dash replaced by a hyphen (URLs untouched) |
| `BANNED_EMOJI` | auto_fix | hard_fail | Emoji and pictograph symbols are removed |
| `OVER_HARD_LIMIT` | llm_rewrite | hard_fail | X counts every URL as 23; FB/LI cap 2280 |
| `MISSING_SOURCE_LINK` | llm_rewrite | hard_fail | The prompt supplies the exact link |
| `MISSING_UTM` | auto_fix | hard_fail | Only when a Ken Research link exists |
| `DUPLICATE_UTM` | auto_fix | hard_fail | |
| `WRONG_UTM` | auto_fix | hard_fail | |
| `PLACEHOLDER` | llm_rewrite | hard_fail | |
| `MISSING_TITLE` | llm_rewrite | hard_fail | Blog: first line must be `# Title` or `Title: ...` |
| `REFUSAL` | llm_rewrite | hard_fail | |
| `DEGENERATE_OUTPUT` | llm_rewrite | hard_fail | |
| `REASONING_LEAK` | llm_rewrite | hard_fail | |
| `PROMPT_ECHO` | llm_rewrite | hard_fail | |
| `SAFETY_CLASSIFIER_LEAK` | llm_rewrite | hard_fail | |
| `EXACT_DUPLICATE` | llm_rewrite | hard_fail | Uncalibrated threshold |
| `STALE_YEAR` | llm_rewrite | hard_fail | A year before 2024 appears in the text (`utils/years.ts` MIN_DATA_YEAR); URLs are ignored |
| `UNSUPPORTED_YEAR` | llm_rewrite | hard_fail | A year no supplied fact or source note carries; a fact without a period gives no year (skipped when no facts are supplied) |
| `DUPLICATE_POINT` | llm_rewrite | hard_fail | Two list points share most of their key words (`content-sanity.ts`) |
| `LIST_COUNT_MISMATCH` | llm_rewrite | hard_fail | "Three things..." above a list of four (the line before the first list item names a count that differs from the list) |
| `SOURCE_NOT_NAMED` | llm_rewrite | hard_fail | A figure from a government page appears in a sentence that does not name that body (it must never read as Ken Research's number) |
| `SOURCE_SCOPE_MISSING` | llm_rewrite | hard_fail | A figure from ANOTHER Ken Research report appears without its scope (geography or the report's market) |
| `MISATTRIBUTED_NOTE` | llm_rewrite | hard_fail | A sentence restating neutral background from a non-Ken, non-government source carries a Ken Research attribution |
| `REPEATED_PHRASE` | llm_rewrite | hard_fail | The same 4-word lead-in appears in 3 or more paragraphs |
| `NO_VERIFIED_FIGURE` | llm_rewrite | hard_fail | Facts were supplied but the post states no figure |
| `UNSUPPORTED_NARRATIVE_CLAIM` | llm_rewrite | hard_fail | Causes/drivers, policy terms, supply-demand statements or comparisons the facts do not contain (lexical heuristic, `narrative-claims.ts`; skipped when no facts are supplied) |
| `UNSUPPORTED_MULTIPLIER_CLAIM` | llm_rewrite | hard_fail | "doubles", "triples"... when no fact states it |
| `UNSUPPORTED_ATTRIBUTION` | llm_rewrite | hard_fail | "Ken Research positions/recommends/believes..." when no fact or source note states that view |
| `MISSING_BRAND_MENTION` | llm_rewrite | hard_fail | "Ken Research" must be named in every post, on every platform |
| `BRAND_NOT_BOLD` | auto_fix | hard_fail | Facebook/LinkedIn: every mention must be bold. `ENSURE_BOLD` fixer wraps it |
| `FIGURE_NOT_BOLD` | auto_fix | hard_fail | Facebook/LinkedIn: every currency amount and percentage must be bold. `ENSURE_BOLD` fixer wraps it |
| `UNEXPECTED_BOLD` | llm_rewrite | review | Bold on anything that is neither the brand nor a figure |
| `MISSING_LIST_STRUCTURE` | llm_rewrite | hard_fail | Facebook/LinkedIn need 3 to 6 numbered (or bulleted) points |
| `LIST_TOO_LONG` | llm_rewrite | review | More than 7 points |
| `NO_ATTRIBUTION` | llm_rewrite | review | No finding is attributed to Ken Research by name |
| `FIGURE_PRECISION` | llm_rewrite | review | "7.20%" where the source says 7.2% |
| `UNGROUNDED_SENTENCE` | llm_rewrite | review | A sentence shares under 25% of its key words with the facts and source notes (heuristic). Review for one sentence, or when no source notes were supplied; hard_fail when notes exist and two or more are loose (or a third of a long body) |
| `LONG_SENTENCE` | llm_rewrite | review | A sentence over 40 words, or an average over 30 |
| `CHOPPY_SENTENCES` | llm_rewrite | review | Three or more sentences of 5 words or fewer in a row |
| `REPETITIVE_OPENERS` | llm_rewrite | review | Three or more points start with the same two words |
| `HOOK_NOT_QUESTION` | llm_rewrite | review | The first paragraph should be a question |
| `MISSING_CLOSING_QUESTION` | llm_rewrite | review | The line before the hashtags should be a question |
| `MISSING_BRAND_HASHTAG` | auto_fix | review | `ENSURE_BRAND_HASHTAG` prepends #KenResearch to the hashtag line |
| `BELOW_TARGET_BAND` | llm_rewrite | review | |
| `ABOVE_TARGET_BAND` | llm_rewrite | review | |
| `SUSPICIOUSLY_SHORT` | human | review | Replaces the legacy "length < 100 means refusal" rule |
| `HASHTAG_COUNT` | llm_rewrite | review | |
| `BANNED_PHRASE` | llm_rewrite | review | From `brandConfig.bannedPhrases` |
| `BANNED_PROMO_WORD` | llm_rewrite | review | From `brandConfig.bannedPromoWords` |
| `AI_TELL` | llm_rewrite | review | Seed list in `ai-tells.ts` |
| `REPETITIVE_PHRASING` | llm_rewrite | review | |
| `WEAK_EVIDENCE_WORDING` | llm_rewrite | review | |
| `GENERIC_PROMOTIONAL` | llm_rewrite | review | |
| `READABILITY` | llm_rewrite | review | Bands below |
| `LOW_SENTENCE_VARIANCE` | llm_rewrite | review | |
| `TONE` | llm_rewrite | review | Exclamations, emoji, we/our |
| `NEAR_DUPLICATE` | human | review | Uncalibrated threshold |

Claim-checker codes come from the evidence layer. Hard-fail codes not listed
above default to `llm_rewrite`. Codes that rewriting cannot fix (the facts
themselves are conflicting or missing) belong in `DEFAULT_HUMAN_CODES`
(`CONFLICTING_FACT` comes from the evidence claim checker and
`NO_VERIFIED_FACTS` from the pipeline; keep both names in sync with their
sources).

The loop only prompts for hard failures. Review issues are reported in the
final report but never trigger a rewrite on their own.

## Rewrite loop rules

- Every prompt lists the exact current hard failures, the allowed facts, the exact link, and the platform cap.
- A reply with `complete=false` or one that does not parse is a **failed attempt**, never content.
- A rewrite is **rejected** (not adopted) if it introduces a competitor mention, or introduces new hard failures without reducing the number of failing codes. The next prompt then carries those regressions.
- `BudgetExceededError` and `ShutdownError` end the loop immediately with `needs_human`.
- `maxRounds` is a hard bound; every round consumes one `Budget` unit if a budget is given.
- Known limit: the draft text being rewritten necessarily contains any competitor name it already had; only the instructions and issue details avoid naming one.

## Readability bands (heuristic, uncalibrated)

Evaluated only when the text has at least 40 words and 2 sentences.

- Flesch reading ease must be between 20 and 60. Below 20: dense academic prose. Above 60: chatty consumer copy.
- Average sentence length must be between 10 and 28 words.
- Sentence-length variation (stdev / mean) below 0.30 over 6+ sentences raises `LOW_SENTENCE_VARIANCE`.
- Syllable counting is a vowel-group heuristic for English; it is off by a few percent on unusual words and numbers.

## Heuristics, uncalibrated values, and known limits

Be skeptical of every number in this layer.

- Dedup thresholds (exact 0.98, near 0.70) are **uncalibrated defaults**. Use `calibrateThreshold` on labelled pairs from real drafts before relying on them.
- `MIN_SENSIBLE_CHARS`, the readability bands, the variance cut-off, the n-gram (4 words, 3 repeats) and opener (3 repeats) limits are first guesses.
- `AI_TELL`, `WEAK_EVIDENCE_WORDING` and `GENERIC_PROMOTIONAL` are short seed lists. They produce false positives (legitimate "seamless" or "studies show" with an unlinked source) and false negatives (any tell not listed). Review severity means they never block alone.
- Competitor detection is only as good as `competitors.config.ts`; obfuscated spellings are not caught.
- Refusal, reasoning-leak and prompt-echo detection are pattern based and English only. A refusal worded in an unlisted way, or a reasoning leak that does not open with a known phrase, is missed. A post that quotes such a phrase is a possible false positive.
- `TONE` ignores double-quoted speech but not single-quoted; `we`/`our` inside a genuine quotation without double quotes is flagged.
- Placeholder detection is regex based: `TODO`, `TBD`, `XXX` are matched in capitals only.
- The em/en dash fixer swaps to a hyphen without understanding grammar; the rewrite loop is the place for style repair.
- This layer cannot check facts. Numeric claims are the injected `ClaimChecker`'s job.

## False-positive and false-negative logging procedure

Goal: turn real misjudgements into regression fixtures and calibration data.

1. Whenever a person overrides the validator (approves a draft with a `hard_fail`, or rejects/edits a draft that passed), record a line in `logs/validation-feedback.jsonl` with: timestamp, draft id, platform, `configVersion`, the full `ValidationReport`, the draft text, the human verdict (`false_positive` | `false_negative`), the code(s) involved, and a one-line reason.
2. Weekly, review the file. For each entry:
   - **False positive** (validator blocked good text): add a `good/*.json` fixture with the text (synthetic if the original contains real data) and a `note`; then adjust the check until the fixture passes and every `bad` fixture still fails.
   - **False negative** (validator passed bad text): add a `bad/*.json` fixture with `expectedHardCodes` (or, for review-only misses, a unit test), then extend the check or the curation file.
3. Fixtures never contain real report data: use obviously fake markets such as "Examplestan Widget Market".
4. For dedup, add each judged pair to a labelled set (`{a, b, duplicate}`) and run `calibrateThreshold` before changing `UNCALIBRATED_*` constants. Record the chosen values, the date and the number of pairs here.
5. Record every change to `ai-tells.ts` or a threshold in the change log below.

### Change log

- 2026-10-13: initial seed lists and thresholds (all uncalibrated).

## Regression harness

`tests/fixtures/validation/bad/*.json` (known-bad, each with `expectedHardCodes`) and
`good/*.json` (known-good, must have no `hard_fail`) are run by
`tests/unit/validation-validate-draft.test.ts`. Fixture shape:
`{ platform, text, recentTexts?, expectedHardCodes?, note? }`.

## Vale and promptfoo

- `npx tsx scripts/gen-vale-styles.ts` regenerates `.vale.ini` and `styles/KenResearch/*.yml` from `brandConfig`. A test fails if the committed files drift from the generated ones. Vale itself is not installed; run `vale <file.md>` yourself if you install it.
- `promptfooconfig.yaml` is a skeleton for prompt regression. promptfoo is not a dependency, no provider is configured, and `tests/fixtures/validation/promptfoo/rewrite-prompt.txt` does not exist yet.
