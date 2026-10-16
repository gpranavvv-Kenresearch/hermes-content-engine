# Setup and operating requirements

This repository contains the complete content generator, Supervisor Hermes, public performance tracker, learning/advisory loop, tests and Windows automation scripts. Runtime credentials and generated output are intentionally excluded from Git.

## Required software

- Windows 10/11 with PowerShell 5.1 or PowerShell 7 for background generation and Task Scheduler scripts.
- Node.js 22 or newer and npm. The lockfile is committed; install exactly with `npm ci`.
- Google Chrome for public-page metric fallback.
- Hermes Agent CLI, authenticated with the `openai-codex` provider. `hermes --version` must work, or `HCE_HERMES_BIN` must contain the executable's full path.
- A Google Cloud service account with access to the target spreadsheet.

Optional:

- `TAVILY_API_KEY` for current external SEO/B2B research. Without it, the learning loop uses the reviewed curated sources committed under `performance-engine/config/`.
- Ollama and `CE_OLLAMA_MODEL` for explicitly selected local review paths. Content generation and supervisor gates use Hermes.
- Official social-platform analytics credentials only when `PE_NATIVE_FALLBACK=1`. Public URL tracking needs no platform API key.

## Install from a fresh clone

```powershell
git clone https://github.com/gpranavvv-Kenresearch/hermes-content-engine.git
cd hermes-content-engine
npm ci
Copy-Item .env.example .env
```

Edit the private `.env` file. The minimum operational values are:

```dotenv
CE_GOOGLE_SA_FILE=C:/secure/google-service-account.json
CE_SHEET_ID=your_google_spreadsheet_id
CE_SHEET_TAB=Social Media
HCE_HERMES_BIN=hermes
PE_PUBLIC_BROWSER=1
PE_BROWSER_CHANNEL=chrome
PE_NATIVE_FALLBACK=0
```

Instead of `CE_GOOGLE_SA_FILE`, `GOOGLE_SERVICE_ACCOUNT_JSON` may contain the service-account JSON in the process environment. Do not commit either credential form. `CE_ENV_FILE` can point to another private dotenv file; local values win when both exist.

Share the spreadsheet with the service account's `client_email`. The spreadsheet must already contain:

- `Social Media` tab with report URL/title plus the platform Post, Status and Post URL columns used by the engine.
- `Algo Reports` tab for performance summaries. The engine preserves existing columns and writes its summary from column H onward.

Run the checks:

```powershell
npm run requirements:check
npm run hce:doctor -- --check-sheet
npm run performance:doctor
npm run typecheck
npm test -- --maxWorkers=4
```

`requirements:check` never prints credentials. `hce:doctor -- --check-sheet` performs a read-only Sheet request. `performance:doctor` writes locally unless `--write-sheet` is explicitly supplied.

## Hermes authentication

Use the Hermes CLI's model/authentication flow and select the `openai-codex` provider. Verify it before an unattended run:

```powershell
hermes --version
hermes chat --oneshot -q "Say ready" --provider openai-codex
hermes skills trust
```

If the binary is outside `PATH`, set its absolute location in `HCE_HERMES_BIN`. Account usage and rate limits still apply to generation and advisory calls.

## Operating commands

```powershell
# Generate or resume 60 X + 75 Facebook + 45 LinkedIn + 60 Tumblr approved posts
npm run hermes:generate-all

# Analyse every platform and replace active future-post guidance with the latest Hermes corrections
npm run performance:auto-all

# Run feedback first, then resume or start the complete generation batch
npm run hermes:full-cycle

# Register the full cycle daily at 22:00 local machine time
npm run hermes:schedule-all -- -At "22:00"
```

Generation runs in the background by default. Its batch checkpoint and logs are under `output/supervisor-hermes/overnight/`. If 240 approved posts exceed the execution window, the next invocation resumes the unfinished batch with its saved counts. Existing populated Post cells are not overwritten.

Performance state is under `output/performance-engine/`. A successful automatic advisory atomically replaces `active-guidance/<platform>.json`; version history is kept separately. Future Supervisor Hermes strategy/writer prompts read that slot automatically. Guidance is bounded and replaced rather than appended.

## Optional native analytics configuration

Public tracking can run without `performance-engine/config/accounts.json`. To enable official platform API fallback:

```powershell
Copy-Item performance-engine/config/accounts.example.json performance-engine/config/accounts.json
```

Replace the account mappings, set the named token environment variables privately, and set `PE_NATIVE_FALLBACK=1`. The real account file is ignored by Git. Missing public metrics remain unknown; they are never converted to zero.

## Files intentionally excluded from Git

- `.env` and all local environment variants
- `performance-engine/config/accounts.json`
- `output/`, logs and checkpoints
- browser profiles and sessions
- `node_modules/`
- local Sheet exports and credential files

After changing code, run `npm run typecheck` and `npm test -- --maxWorkers=4` before pushing.
