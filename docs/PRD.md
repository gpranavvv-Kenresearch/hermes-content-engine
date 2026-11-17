# Product Requirements Document: Hermes Content Engine

Version 1.0 | 16 November 2026 | Owner: Ken Research content automation

## 1. Purpose

Hermes Content Engine produces evidence-backed marketing content for Ken Research market reports, at volume and without a human writing each piece. For every report URL in the Google Sheet it can generate:

- X posts (plain text)
- Facebook and LinkedIn text posts
- Tumblr posts
- SEO blog articles with a cover image and two data images
- Single infographic images and six-slide carousel PDFs

The engine only generates and hands content over (local files or Sheet cells). Actual publishing stays with the existing posting agent.

## 2. Problem

Ken Research publishes hundreds of market reports. Promoting each one across several channels by hand is slow, inconsistent, and risky: figures get misquoted, brand rules get missed, and posts start to look identical. The engine must scale output to roughly 240 social posts per overnight run plus a steady blog stream, while keeping every figure traceable to a source.

## 3. Users

| User | Need |
|---|---|
| Content operator (primary) | Start a batch, check progress, resume after interruption, review output in the Sheet. |
| Ken Research editors | Approve formats and rules, give feedback on generated content. |
| Publisher (existing posting agent) | Read approved Post and blog cells from the Sheet. |

## 4. Goals and non-goals

### Goals

1. Every number in a post or blog is supported by evidence from the report page, government or regulatory sources.
2. Every piece follows the Ken Research brand and link rules without manual fixes.
3. Output is varied: structure, hook, tone and length do not repeat across items.
4. Runs are unattended, resumable, and never silently lower a quota.
5. The operator can tell at any time what is running and what failed, and why.

### Non-goals

- Publishing to social platforms or a CMS.
- Guaranteeing search ranking, AI citations or engagement. Content is optimised for them, not promised to achieve them.
- Estimating or inventing market statistics that the report does not publish.
- Using competitor research firms as a source of facts or links.

## 5. Scope by content type

### 5.1 X

- Plain text. No mandatory bold on brand or figures. Markdown and Unicode bold are stripped, never rejected.
- Must keep the Ken Research mention and stay within the total character limit.
- One concise B2B insight per post.

### 5.2 Facebook and LinkedIn text

- Default mode (from 13 Nov 2026) is the free-format prompt. The model chooses structure, hook, hashtags and closing question. The ten approved formats from 15 Oct 2026 remain available when `HCE_FREE_PROMPT=off`; they are frozen and any change needs sample review and explicit approval.
- LinkedIn and Facebook share one format pool.
- Code enforces only: character limit under 2,000, one neutral report link with the platform UTM (`facebook` / `linkedinpost`), bold Ken Research, bold statistics, no em dashes.
- The title passed to the prompt is the market name only (for example "India Solar Power Market").
- Ken Research must be attributed in the body, not only in a hashtag or link label. Closing questions invite a specific practical experience, obstacle or first check, and are varied.

### 5.3 Tumblr

Generated through the same supervised pipeline as X, FB and LI, with its own platform limits.

### 5.4 Blog (free-v2, current default)

The model researches the report and decides audience, tone, structure and headings. Code enforces a short list of deterministic rules and does not send the article back for style fixes. The prompt is `browser-generation/prompts/blog-generation/free/blog-free-v2.txt`.

Output has four sections: Publishing Title, SEO Title, Meta Description and the FINAL ARTICLE in HTML.

Requirements added after editorial review of the Qatar remittance article:

| ID | Requirement |
|---|---|
| B1 | Publishing Title, H1 and Meta Description carry explicit market-research search terms (Market Size, Growth, Forecast; Share only when the report has share data). |
| B2 | Every major third-party or official figure names its original source, with year or period and a link where a verified official page exists. No vague "market assessment" attribution. Unsourced figures are omitted. |
| B3 | A dedicated segmentation H2 when the report page shows segmentation, using the report's own segment names. Skipped when the page has none. |
| B4 | An unlinked report-coverage pointer earlier in the article, and a specific final call to action naming segmentation, competition and market-entry analysis, only where the report confirms them. |
| B5 | A FAQ of 3 or 4 search-style questions with direct answers of 40 to 65 words and no links. |
| B6 | Length target 1,400 to 1,650 words, hard maximum 1,800. |

Non-negotiable across every blog format:

- Exactly one H1 containing bold **Ken Research** inside the sentence, never as a "| Ken Research" suffix.
- Ken Research homepage linked once, on the first brand mention in the opening paragraph.
- Primary Report URL appears once, only in the final call to action.
- Related Ken Research reports (verified) and 2 to 3 official government sources, at most one link per paragraph, no links in headings, no links in consecutive paragraphs.
- Every Ken Research mention bold; meaningful numbers bold.
- One Google Preferred Source call to action in a blockquote, placed mid or lower in the article, never first, last, in the FAQ, or beside the final call to action.
- No tables, no emojis, no em dashes, no Markdown inside the HTML.

Images:

- One header image replaces the `YOUR_HEADER_IMAGE_URL_HERE` placeholder before publishing. A blog that still contains the placeholder is a failed blog.
- Two locked body images, "Market at a Glance" snapshot and "Forecast Outlook & Market Landscape", both wide and horizontal, never dropping supplied data, placed from the first H2 downward. Layouts change only with explicit approval.

### 5.5 Images and carousels

- Single infographic image from a prompt template, saved locally, path written to the Sheet.
- Six-slide carousel: six prompts, six images, one PDF, path written to the `7Slide` column.

## 6. Functional requirements

| ID | Requirement |
|---|---|
| F1 | Read pending rows from the Google Sheet by header name. Reject processed or already-filled rows. |
| F2 | Fetch and validate evidence from the report page. Facts and figures come only from Ken Research and government or regulatory hosts. |
| F3 | Skip rows with no verified facts instead of producing filler. Stop after repeated consecutive failures. |
| F4 | Choose persona, angle, tone, opener, structure and length per item, preferring the least-used options (variation history). |
| F5 | Run a supervised loop (sheet, evidence, strategy, writer, validator, learning) with a Hermes supervisor deciding at four gates: proceed, retry, regenerate, stop. |
| F6 | Bounded rewrite loop with recorded failure codes. Reusable repair lessons are saved only after a later draft passes. |
| F7 | Write a Post cell only after approval, then read it back to confirm. Leave Status, Post URL and publisher columns untouched. |
| F8 | Overnight runner with default profile 60 X, 75 Facebook, 45 LinkedIn, 60 Tumblr (0 to 500 each). Counts mean approved posts, not attempts. |
| F9 | Checkpoints, heartbeat and logs so a run can be inspected and resumed; an expired window stops as incomplete and can be extended explicitly. |
| F10 | Feedback loop that analyses performance per platform and replaces, not appends, the active prompt guidance. A failed analysis keeps the previous valid guidance. |
| F11 | Blog supervisor runs rows from the `New Logic` tab with blog text and image generation in parallel on separate ChatGPT profiles, verifies the saved row by re-reading it, and retries failed verification. |
| F12 | Local output by default. Sheet writes are an explicit flag. |

## 7. Quality gates

- Source and claim checks: no invented statistics, shares, rankings or forecasts; the original currency, units, geography and period are preserved.
- Brand checks: bold Ken Research, bold figures where required, no em dashes.
- Link checks: counts, placement and URL format (single pair of straight double quotes, no stray UTM on the primary link).
- Platform checks: character limits and the required primary keyword.
- Duplicate check against earlier output for the same item.
- In free mode, the Hermes gates for strategy, draft and final are replaced by the code validator. Only the evidence gate still asks Hermes.
- The similarity threshold and local quality score are not calibrated and are editorial signals, not a quality guarantee.

## 8. Non-functional requirements

- **Resumability:** checkpoint state in `output/supervisor-hermes/overnight/<id>.json`, with a log and a heartbeat file.
- **Single writer:** one generation writer per Sheet at a time. Google Sheets provides no atomic row lock.
- **Secrets:** credentials and Sheet IDs are never committed or stored in checkpoints; `.env` holds paths only.
- **Environment:** a Windows machine that stays powered on and online, with a logged-in Hermes (ChatGPT or Codex subscription) and logged-in ChatGPT browser profiles for image work. Sleep, logout or loss of connectivity interrupts a run, which can then be resumed.
- **Cost and quota:** the default brain is Hermes. Ollama and API chains are opt-in because they consume quota.
- **Testability:** deterministic tests and typecheck must pass before release (`npm test`, typecheck per `docs/SETUP.md`).

## 9. Success metrics

| Metric | Target |
|---|---|
| Approved posts per overnight run against the requested profile | Reach quota or stop with a clear reason, never silently lower it. |
| Brand or link rule failures in delivered content | Zero. |
| Posts with an unsupported figure | Zero. |
| Blogs delivered with the placeholder or missing images | Zero. |
| Editorial feedback items repeated across runs | Declining; each feedback item becomes a prompt or code rule. |
| Operator time per batch | Start, check status, review; no per-post editing. |

## 10. Known limits and open questions

1. The existing publisher still has generation fallbacks. A ready-package contract is needed before this engine fully replaces it for production posting.
2. Hermes authentication and the account quota limit throughput. Whether 240 posts fit in one night depends on model latency and retries.
3. The Sheet adapter has no atomic row lock.
4. The header-image step has failed on at least one blog (placeholder left in the HTML). Needs a hard gate: block delivery when the placeholder remains.
5. Free-mode blog quality depends on the model following the prompt, since code enforces only a few rules. New editorial rules should be added to the prompt first and to code only when they must hold every time.
6. Decide whether the new blog requirements (B1 to B6) should also get light deterministic checks, for example FAQ heading present, no placeholder, word count under the maximum.
7. Format changes for Facebook and LinkedIn still need samples and explicit approval whenever the frozen formats are in use.

## 11. Reference documents

- `README.md`: commands and directory map.
- `docs/SETUP.md`: machine setup and testing.
- `supervisor-hermes/OVERNIGHT.md`: unattended generation and recovery.
- `browser-generation/README.md`: image, carousel and blog flows.
- `AGENTS.md`: approved formats and brand rules.
- `docs/architecture/`: platform plans and research notes.
