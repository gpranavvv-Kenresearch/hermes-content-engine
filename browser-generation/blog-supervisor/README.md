# Hermes blog engine

The blog counterpart of `supervisor-hermes` (the social text engine). Same idea: ChatGPT writes, Hermes supervises, code measures. The guidelines are different: `roles/supervisor.md` is the blog supervisor's brief (V1.3 rules, link plan, SEO/AIO/GEO checks), not the social-post one.

## How a row runs

```
Sheet "New Logic" row (Target URL set, Blog Content empty)
 -> evidence (report page; redirects are followed and the final URL is used)  -> GATE 1 evidence
 -> pick the article architecture (only when --structure is not v1.3)         -> GATE 2 structure
 -> ChatGPT writes the article (cover image runs in a second window)
 -> code measures it exactly (measure.ts)                                     -> GATE 3 draft
      retry      = targeted fix sent in the SAME ChatGPT chat
      regenerate = fresh chat, with the corrections appended to the prompt
      stop       = row needs a human
 -> approved draft is saved to disk (a crash here never costs another 15 minutes)
 -> snapshot + landscape images, canonical <img> tags, preferred-source CTA
 -> code measures the assembled article                                       -> GATE 4 final (proceed or stop)
 -> write to the Sheet, read it back, verify
```

## What code decides and what Hermes decides

- Code measures: words, paragraphs, H1/H2 counts, question H2s, tables, em dashes, bold `Ken Research`, bold figures, link kinds and positions, SEO title and meta lengths, figures not found in the report evidence. It never judges style.
- Hermes judges those numbers against the rules in `roles/supervisor.md`, which are split into MUST rules (facts supported by the report page text or a government source, bold Ken Research and figures, the Ken + government link plan, integrity) and FLEXIBLE items that never cause a retry (H2 count, paragraphs per H2, paragraph length, bullets, blockquote, pattern layout, question-H2 count, word count within a wide band). Articles are allowed to differ in shape.
- Code only overrides Hermes for structural garbage (no H1, fewer than 3 H2s, under 700 or over 2,600 words, a table, unfilled `{{ }}`), an unloaded report page, and the final gate accepting only proceed or stop. See `src/gates.ts`.

## Limits per row

3 same-chat fix requests, 1 fresh restart, 1 structure change, 24 Hermes calls, 90 minutes. A stuck browser makes the engine restart itself (exit code 2); the wrapper starts it again.

## Failure handling

- Hermes unreachable: wait 5 minutes and retry the same row. Not counted against the row.
- ChatGPT limit, stall, dropped connection: retry in 20 minutes, up to 4 times in a row.
- Genuine failure (stopped by a gate, report unverifiable, Sheet write not verified): cool-down of 6, 12 then 24 hours, then the row is parked. `npm run blog:unpark` releases parked rows.
- State is in `output/blog-supervisor/` (`state.json`, `drafts/`, `runs/<runId>/events.jsonl`, `heartbeat.json`).

## Commands

```powershell
npm run blog:check
npm run blog:status
npm run blog:run -- --limit=1 --with-image                    # one row, live V1.3 prompt
npm run blog:run -- --limit=5 --with-image --structure=rotate # bulk, a different architecture per row
npm run blog:run -- --row=884 --with-image                    # one specific Sheet row
npm run hermes:blog-continuous-install                        # 24x7 scheduled task (logon, unlock, 5-minute watchdog)
npm run hermes:blog-continuous-status
```

`--structure` is `v1.3` (default, the live prompt), `rotate`, `random`, or an architecture id from `src/agents/blogStructures.ts`. The architectures are drafts awaiting approval; see `docs/architecture/blog-structures-draft-2026-10-23.md`.

## What this does not change

`01-master-v1.3-live.txt` is untouched. The older loop (`npm run browser:blog`, `browser:blog-loop`) still works as before and does not use the supervisor.
