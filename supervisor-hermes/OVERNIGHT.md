# Unattended generation

The default profile requests **60 X + 75 Facebook + 45 LinkedIn + 60 Tumblr = 240 new approved posts**. Counts represent successful, verified outputs, not generation attempts. The four platforms share a round-robin worker, the existing four supervisor gates, evidence rules, bounded writer repairs, and repair traces. No quality gate is bypassed to fill a quota. Normal `hermes:run` still limits an individual interactive batch to 25; the overnight queue accepts 0–500 per platform.

## Check without starting

```powershell
npm run hermes:overnight -- --check --write-sheet
```

This reads Sheet headers and checks that enough pending rows exist, then checks the Hermes executable. It does not generate posts, create a batch checkpoint, or write Sheet cells. It cannot prove future model quota or Sheet edit permission; those errors are handled at run time.

## Start when ready

```powershell
# Recommended Windows launcher: background logs and a process-scoped idle-sleep hold
.\scripts\run-overnight.ps1 -WriteSheet -Background

# Same requested counts explicitly
.\scripts\run-overnight.ps1 -X 60 -Facebook 75 -LinkedIn 45 -Tumblr 60 -WriteSheet -Background

# Foreground runner; omitting --write-sheet keeps all output local
npm run hermes:overnight -- --x 60 --fb 75 --li 45 --tumblr 60 --write-sheet
```

Top-level shortcuts:

```powershell
# Generation only; resumes the newest unfinished Sheet-writing batch when one exists
npm run hermes:generate-all

# Performance analysis for all platforms followed by generation/resume
npm run hermes:full-cycle

# Register the full cycle daily at a local-machine time
npm run hermes:schedule-all -- -At "22:00"
```

`performance:auto-all` runs X, Facebook, LinkedIn and Tumblr sequentially. Each successful Hermes advisory atomically replaces that platform's active prompt guidance for future posts. A failed platform keeps its last valid guidance; prompt corrections are not appended indefinitely.

The launcher prints the batch ID and log path. `-Background` creates a hidden PowerShell host so closing the launching terminal does not end the worker. The host holds off automatic idle sleep while it runs, then restores its process setting. It does not change the Windows power plan. The PC must remain powered on with internet access. Power loss, a reboot or an explicitly forced sleep can interrupt it; checkpoints allow a later resume, but this feature does not install a Windows startup task.

`-WriteSheet` fills only the relevant Post cells, after approval and exact read-back. Existing Status, Post URL and other publisher columns are untouched. The existing publisher can consume these Post cells. Only one overnight worker can own the local writer lock; avoid running another generation writer against the same Sheet at the same time.

## Status and resume

```powershell
npm run hermes:overnight -- --status --resume BATCH_ID
.\scripts\run-overnight.ps1 -Resume BATCH_ID -Background

# Explicitly give an expired batch another 18-hour window
.\scripts\run-overnight.ps1 -Resume BATCH_ID -ExtendHours 18 -Background
```

Resume preserves saved targets and output mode. Do not supply new count flags on resume. A local-only batch cannot be switched to Sheet writes on resume. By default each new batch has an 18-hour execution window (`-Hours 1–72` / `--hours 1–72`). An expired window stops honestly as incomplete; extend it explicitly. Time estimates depend on model latency, retries and quota: 240 supervised posts may exceed one night, and completion is not guaranteed.

State is in `output/supervisor-hermes/overnight/<id>.json`, with a compact recovery log in `<id>.log`. Background console output uses `<id>.stdout.log` and `<id>.stderr.log`. Per-row drafts, evidence snapshots and supervisor decisions stay under `output/supervisor-hermes/runs/<runId>/`. The checkpoint includes completed counts, quarantined rows, failure reasons and any approved packages awaiting Sheet delivery. No credentials are stored in it.

## Recovery policy

| Failure | Automatic action |
|---|---|
| Unsupported claim, missing evidence or unfixable content | Retain the row and reason for review; pick another candidate without counting the failure toward the requested total. |
| Model/network timeout, 429 or quota exhaustion | Preserve the job and wait globally: 1, 2, 4, 8, 16, 32, then up to 60 minutes per cooldown. Heartbeats continue. Retry within the batch deadline; stop after 16 consecutive infrastructure failures. Never change provider, credentials or quality policy. |
| Sheet PUT succeeded but its response/read-back was lost | Keep the approved text ready. Re-read the same row and report URL. If its Post cell exactly equals the saved text, count it once without another write or model call. |
| Another text exists or the row moved/was processed | Do not overwrite. Quarantine the conflict and use another eligible row. |
| Wrong/missing login, denied permissions, missing columns or invalid approved checkpoint | Save the failure and stop blocked without an interactive prompt. These require an external fix. |
| Worker exits unexpectedly | Parent restarts from the checkpoint up to five times. An interrupted generation may be retried; after three interrupted attempts on a row it is quarantined. |
| Stuck worker | Row cancellation is requested after 25 minutes; a parent watchdog restarts a worker with a stale checkpoint heartbeat after 30 minutes. Sheet requests have 30-second timeouts. |
| Too many bad candidates | Cap candidates at five times the target plus ten for each platform. Continue other platforms; report the unfilled target honestly. |
| No rows left | Continue the other platforms and report incomplete counts rather than treating a smaller batch as complete. |

Every approved package is flushed to disk before a Sheet write. Atomic replacement keeps the previous checkpoint if a process dies during save. A process lock prevents two unattended workers on this checkout; this is not a distributed Google Sheets row lock.

X remains plain text with its 280-character hard cap including URL-adjusted length. LI/FB retain their ten frozen formats, bold brand mentions and one specific closing question. Tumblr uses a short plain-text B2B brief with a 600–1,000-character editorial target, a substantive brand attribution, one source link and topical hashtags; this is not asserted as a Tumblr platform hard cap.

Tests use fake models and Sheets to exercise interruption, cooldowns, replacement rows, uncertain Sheet commits, exact read-back, corrupted packages, round-robin fairness, deadlines and writer locking. Do not simulate a failure by publishing bad content to the live Sheet.
