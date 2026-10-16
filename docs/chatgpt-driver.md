# ChatGPT browser driver

`src/chatgpt/` implements `LlmProvider` (see `src/contracts.ts`) by driving a real, logged-in ChatGPT web session with plain Playwright. The rest of the engine only sees `LlmProvider.generate()`, so the driver can be replaced (API provider, another tool) without touching callers.

## Status: UNVERIFIED against the live UI

Everything here is unit-tested against **fake pages only**. No test launches a browser or touches the network. The selectors, timings and behaviours are ported from the legacy `x-posting-agent` driver (confirmed live there in Sept/Oct 2026), but **nothing in this module has been run against the real chatgpt.com**. Treat the first live runs as a smoke test, not production.

## Safety rules built in

- Plain Playwright, `chromium.launchPersistentContext` with `channel: 'chrome'`. No Stagehand.
- Never `page.fill()` (it is not even in the `PageLike` interface), never `networkidle`.
- Every selector is used only after `waitForSelector` resolved it (`waitForFirst` / `isPresent`).
- `humanDelay` between browser actions.
- The profile dir is refused if its resolved path (or real path) contains `x-posting-agent`.
- One profile, one process: an exclusive lock file (`.ce-profile.lock`, pid + token, stale-pid takeover) prevents a second open. `close()` releases it; `relaunch()` keeps it.
- Default profile: `<content-engine>/.sessions/chatgpt-engine`, override with `CE_CHATGPT_PROFILE_DIR`. It is a **dedicated** profile: log in once with the script below. It never shares cookies with the legacy repo.

## Public API (`src/chatgpt/index.ts`)

| Export | Purpose |
| --- | --- |
| `createBrowserSession({profileDir?, headless?, launch?})` | Guarded, locked persistent Chrome context. |
| `ChatGptProvider` | `LlmProvider` (`id = 'chatgpt-browser'`). Options: `session`, `budget`, `shutdown`, `recovery`, `diagnosticWriter`, `longPromptThreshold` (6000 chars), `pollMs`, `stablePolls`, `timeouts`, injectable `sleep` / `humanDelay` / `now`. |
| `checkHealth(page)` | `ready` / `login_required` / `challenge` / `rate_limited` / `unknown_ui` + evidence; writes screenshot + metadata through an injectable writer when not ready. |
| `waitForReply(page, opts)` | Stop button gone AND text length stable for K polls AND end marker present (when the prompt demanded the CE format). |
| `cleanReplyText`, `assessCompleteness`, `parseModelOutput` | Scrape cleaning and completeness checks. |
| `createRecoveryPolicy`, `classifyBrowserError` | cockatiel retry (bounded exponential backoff + jitter) around a shared circuit breaker. |
| `SELECTORS` | Ordered, named fallback selector lists. |

### `generate()` flow

shutdown check -> `budget.consume()` -> (serialised, one page) -> health check -> new chat (`/new`) -> deliver prompt -> submit -> wait for reply -> `LlmResult {text, complete, provider, elapsedMs}`, all under `withTimeout` (`chatGptShortReply` 3 min, or `chatGptLongReply` 18 min when `expectLong`).

- Prompts <= 6000 chars are inserted into the composer line by line (`keyboard.insertText`, `Shift+Enter` between lines).
- Longer prompts are written to a temp `.txt`, attached via the hidden file input, followed by a one-line "execute the attached instructions immediately" message (the legacy flow). The temp file is deleted afterwards.
- `complete` is false when the reply settled without `<<<CE_END>>>` (truncation). Callers must treat that as unusable.

### Error handling

| Situation | Category | Retried? |
| --- | --- | --- |
| Target/page/browser closed | `retryable` (+ session relaunch) | yes, bounded |
| Playwright `TimeoutError` | `retryable` | yes, bounded |
| All selector fallbacks exhausted / UI not recognised | `needs_human` | never |
| Login wall | `auth_required` | never |
| Captcha / challenge | `needs_human` | never |
| Rate-limit text | `rate_limited` (+ `retryAfterMs` if parseable) | waits (capped), at most one retry |
| N consecutive failures | breaker opens -> `ACCOUNT_PAUSED` (`needs_human`) | fails fast until half-open |

### Duplicate-generation guard

The moment before the send click the call is marked "submitted". After any later crash or timeout, a retry never retypes or resends the prompt. It relaunches if needed, reopens the recorded `/c/<id>` conversation, and:

- generation still running -> keeps waiting for it;
- already finished -> captures it;
- the page is directly observed on a new-chat URL with nothing happening -> the send never took effect, so it starts fresh;
- otherwise (e.g. browser relaunched before the conversation URL was captured, or a conversation with no reply) -> `DUPLICATE_RISK` (`needs_human`). It refuses to guess. Check ChatGPT history by hand.

## One-time login

```
npx tsx scripts/login-chatgpt.ts
```

Opens a headed Chrome on the dedicated profile. Log in by hand (the script never sees credentials), wait for the chat screen, press Enter. It reports whether the composer is visible and releases the lock on exit. Stop the engine first: a profile can only be open once.

## Manual smoke test the user must run

1. Run the login script above; confirm it prints `OK: session looks ready`.
2. Short prompt: from a scratch script, build `createBrowserSession()` + `new ChatGptProvider({session})`, call `generate({prompt: outputFormatInstruction() + '\nWrite one sentence about tea.', purpose: 'smoke'})`. Expect `complete: true`, `parseModelOutput(text).ok`, no "Copy"/"Share"/citation chips in the text, exactly one new chat in ChatGPT history.
3. Long prompt: same with a prompt > 6000 characters and `expectLong: true`. Expect a `.txt` chip to attach, the instruction line to send, and a complete reply.
4. Kill Chrome during a generation (task manager) and rerun the same call with a fresh provider: it will start a new prompt (state is per call). Within one call, a crash should relaunch and resume without a second history entry; check that too if you can reproduce it.
5. Log out in the profile and run again: expect `auth_required`, a diagnostic JSON/PNG in the diagnostics folder, and no prompt sent.

## Known fragility

- **UI selector drift.** ChatGPT changes its DOM often (the legacy code already survived one redesign on 2026-09-26). When `SELECTOR_NOT_FOUND` / `UI_UNKNOWN` appears, update `src/chatgpt/selectors.ts`. The error lists which names were tried.
- The assistant message is read with `.last()` of the matched selector. If a build renders one reply as several matching elements, the last fragment would be read. Unverified.
- Rate-limit detection is text-based (`Too many requests`, usage-limit wording, "try again in N minutes"), and after submit only inside `[role=dialog|alert]`. Wording changes would be missed.
- Long-reply behaviour (mid-stream "Continue generating" button, auto-switching to file attachments) is not handled beyond reporting `complete: false`.
- Challenge detection is heuristic (known iframe selectors and phrases such as "verify you are human").
- The lock removes stale locks by pid liveness only; a recycled pid could make a dead lock look live (the user can delete `.ce-profile.lock`).
- Cleaning rules are conservative: bare-domain lines and mid-text toolbar words are left alone, so an unusual chip may survive. Downstream validation should still check output.

## Terms-of-service risk

Automating the ChatGPT web UI is not an API use and may violate OpenAI's terms of use; accounts can be rate-limited, challenged or suspended. The user has accepted this risk. The driver sits behind `LlmProvider`, so swapping to a supported API provider needs no caller changes. Keep volumes low, keep human-like delays, and never run more than one process per profile.
