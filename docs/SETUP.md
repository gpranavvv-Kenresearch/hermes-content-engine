# Complete setup and operating guide

This guide prepares the complete Hermes Content Engine on a Windows machine. It covers the evidence-backed social text engine, Supervisor Hermes, performance learning, single-image generation, six-slide carousel generation, and blog generation with images.

Runtime credentials, ChatGPT browser profiles, generated files, logs, and Sheet data are intentionally excluded from Git.

## 1. What this repository runs

| Component | Purpose | Default output |
|---|---|---|
| Social text engine | Evidence-backed Facebook and LinkedIn drafts | Local files; Sheet write is explicit |
| Supervisor Hermes | Agent-gated X, Facebook, LinkedIn and Tumblr generation | Local files; Sheet write is explicit |
| Overnight runner | Checkpointed multi-platform generation with recovery | Local files or Sheet, according to launch flags |
| Performance Engine | Collect metrics and update bounded future-post guidance | Local state; Sheet write is explicit |
| Single-image browser flow | Generate one ChatGPT infographic for a Social Media row | PNG plus immediate Sheet path write |
| Six-slide browser flow | Generate six prompts, six images and one PDF | PNG/PDF plus immediate `7Slide` write |
| Blog browser flow | Generate article, cover and two in-article images | Google Drive images plus immediate `New Logic` writes |

The three browser-generation commands are live workflows. They do not currently have a dry-run mode and write to the configured Sheet when generation succeeds.

## 2. Required software and accounts

Required:

- Windows 10 or 11.
- PowerShell 5.1 or PowerShell 7.
- Git for Windows.
- Node.js 22 or newer with npm. The required major version is also recorded in `.nvmrc`.
- Google Chrome.
- Hermes Agent CLI authenticated with the `openai-codex` provider.
- A ChatGPT account with image generation for the Playwright browser flows.
- A Google Cloud service account with Google Sheets access.
- A Google Drive OAuth desktop client and refresh token for blog-image uploads.

Optional:

- Ollama for explicitly selected local generation/review paths.
- Tavily for current external research.
- Social-platform analytics credentials when native performance fallback is enabled.

No Python runtime or `pip install` is required. `requirements.txt` is the environment checklist; `package.json` and `package-lock.json` are the authoritative Node dependency manifests.

## 3. Fresh installation

Open PowerShell:

```powershell
git clone https://github.com/gpranavvv-Kenresearch/hermes-content-engine.git
cd hermes-content-engine
node --version
npm --version
npm ci
Copy-Item .env.example .env
New-Item -ItemType Directory -Force .accounts | Out-Null
```

`node --version` must report version 22 or newer. Use `npm ci` on fresh clones so the committed lockfile is followed exactly.

If Playwright reports a missing browser executable later, install its managed Chromium build once:

```powershell
npx playwright install chromium
```

The imported ChatGPT flows normally use installed Chrome through persistent profiles.

## 4. Install and authenticate Hermes

Hermes supports native Windows installation. The current official CLI installation command is:

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

Open a new PowerShell window after installation, then verify it:

```powershell
Get-Command hermes
hermes --version
```

Configure the ChatGPT/Codex subscription provider:

```powershell
hermes model
```

Choose **ChatGPT or Codex Subscription**. A direct authentication command is also available:

```powershell
hermes auth add openai-codex --browser
hermes auth list openai-codex
hermes chat --oneshot -q "Say ready" --provider openai-codex
```

Trust the repository's project skill from the repository root:

```powershell
hermes skills trust
```

If `hermes` is outside `PATH`, set its absolute path as `HCE_HERMES_BIN` in `.env`. Hermes authentication is separate from the four Playwright ChatGPT sessions configured later.

Official references:

- [Hermes installation](https://hermes-agent.nousresearch.com/docs/getting-started/installation/)
- [Native Windows guide](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native)
- [Credential pools](https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-pools)

## 5. Google Cloud and credential files

### Google Sheets service account

Enable the Google Sheets API in the Google Cloud project and create a service-account JSON key. Put the private file here:

```text
.accounts/google-service-account.json
```

Share the target spreadsheet with the JSON file's `client_email` and grant Editor access when Sheet writing is required.

The same credential can instead be supplied as complete JSON through the process environment variable `GOOGLE_SERVICE_ACCOUNT_JSON`. Do not commit either form.

### Google Drive OAuth for blog images

The blog image pipeline uploads generated files to Drive and makes them publicly viewable. It expects:

```text
.accounts/google-drive-oauth-client.json
.accounts/google-drive-token.json
```

The OAuth client must be a desktop application credential. The token must contain a valid refresh token authorized for Drive. On the existing Ken Research machine, copy these two working files from the X Posting Agent's private `.accounts` directory.

### Reusing the existing X Posting Agent resources

From the Hermes repository root:

```powershell
$source = "C:\Users\Pranav Gupta\OneDrive - Ken Research Private Limited\Desktop\Read Me\reponse\x-posting-agent"
Copy-Item "$source\.accounts\google-service-account.json" ".accounts\google-service-account.json"
Copy-Item "$source\.accounts\google-drive-oauth-client.json" ".accounts\google-drive-oauth-client.json"
Copy-Item "$source\.accounts\google-drive-token.json" ".accounts\google-drive-token.json"
```

Only these three Google files are needed by the generation workflows. Platform posting-account JSON files are not required.

## 6. Configure `.env`

Keep `.env` private. A complete practical starting configuration is:

```dotenv
# Core Sheet and evidence engine
CE_ENV_FILE=
CE_GOOGLE_SA_FILE=.accounts/google-service-account.json
CE_SHEET_ID=your_google_spreadsheet_id
CE_SHEET_TAB=Social Media

# Hermes
HCE_HERMES_BIN=hermes
CE_REWRITE_MAX_ROUNDS=2
CE_DRY_RUN=true
CE_SHADOW_MODE=true
CE_PLATFORMS_ENABLED=

# Optional local/API provider chain
CE_OLLAMA_MODEL=
CE_TEXT_PROVIDERS=ollama,groq,openrouter,nvidia
TAVILY_API_KEY=

# Performance collection
PE_PUBLIC_BROWSER=1
PE_BROWSER_CHANNEL=chrome
PE_NATIVE_FALLBACK=0

# Imported single-image browser flow
SOCIAL_SHEET_ID=your_google_spreadsheet_id
GOOGLE_SERVICE_ACCOUNT_FILE=.accounts/google-service-account.json

# Optional overrides
CHROME_PATH=
AUTOMATION_DASHBOARD_URL=
AUTOMATION_DASHBOARD_TOKEN=
```

`CE_ENV_FILE` may point to another private dotenv file containing existing API keys. Values in the Hermes repository's `.env` take priority.

The imported six-slide and blog modules preserve the working Sheet configuration from X Posting Agent. Before using them against another spreadsheet, update their Sheet configuration deliberately and verify the required headers.

## 7. Required Sheet tabs and fields

### Social text and Supervisor Hermes

The `Social Media` tab needs the report URL/title fields and the platform-specific Post, Status and Post URL columns used by the existing engine. The guarded writers refuse populated or processed rows and read back each cell after writing.

### Single image

The imported single-image flow currently reads:

| Column | Value |
|---|---|
| A | Target/report URL |
| B | Title |
| E | Generated local image path |

For a pending row, A and B must be populated and E must be empty.

### Six-slide carousel

This flow finds columns by header name. The `Social Media` tab must contain:

- `targetUrl`
- `title`
- `7Slide`
- `LinkedIn Status`

A pending row needs target URL and title, with both `7Slide` and `LinkedIn Status` empty. The final PDF path is written to `7Slide` only after all six images exist and the PDF is built.

### Blog generation

The `New Logic` tab needs:

- `Target URL`
- `Blog Content`
- `Title`
- `Description`
- `Cover Image URL`
- `Image Data`
- `Image Data 2`
- `Image text`

The row is pending when `Target URL` is populated and `Blog Content` is empty or shorter than 50 characters. Missing optional output columns are logged and skipped, but `Target URL` and `Blog Content` are essential.

### Performance Engine

The `Algo Reports` tab stores performance summaries. Existing columns are preserved and the summary writer starts from column H.

## 8. Create the Playwright ChatGPT profiles

Run these commands one at a time from the repository root:

```powershell
npm run browser:login -- carousel-single
npm run browser:login -- storyline
npm run browser:login -- social-image
npm run browser:login -- account2
```

For each command:

1. Chrome opens with a dedicated persistent profile.
2. Complete the ChatGPT login in that window.
3. Confirm ChatGPT is usable.
4. Return to PowerShell and press Enter.

Profile responsibilities:

| Profile | Responsibility |
|---|---|
| `carousel-single` | Single infographic generation |
| `storyline` | Six prompt and six image carousel flow |
| `social-image` | Blog text generation |
| `account2` | Blog cover image generation |

The same ChatGPT account can be used in all four profiles. Separate accounts are preferable when blog text and cover-image generation run concurrently. Profiles and cookies are stored under `.sessions/` and are excluded from Git.

## 9. Readiness checks

These commands do not generate content or write to the Sheet:

```powershell
npm run requirements:check
npm run hce:doctor -- --check-sheet
npm run browser:doctor
npm run performance:doctor
npm run typecheck
npm run browser:typecheck
```

What they verify:

- `requirements:check`: Node, dependencies, `.env`, Sheet ID, service account, Hermes executable and Chrome.
- `hce:doctor -- --check-sheet`: engine configuration plus read-only Sheet/header access.
- `browser:doctor`: imported module files, three Google credential files and detected ChatGPT profile names.
- `performance:doctor`: performance-engine configuration and local state.
- Type checks: both the main engine and imported browser module compile.

`npm test` runs the full repository suite. It may take several minutes because some CLI tests spawn child Node processes.

## 10. Safe first tests

### Local-only social text draft

This does not write to Google Sheets:

```powershell
npm run hce:draft -- --url "https://www.kenresearch.com/<real-report>" --title "India Solar Power Market" --keyword "India solar power market" --platform both
```

Review results under `output/social-runs/` and detailed traces under `output/store/`.

### Local-only Supervisor Hermes test

```powershell
npm run hermes:run -- --platform li --count 1
```

Add `--write-sheet` only after the local result is accepted.

### Live single-image test

Prepare one Social Media row with A/B populated and E empty:

```powershell
npm run browser:single -- --row=5
```

This generates a PNG and writes its local path into column E.

### Live six-slide test

Prepare one row with the required headers and empty `7Slide`/`LinkedIn Status` cells:

```powershell
npm run browser:carousel -- --row=5
```

This creates six images, builds one PDF and writes the PDF path into `7Slide`.

### Live blog test

Keep only the intended test row pending in `New Logic`, then run:

```powershell
npm run browser:blog -- --limit=1 --with-image
```

The blog command selects the first pending row; it does not accept a row number. It writes the cover URL as soon as it is available, then writes and verifies the completed blog fields.

## 11. Normal operating commands

### Social text

```powershell
npm run hce:next -- --platform fb
npm run hce:next -- --platform li --brain ollama
npm run hce:history -- --platform fb

# Explicit guarded Sheet handoff
npm run hce:next -- --platform fb --row 123 --keyword "approved primary phrase" --write-sheet
```

### Browser generation

```powershell
npm run browser:single -- --count=5
npm run browser:carousel -- --count=5
npm run browser:blog -- --limit=1 --with-image
npm run browser:blog-loop -- --limit=1 --with-image --interval=1800
```

Blog options include `--blog-account=<name>`, `--image-account=<name>`, `--image-prompt=1|2`, `--prompt=v1|v2|master`, `--no-image`, and `--no-retry`.

### Supervisor and feedback

```powershell
# Default target: X 60 + Facebook 75 + LinkedIn 45 + Tumblr 60
npm run hermes:generate-all

# Refresh bounded guidance for all four platforms
npm run performance:auto-all

# Feedback first, then resume/start generation
npm run hermes:full-cycle
```

## 12. Overnight generation and monitoring

Read-only preflight:

```powershell
npm run hermes:overnight -- --check --write-sheet
```

Start a background Sheet-writing run:

```powershell
.\scripts\run-overnight.ps1 -WriteSheet -Background
```

Check or resume a batch:

```powershell
npm run hermes:overnight -- --status --resume BATCH_ID
.\scripts\run-overnight.ps1 -Resume BATCH_ID -Background
.\scripts\run-overnight.ps1 -Resume BATCH_ID -ExtendHours 18 -Background
```

Follow the background log:

```powershell
Get-Content ".\output\supervisor-hermes\overnight\BATCH_ID.stdout.log" -Wait -Tail 80
```

The computer must stay powered on and connected. The runner checkpoints progress, uses bounded cooldown/restart rules, and resumes unfinished work. Full recovery behavior is documented in `supervisor-hermes/OVERNIGHT.md`.

## 13. Scheduling

Register the complete feedback-plus-generation cycle using machine local time:

```powershell
npm run hermes:schedule-all -- -At "22:00"
```

The Windows account running the task must have access to the repository, `.env`, `.accounts`, Hermes authentication, browser profiles, and internet. Test a foreground or manual background run before scheduling.

## 14. Output and state locations

| Path | Contents |
|---|---|
| `output/social-runs/` | Reviewable social results |
| `output/store/` | Evidence, variants, repair traces and memory |
| `output/supervisor-hermes/runs/` | Agent reports, decisions and drafts |
| `output/supervisor-hermes/overnight/` | Batch checkpoints, heartbeat and logs |
| `output/performance-engine/` | Metrics, policies and active guidance |
| `browser-generation/single-image/images/` | Generated single-image PNGs |
| `browser-generation/six-slide/runs/` | Extracted six-slide prompts |
| `browser-generation/six-slide/images/` | Slide PNGs and final PDFs |
| `.sessions/` | Private ChatGPT browser profiles and rotation state |
| `.accounts/` | Private Google credential files |

## 15. Troubleshooting

| Symptom | Resolution |
|---|---|
| `hermes` is not recognized | Open a new PowerShell window; run `Get-Command hermes`; set `HCE_HERMES_BIN` when necessary. |
| Hermes says login expired | Run `hermes auth add openai-codex --browser`, then repeat the one-shot test. |
| `npm ci` fails on Node version | Install Node 22 or newer and open a new terminal. |
| Google returns 403 | Share the spreadsheet with the service-account `client_email` and confirm Editor permission. |
| Google credential file missing | Put it at `.accounts/google-service-account.json` or correct `CE_GOOGLE_SA_FILE`. |
| Drive upload fails | Verify both Drive OAuth files, Drive API access and the refresh token. |
| Browser login is requested again | Re-run `npm run browser:login -- <profile>` and finish login in the opened Chrome window. |
| Profile is locked | Close Chrome windows using that named profile, then retry. Do not run two workers on the same profile. |
| No single-image row is selected | Ensure A/B are populated and E is empty. |
| No carousel row is selected | Ensure `targetUrl`/`title` exist and `7Slide`/`LinkedIn Status` are empty. |
| No blog row is selected | Ensure `New Logic` has `Target URL` and fewer than 50 characters in `Blog Content`. |
| Image generation times out | Check ChatGPT plan/quota, login state and terminal log; then retry the same row. |
| Overnight heartbeat becomes stale | Check the saved status and stdout/stderr logs; resume the same batch instead of starting a duplicate writer. |
| PowerShell blocks scripts | Use the existing npm scripts or start with `powershell -ExecutionPolicy Bypass -File <script>`. |

## 16. Security and backup rules

Never commit or share:

- `.env`
- `.accounts/`
- `.sessions/`
- `output/`
- `performance-engine/config/accounts.json`
- generated local Sheet exports

Back up `.env`, `.accounts` and `.sessions` through the approved private company storage if the machine is replaced. A Git clone restores code only; it does not restore logins or credentials.

Before pushing code:

```powershell
npm run typecheck
npm run browser:typecheck
npm test
git diff --check
git status --short
```

## 17. Update an existing installation

```powershell
git status --short
git pull --ff-only
npm ci
npm run requirements:check
npm run hce:doctor -- --check-sheet
npm run browser:doctor
```

Do not delete `.env`, `.accounts`, `.sessions` or an unfinished batch checkpoint during an update.
