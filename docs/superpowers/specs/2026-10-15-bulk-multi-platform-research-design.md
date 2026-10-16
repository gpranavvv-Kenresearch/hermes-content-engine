# Simple bulk text-post pipeline (research, write, validate, Sheet)

Date: 2026-10-15. Status: draft for review. Replaces the earlier 2026-10-15 draft of this spec (supervisor, verification agent and fixed-rubric review are removed).

## Purpose

Generate **235 text posts** in bulk: LinkedIn 45, Facebook 80, X 50, Tumblr 60. Keep the process short so one post takes a few minutes and the batch fits in 2 to 4 nights. The existing supervised command (`hermes:run`) stays as it is; this is a new command, `hermes:bulk`.

## The process

```
1. Research agent   report URL + title -> facts, SERP top-10 keywords, leader/similar posts
2. Writer           writes a strong text post from that research
3. Validator (code) checks the post; fixes small things itself
4. Sheet            all checks pass -> write the Post cell
```

No supervisor. No second agent. A post that cannot pass is skipped (`needs_human`) and the batch moves on.

### 1. Research agent (once per report, shared by all platforms)
- **Facts:** from the report URL (Ken Research page) and the report title. If the page has no figure from 2024 or later, government pages, then the wider internet via Tavily. A figure from outside Ken Research is written with its source named and never as Ken Research data. Competitors and market-research publishers are never a source. A report page that fails to load, or redirects to a different slug, stops the row.
- **Keywords:** SERP API (Zenserp, then Serpstack, then SerpAPI, rotating keys as in the existing posting agent) returns the top 10 results and related searches. The primary keyword is the Sheet `seoKeywords` if filled, otherwise the best SERP keyword, otherwise the title-inferred one.
- **References:** Tavily finds posts and articles by industry leaders on similar content. They are style and angle references only. No figure is ever taken from them and no leader or competitor is named.
- The result (a `ResearchPack`: facts with source URL and name, keywords, reference notes) is cached per report URL and reused for every platform and every later run.
- Fetching is code (Tavily and SERP clients). Hermes only reads the results and picks the keyword and the useful references. Hermes has no web tool.

#### Low API usage (fetch once, reuse everywhere)
- **Report page:** one plain HTTP fetch per report (no paid API). Every platform job for that report reuses the stored pack; a report is never researched twice.
- **Tavily:** facts fallback only when the report page has no figure from 2024 or later, and then one search for government/web figures at most; one search for leader references per report. Hard cap of **3 Tavily searches per report**, 5 results each. Results are cached on disk (per query) and a cached query is never sent again.
- **SERP:** **one call per report** (top 10 plus related searches), through the first provider that answers (Zenserp, then Serpstack, then SerpAPI only if the earlier ones fail or are out of credit). The keyword result is cached per primary phrase for 30 days, so similar reports reuse it.
- **Hermes:** one call to read the whole research input and produce the pack (facts, keyword, references). The writer is one call per post, plus one targeted edit at most. No other Hermes calls.
- **Budget per report:** 1 SERP call, at most 3 Tavily calls, 1 Hermes research call. **Budget per post:** 1 Hermes call, 2 at most. The runner prints the counts and stops the batch if a provider reports no credit left on any key.
- Key rotation is used only when a key is exhausted, never to spread load.

### 2. Writer (Hermes)
Writes the post for one platform from the research pack. Rules put in the prompt:
- **Facts only from the pack.** "Use only the figures and notes below. Do not add facts, numbers or claims from your own knowledge." The writer's own skill is the writing: a strong specific opening, concrete sentences, no filler, no generic closing lines; the references show the style that works.
- **Angles** are limited to those the report's notes actually support (a pricing angle only if the notes contain pricing).
- Per platform format and limits from the existing platform config; X is short and strict. The primary keyword appears naturally in the body.

### 3. Validator and fixer (code, with the writer for wording fixes)
These checks are **non-negotiable**: a post must satisfy all of them. Each failure has a fixed way of being fixed. A fix is never a regeneration, and never lowers the quality of the post.

| # | Check | Fixed by |
|---|---|---|
| 1 | "Ken Research" present, **at least 2 times on Facebook and LinkedIn** (at least 1 on X and Tumblr), and bold on bold platforms | Bold: code. Count too low: writer fix ("mention Ken Research at least twice, naturally") |
| 2 | The post contains figures, and every figure is bold (bold platforms) | Bold: code |
| 3 | Report link with the correct UTM for the platform, exactly once | **Code**: the URL is the one picked from the Sheet row (`targetUrl`); a function adds the platform's UTM (`utm_source` facebook / linkedin / x / tumblr, from the existing UTM config) and puts the link into the post. The writer never writes or sees the link. Placement: on its own line right after the closing line "review the full market breakdown here:" (Facebook, LinkedIn); on X and Tumblr, after the text and before the hashtags. Any link the writer produced anyway is removed first. |
| 4 | Primary keyword in the body (not only in hashtags or the URL) | Writer fix ("add the keyword naturally, change nothing else") |
| 5 | Platform limits: **X strictly** (counted as X counts: URL as 23, hashtags included, one over fails); Facebook, LinkedIn, Tumblr per `src/config/platform-limits.config.ts`; hashtag band | Writer fix ("shorten to fit, keep the keyword, link and hashtags, keep the quality") |
| 6 | No em/en dashes, no stray whitespace | Code |
| 6b | No placeholders or model leakage (`{{`, "as an AI", prompt echoes, any text that is not the post) | Writer fix ("remove the extra text, keep the post") |
| 7 | No competitor name | Writer fix ("remove it, keep the meaning and the quality; write Ken Research where it fits") |

Order: code fixes first (links, bold, dashes, whitespace), then the checks. Every remaining failure goes to the writer in **one fix call**: the previous post plus the exact failing checks (and the sentences involved), told to change only those parts and keep everything else, including the quality. The post is checked again. Up to **2 fix rounds**; a post that still fails ends as `needs_human` (see Sheet).

The wider checks of the existing validator (claims against facts, narrative, years, duplicates, list structure, minimum words, AI-tell phrases) are **not** run.

### 4. Sheet
With `--write-sheet`, write the one Post cell (`X Post`, `FB Post`, `LinkedIn Post`, `Tumblr Post`) through the existing guarded writer (same report still in the row, status and URL empty, Post cell empty, read-back). Without the flag the post is saved locally only.

- **All checks passed:** the post is written, cell colour unchanged.
- **Still failing after the 2 fix rounds (`needs_human`, expected to be rare because the non-negotiable checks are fixed by code or by the writer):** the **best draft is written to the Post cell anyway and the cell background is set to light green**, so the row stands out. The user chose this because there is no review process for these rows. The posting daemon reads the Post cell and may post the draft, including one that broke a check (wrong UTM, competitor name, over the X limit, missing bold). That risk is accepted by the user.
- **No draft exists** (the report page failed to load or redirected, no usable evidence, or the writer never produced text): nothing is written and the cell is not coloured.
- The colour is set with one Sheets `batchUpdate` (`repeatCell`, background light green) on the same cell, using the tab's `sheetId`; it needs the write scope the writer already uses. The write guards above still apply.

## Platforms
Add **X** and **Tumblr**. Limits, hashtag band and UTM entry come from the existing config; values marked "verify" there are confirmed with the user before the first X or Tumblr run. The one edit allowed under `src/`: add `tumblr` to `PLATFORM_COLUMNS` and `SheetPlatform` in `src/sheets/social-sheet.ts` (after checking the live header has the Tumblr Post column). Everything else lives in `supervisor-hermes/`.

## Variation
LinkedIn rotates `bullet-insights` and `numbered-points`; Facebook `numbered-points`; X and Tumblr get their own layouts. Tone, opener, angle, hook and persona rotate as today. Writing techniques from the GitHub libraries the user supplies go in through the existing `config/techniques/` mechanism (limit of 8 per prompt raised if needed).

## Bulk runner
`npm run hermes:bulk -- --plan <file> [--write-sheet] [--until HH:MM] [--max-posts N]`
- The plan file lists `{ platform, count }`. Default: LinkedIn 45, Facebook 80, X 50, Tumblr 60.
- Rows are picked with the existing rules. Research runs once per report and is reused.
- Progress is saved after every post to `output/supervisor-hermes/bulk/<plan>.json`; running the same command again resumes.
- Stops cleanly at `--until`, on a Hermes quota error, after 5 failed rows in a row, or when the plan is done. One writer process only (the Sheet write is not atomic and the ChatGPT quota is shared).
- Cron: Task Scheduler runs the same command (pattern of `scripts/register-schedule.ps1`).
- Live progress lines are printed per step, as in `hermes:run`.

## Errors and safety
A failure ends only that row, except quota exhaustion, which stops the batch. Every step is written to the ledger (`output/supervisor-hermes/runs/<runId>/`). Keys are read from the `.env` the project already links; none is stored or printed.

## Testing
Fake Hermes, Tavily, SERP and Sheet; no network. Cover: fact tier order and blocked sources; report page failure and redirect stop the row; keyword priority (Sheet, SERP, title); research cached across platforms; each of the 7 checks fails a post that breaks it and passes one that does not; X counting with the 23-character URL; targeted-edit retry sends the previous post and failing checks and only once; the Sheet is written only after all checks pass and only with `--write-sheet`; resume after a stop; stop at `--until` and on a quota error. The full suite stays green. The first real runs are a pilot with the user: one post per platform, local only.

## Assumptions to confirm
1. The writer's own knowledge is for writing quality only; facts come only from the research pack.
2. No supervisor, no verification step, no number-matching check. A wrong or invented number is not caught by anything. If the pilot shows this is a problem, the cheapest fix is a code check that every number in the post is in the pack.
3. Minimum words, list structure and the duplicate check are off.
4. Sheet `seoKeywords` beats the SERP keyword.
5. Target 235 posts over 2 to 4 nights, one writer process.
6. `needs_human` drafts (still failing after 2 fix rounds) are written to the Post cell and coloured light green; only those cells are coloured. The daemon can post them.
7. The link is always built and inserted by code with the platform's UTM; the writer never writes it.
8. "Ken Research" at least 2 times is required on Facebook and LinkedIn only; X and Tumblr need 1.
6. `needs_human` drafts are written to the Post cell and coloured light green (only those cells are coloured; passed posts are not). They can be posted by the daemon.
