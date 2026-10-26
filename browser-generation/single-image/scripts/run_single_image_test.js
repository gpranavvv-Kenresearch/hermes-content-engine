// run_single_image_test.js — single-image (not 7-slide carousel) live test.
//
// Given a sheet row number (or a count), for each row:
//   1. Reads that row's title + URL from the Social Media sheet
//   2. Fills a randomly picked images/briefs/template_infographic[_vN].txt with the title
//   3. Runs generate_image.js to produce ONE image via ChatGPT
//   4. Writes the resulting local image path back to the sheet (col E)
//
// Usage:
//   node scripts/run_single_image_test.js --row=N
//     → process exactly row N
//
//   node scripts/run_single_image_test.js --count=5
//     → auto-picks the next 5 rows where col A has a URL and col E is
//       still empty, processing them one at a time (each fully finishes —
//       image generated, downloaded, written to sheet — before the next
//       starts, since only one ChatGPT session/browser window runs at a time)
//
//   node scripts/run_single_image_test.js --row=10 --count=5
//     → process 5 consecutive rows starting at row 10 (10,11,12,13,14),
//       skipping any that already have col E filled or no title

import { config as loadEnv } from 'dotenv';
import { google } from 'googleapis';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadFileToGoogleDrive } from '../../src/utils/googleDriveUpload.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ROOT, '..', '..');
loadEnv({ path: path.join(REPO_ROOT, '.env'), quiet: true });

const SHEET_ID = process.env.SOCIAL_SHEET_ID || process.env.CE_SHEET_ID;
const SA_FILE  = path.resolve(REPO_ROOT, process.env.GOOGLE_SERVICE_ACCOUNT_FILE
  || process.env.CE_GOOGLE_SA_FILE
  || path.join('.accounts', 'google-service-account.json'));
const TAB      = 'Social Media';
const COL_A    = 0;  // targetUrl
const COL_B    = 1;  // title
const COL_E    = 4;  // local image/PDF path

function colLetter(idx) {
  let s = '', n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function getSheetsClient() {
  if (!SHEET_ID || !SA_FILE) {
    console.error('Missing SOCIAL_SHEET_ID/CE_SHEET_ID or Google service-account file configuration.');
    process.exit(1);
  }
  const SA = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON)
    : JSON.parse(fs.readFileSync(SA_FILE, 'utf8'));
  const auth = new google.auth.JWT({
    email: SA.client_email,
    key: SA.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// Finds up to `count` row numbers (>= startRow) that have a title/URL but
// an empty column E, by scanning the whole sheet once.
async function findPendingRows(sheets, startRow, count) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A:E`,
  });
  const rows = res.data.values ?? [];
  const picked = [];
  for (let i = Math.max(startRow - 1, 1); i < rows.length && picked.length < count; i++) {
    const r = rows[i];
    const url = (r[COL_A] ?? '').trim();
    const title = (r[COL_B] ?? '').trim();
    const existingE = (r[COL_E] ?? '').trim();
    if (url && title && !existingE) picked.push(i + 1); // 1-indexed sheet row
  }
  return picked;
}

// Picks one infographic prompt at random for each image. Candidates are the files in images/briefs/ named
// template_infographic.txt, template_infographic_v2.txt, template_infographic_v3.txt ... (reference copies such as
// *-ORIGINAL.txt or *.v1-backup.txt do not match and are never used). Every candidate must contain {{TITLE}}.
function pickTemplate() {
  const dir = path.join(ROOT, 'images', 'briefs');
  const files = fs.readdirSync(dir).filter(f => /^template_infographic(_v\d+)?\.txt$/.test(f));
  if (files.length === 0) throw new Error(`No template_infographic*.txt found in ${dir}`);
  const file = files[Math.floor(Math.random() * files.length)];
  return { file, text: fs.readFileSync(path.join(dir, file), 'utf8') };
}

async function processRow(sheets, rowNum) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`ROW ${rowNum}`);
  console.log('='.repeat(60));

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A${rowNum}:B${rowNum}`,
  });
  const row = res.data.values?.[0] ?? [];
  const targetUrl = (row[COL_A] ?? '').trim();
  const title = (row[COL_B] ?? '').trim();
  if (!title) {
    console.error(`Row ${rowNum} has no title in column B — skipping.`);
    return { row: rowNum, ok: false, reason: 'no title' };
  }
  console.log(`Title: "${title}"`);
  console.log(`URL:   ${targetUrl}`);

  const picked = pickTemplate();
  console.log(`Template: ${picked.file}`);
  const filled = picked.text.replaceAll('{{TITLE}}', title);

  const slug = slugify(title);
  const promptPath = path.join(ROOT, 'images', 'briefs', `prompt_${slug}.txt`);
  fs.writeFileSync(promptPath, filled, 'utf8');
  console.log(`Prompt written: ${promptPath}`);

  console.log('\nGenerating image via ChatGPT (this can take several minutes)...');
  try {
    execSync(
      `node scripts/generate_image.js --prompt-file="${promptPath}" --slug="${slug}"`,
      { cwd: ROOT, stdio: 'inherit' }
    );
  } catch (err) {
    console.error(`Row ${rowNum}: image generation failed — ${err.message}`);
    return { row: rowNum, ok: false, reason: 'generation failed' };
  }

  const today = new Date().toISOString().slice(0, 10);
  const imagePath = path.join(ROOT, 'images', `image_${today}_${slug}.png`);
  if (!fs.existsSync(imagePath)) {
    console.error(`Expected image not found at ${imagePath} — generation likely failed.`);
    return { row: rowNum, ok: false, reason: 'file missing' };
  }
  console.log(`Image saved: ${imagePath}`);

  // Generation above can take several minutes. Re-read this row's title
  // right before writing — if it no longer matches what we generated the
  // image for, something reassigned this row to a different report while
  // we were mid-generation, and writing now would silently pair this
  // market's image with a different market's row (confirmed live: e.g.
  // row 141 ended up with "argentina-agriculture-market.png" under a
  // "South Africa Professional Skincare Products Market" title). Skip the
  // write instead of corrupting the row.
  const recheck = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!B${rowNum}`,
  });
  const currentTitle = (recheck.data.values?.[0]?.[0] ?? '').trim();
  if (currentTitle !== title) {
    console.error(`Row ${rowNum}: title changed during generation (was "${title}", now "${currentTitle}") — skipping write to avoid a wrong image/title pairing.`);
    return { row: rowNum, ok: false, reason: 'title changed during generation' };
  }

  const { url: driveUrl } = await uploadFileToGoogleDrive(imagePath);
  console.log(`\nWriting image URL back to row ${rowNum}, column ${colLetter(COL_E)}...`);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!${colLetter(COL_E)}${rowNum}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[driveUrl]] },
  });

  return { row: rowNum, ok: true, title, imagePath, driveUrl };
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = a.match(/^--([^=]+)=(.*)$/);
      return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
    })
  );

  const explicitRow = args.row ? parseInt(args.row, 10) : null;
  const count = args.count ? parseInt(args.count, 10) : null;

  if (args.check) {
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${TAB}'!A1:E1` });
    console.log('Single-image configuration OK: credentials resolved from repository root; sheet read succeeded. No images generated or sheet cells changed.');
    return;
  }

  if (!explicitRow && !count) {
    console.error('Usage: node scripts/run_single_image_test.js --row=N | --count=N | --row=N --count=N');
    process.exit(1);
  }

  const sheets = await getSheetsClient();
  const results = [];

  if (explicitRow && !count) {
    results.push(await processRow(sheets, explicitRow));
  } else {
    const startRow = explicitRow ?? 2;
    const rowsToProcess = await findPendingRows(sheets, startRow, count);
    if (!rowsToProcess.length) {
      console.log('No pending rows found (need a title + URL in col A/B and empty col E).');
      return;
    }
    console.log(`Picked ${rowsToProcess.length} row(s): ${rowsToProcess.join(', ')}`);
    for (const rowNum of rowsToProcess) {
      results.push(await processRow(sheets, rowNum));
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log('='.repeat(60));
  for (const r of results) {
    console.log(r.ok ? `  Row ${r.row}: OK → ${r.driveUrl}` : `  Row ${r.row}: FAILED (${r.reason})`);
  }
}

main().catch(err => {
  console.error('Error:', err?.message ?? err);
  process.exit(1);
});
