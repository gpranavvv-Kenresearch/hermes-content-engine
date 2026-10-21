# Browser Generation imported from X Posting Agent

This module contains the active generation logic copied from `x-posting-agent`. It is isolated from the Hermes social text engine so both systems can be changed independently.

For complete machine, credential, Sheet, login, testing and recovery instructions, use the repository's [`docs/SETUP.md`](../docs/SETUP.md).

## Included flows

### Single image

`single-image/scripts/run_single_image_test.js` reads a Social Media sheet row, selects one infographic prompt template, sends the completed prompt to ChatGPT through Playwright, downloads the generated PNG locally, and writes its local path into column E.

### Six-slide carousel

`six-slide/scripts/runRow.ts` reads a row by header name, asks ChatGPT to produce six image prompts, sends those prompts to ChatGPT one at a time, downloads all six images, combines exactly six slides into a PDF, and writes the local PDF path into the `7Slide` column. The retired seven-slide browser flow is not included.

### Blog plus images

`src/coordinator/blogGenLoop.ts` reads pending rows from the `New Logic` tab. It can run blog text and cover-image generation in parallel using separate ChatGPT profiles. It normalizes image tags, creates and uploads the two data-driven article images, inserts the preferred-source CTA, saves the blog fields to the sheet, re-reads the row, and retries failed verification.

## One-time setup

Run all commands from the Hermes Content Engine root.

1. Install dependencies with `npm install`.
2. Put the Google service-account file at `.accounts/google-service-account.json`, or set `GOOGLE_SERVICE_ACCOUNT_JSON` in `.env`.
3. For blog image uploads, put `.accounts/google-drive-oauth-client.json` and `.accounts/google-drive-token.json` in place.
4. Add `SOCIAL_SHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_FILE=.accounts/google-service-account.json` to the root `.env` for the single-image flow.
5. Log into each ChatGPT profile once:

```powershell
npm run browser:login -- carousel-single
npm run browser:login -- storyline
npm run browser:login -- social-image
npm run browser:login -- account2
```

Each command opens Chrome. Complete the login, return to the terminal, and press Enter. Sessions are stored under `.sessions/`, which Git ignores.

Check readiness without generating or writing anything:

```powershell
npm run browser:doctor
```

## Run commands

```powershell
# Single image for a specific sheet row
npm run browser:single -- --row=5

# Single images for the next five pending rows
npm run browser:single -- --count=5

# Six-slide PDF for a specific row
npm run browser:carousel -- --row=5

# Six-slide PDFs for the next five pending rows
npm run browser:carousel -- --count=5

# One blog with cover and in-article images
npm run browser:blog -- --limit=1 --with-image

# Continuous blog generation, checking every 30 minutes
npm run browser:blog-loop -- --limit=1 --with-image --interval=1800
```

Blog options include `--blog-account=<name>`, `--image-account=<name>`, `--image-prompt=1|2`, `--no-image`, and `--no-retry`.

## Runtime locations

- ChatGPT profiles and rotation state: `.sessions/`
- Google credentials: `.accounts/`
- Single-image PNG files: `browser-generation/single-image/images/`
- Carousel prompt runs: `browser-generation/six-slide/runs/`
- Carousel PNG/PDF files: `browser-generation/six-slide/images/`

The Sheet IDs and exact field mappings inside the imported source are preserved from the working X Posting Agent implementation.
