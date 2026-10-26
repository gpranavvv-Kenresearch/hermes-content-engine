// Standalone Social Media tab access for the storyline carousel. Header-name
// driven (never a hard-coded column letter): the "7Slide" column is found by
// its header text, so moving the column around in the sheet is safe.
import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';

const SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const TAB = 'Social Media';

const norm = (s: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function client() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    || fs.readFileSync(path.resolve('.accounts', 'google-service-account.json'), 'utf8');
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

function colLetter(idx: number): string {
  let s = '';
  let n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export interface SheetRowInfo {
  row: number;          // 1-based sheet row number
  targetUrl: string;
  title: string;
  sevenSlide: string;   // current value of the "7Slide" column
}

async function loadTab() {
  const sheets = client();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${TAB}'!A:AZ` });
  const rows = (res.data.values ?? []) as string[][];
  const header = rows[0] ?? [];
  const idx = (name: string) => header.findIndex(h => norm(h) === norm(name));
  const cols = { url: idx('targetUrl'), title: idx('title'), seven: idx('7Slide'), liStatus: idx('LinkedIn Status') };
  if (cols.url < 0 || cols.title < 0) throw new Error('"targetUrl"/"title" header not found in Social Media tab.');
  if (cols.seven < 0) throw new Error('"7Slide" header not found in Social Media tab — add a column with that exact header.');
  if (cols.liStatus < 0) throw new Error('"LinkedIn Status" header not found in Social Media tab.');
  return { sheets, rows, cols };
}

export async function getRow(rowNumber: number): Promise<SheetRowInfo> {
  const { rows, cols } = await loadTab();
  const r = rows[rowNumber - 1];
  if (!r) throw new Error(`Row ${rowNumber} does not exist.`);
  return {
    row: rowNumber,
    targetUrl: (r[cols.url] ?? '').trim(),
    title: (r[cols.title] ?? '').trim(),
    sevenSlide: (r[cols.seven] ?? '').trim(),
  };
}

/**
 * First data row with a targetUrl + title, an empty "7Slide" cell, AND an
 * empty "LinkedIn Status" cell. That last check matters: once LinkedIn
 * Status is filled, the LI batch has already posted that row (text-only or
 * with the "Images URL" fallback) and will never look at it again — so a
 * 7Slide PDF generated after that point would just sit there, never picked
 * up by anything.
 */
export async function getNextPendingRow(): Promise<SheetRowInfo | null> {
  const { rows, cols } = await loadTab();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const targetUrl = (r[cols.url] ?? '').trim();
    const title = (r[cols.title] ?? '').trim();
    const seven = (r[cols.seven] ?? '').trim();
    const liStatus = (r[cols.liStatus] ?? '').trim();
    if (targetUrl && title && !seven && !liStatus) return { row: i + 1, targetUrl, title, sevenSlide: seven };
  }
  return null;
}

/** Writes a single value into the "7Slide" column of the given row. */
export async function writeSevenSlide(rowNumber: number, value: string): Promise<string> {
  const { sheets, cols } = await loadTab();
  const cell = `${colLetter(cols.seven)}${rowNumber}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!${cell}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
  });
  return cell;
}
