import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JWT } from 'google-auth-library';
import { EngineError } from '../errors.js';

/**
 * Access to the "Social Media" tab. The row is picked exactly as the live daemon picks it (see
 * pickNextSequentialBlogRows in x-posting-agent/src/sheets/sheets.ts): a row counts as processed when its platform
 * Post URL cell is filled, or its Status cell says posted / failed / error; the next row is the first usable row AFTER
 * the last processed one.
 *
 * Writing: the engine only ever writes ONE cell, the generated text in "<Platform> Post" (X Post / FB Post /
 * LinkedIn Post). It never touches Status, Post URL, Error, the batch column or lastPosted, so the row is still
 * "unprocessed" for the daemon, which finds the text there and posts it (see masterCoordinator.ts: "Use sheet content
 * if available, otherwise generate"). See writeGeneratedPost for the guards.
 */

export type SheetPlatform = 'x' | 'facebook' | 'linkedin' | 'tumblr';

const DEFAULT_SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const DEFAULT_TAB = 'Social Media';
const LEGACY_CREDENTIALS = path.resolve('..', '.accounts', 'google-service-account.json');

const TITLE_COLUMNS = ['Blog Title', 'Title', 'Main Title'];
const URL_COLUMNS = ['targetUrl', 'Report URL', 'Download Report URL', 'Target URL', 'URL'];

const PLATFORM_COLUMNS: Record<SheetPlatform, { postUrl: string[]; status: string[]; post: string[]; label: string }> = {
  x: { postUrl: ['X Post URL'], status: ['X Status'], post: ['X Post'], label: 'X' },
  facebook: { postUrl: ['FB Post URL'], status: ['FB Status'], post: ['FB Post'], label: 'Facebook' },
  linkedin: { postUrl: ['LinkedIn Post URL'], status: ['LinkedIn Status'], post: ['LinkedIn Post'], label: 'LinkedIn' },
  tumblr: { postUrl: ['Tumblr Post URL'], status: ['Tumblr Status'], post: ['Tumblr Post'], label: 'Tumblr' },
};

const PROCESSED_STATUSES = new Set(['posted', 'failed', 'error']);

export interface SheetPick {
  /** 1-based row number in the sheet. */
  rowIndex: number;
  title: string;
  url: string;
}

const norm = (s: string): string => s.trim().toLowerCase();

function columnIndex(headers: readonly string[], names: readonly string[]): number {
  const lowered = headers.map(norm);
  for (const n of names) {
    const i = lowered.indexOf(norm(n));
    if (i >= 0) return i;
  }
  return -1;
}

/** 0-based column index to A1 letters (0 -> A, 25 -> Z, 26 -> AA). */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export function parseSheetPlatform(value: string): SheetPlatform {
  const v = value.trim().toLowerCase();
  if (v === 'x' || v === 'twitter') return 'x';
  if (v === 'fb' || v === 'facebook') return 'facebook';
  if (v === 'li' || v === 'linkedin') return 'linkedin';
  if (v === 'tumblr') return 'tumblr';
  throw new EngineError(`Unknown platform "${value}". Use li, fb, x or tumblr.`, 'fatal', 'BAD_PLATFORM');
}

export interface PickOptions {
  /** Also skip rows whose "<Platform> Post" cell already holds text (generated earlier), so each run moves to a new row. */
  skipGenerated?: boolean;
  /** 1-based row numbers to pass over (rows known to have no usable facts). */
  exclude?: ReadonlySet<number>;
}

/**
 * Pure picking logic (rows include the header row at index 0). Returns the next row for `platform`, or null
 * when every row after the last processed one is empty or processed. `from` forces a specific 1-based row.
 */
export function pickNextRow(rows: readonly (readonly string[])[], platform: SheetPlatform, from?: number, options: PickOptions = {}): SheetPick | null {
  const headers = rows[0] ?? [];
  const cols = PLATFORM_COLUMNS[platform];
  const postUrlIdx = columnIndex(headers, cols.postUrl);
  const statusIdx = columnIndex(headers, cols.status);
  const postIdx = columnIndex(headers, cols.post);
  const titleIdx = columnIndex(headers, TITLE_COLUMNS);
  const urlIdx = columnIndex(headers, URL_COLUMNS);
  if (urlIdx < 0) throw new EngineError(`No report URL column found (looked for ${URL_COLUMNS.join(', ')}).`, 'fatal', 'SHEET_COLUMNS');
  if (postUrlIdx < 0 && statusIdx < 0) {
    throw new EngineError(`No ${cols.label} status or post-URL column found (looked for ${[...cols.status, ...cols.postUrl].join(', ')}).`, 'fatal', 'SHEET_COLUMNS');
  }
  const cell = (row: readonly string[], i: number): string => (i >= 0 ? (row[i] ?? '').trim() : '');
  const processed = (row: readonly string[]): boolean =>
    cell(row, postUrlIdx) !== '' || PROCESSED_STATUSES.has(cell(row, statusIdx).toLowerCase());

  if (from !== undefined) {
    const row = rows[from - 1];
    if (!row || from < 2) return null;
    const url = cell(row, urlIdx);
    return url ? { rowIndex: from, title: cell(row, titleIdx), url } : null;
  }

  let last = 0;
  for (let i = 1; i < rows.length; i++) if (processed(rows[i]!)) last = i;
  for (let i = last + 1; i < rows.length; i++) {
    const row = rows[i]!;
    const url = cell(row, urlIdx);
    if (!url || processed(row)) continue;
    if (options.skipGenerated && cell(row, postIdx) !== '') continue;
    if (options.exclude?.has(i + 1)) continue;
    return { rowIndex: i + 1, title: cell(row, titleIdx), url };
  }
  return null;
}

// --- Google Sheets access ----------------------------------------------------------------------------------

interface Credentials {
  client_email: string;
  private_key: string;
}

function loadCredentials(env: Record<string, string | undefined>): Credentials {
  const inline = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const file = env.CE_GOOGLE_SA_FILE?.trim() || LEGACY_CREDENTIALS;
  let raw: string;
  try {
    raw = inline || readFileSync(file, 'utf8');
  } catch {
    throw new EngineError(
      `Google service-account credentials not found. Set GOOGLE_SERVICE_ACCOUNT_JSON or CE_GOOGLE_SA_FILE (tried ${file}).`,
      'fatal',
      'SHEET_CREDENTIALS',
    );
  }
  const parsed = JSON.parse(raw) as Partial<Credentials>;
  if (!parsed.client_email || !parsed.private_key) throw new EngineError('The service-account JSON has no client_email / private_key.', 'fatal', 'SHEET_CREDENTIALS');
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

/** The two calls the engine needs. A fake is used in tests. */
export interface SheetsApi {
  tab: string;
  /** Values of an A1 range inside the tab, e.g. "A:AZ", "1:1", "122:122". */
  read(range: string): Promise<string[][]>;
  /** Writes ONE cell (A1 like "M122") as plain text (RAW, nothing interpreted as a formula). */
  writeCell(a1: string, text: string): Promise<void>;
}

/** Real Google Sheets access. `write: false` asks for a read-only token, so reading can never change the sheet. */
export function createSheetsApi(env: Record<string, string | undefined> = process.env, options: { write?: boolean } = {}): SheetsApi {
  const creds = loadCredentials(env);
  const scope = options.write ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const auth = new JWT({ email: creds.client_email, key: creds.private_key, scopes: [scope] });
  const id = env.CE_SHEET_ID?.trim() || DEFAULT_SHEET_ID;
  const tab = env.CE_SHEET_TAB?.trim() || DEFAULT_TAB;
  const rangeUrl = (range: string): string => `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(`${tab}!${range}`)}`;
  return {
    tab,
    async read(range) {
      const res = await auth.request<{ values?: string[][] }>({ url: rangeUrl(range), timeout: 30_000 });
      return res.data.values ?? [];
    },
    async writeCell(a1, text) {
      if (!options.write) throw new EngineError('This sheet connection is read-only.', 'fatal', 'SHEET_READ_ONLY');
      await auth.request({ url: `${rangeUrl(a1)}?valueInputOption=RAW`, method: 'PUT', data: { values: [[text]] }, timeout: 30_000 });
    },
  };
}

export async function readSocialSheet(env: Record<string, string | undefined> = process.env): Promise<string[][]> {
  return createSheetsApi(env, { write: false }).read('A:AZ');
}

export async function pickNextFromSheet(
  platform: SheetPlatform,
  from?: number,
  env: Record<string, string | undefined> = process.env,
  options: PickOptions = {},
): Promise<SheetPick | null> {
  return pickNextRow(await readSocialSheet(env), platform, from, options);
}

// --- writing the generated post ---------------------------------------------------------------------------

export interface WriteResult {
  /** A1 address that was written, e.g. "M122". */
  cell: string;
  /** The cell was read back and holds exactly the text that was written. */
  verified: boolean;
}

export interface WriteOptions {
  /** Replace text that is already in the cell. Default false: an existing generated text is never overwritten. */
  overwrite?: boolean;
}

/** Reconciliation after an interrupted write. Never overwrites or changes publisher fields. */
export async function readPostSnapshot(api: SheetsApi, platform: SheetPlatform, rowIndex: number): Promise<{ url: string; text: string; status: string; postUrl: string; cell: string }> {
  const header = (await api.read('1:1'))[0] ?? [];
  const cols = PLATFORM_COLUMNS[platform];
  const postIdx = columnIndex(header, cols.post);
  const urlIdx = columnIndex(header, URL_COLUMNS);
  if (postIdx < 0 || urlIdx < 0) throw new EngineError(`Missing ${cols.label} Post or report URL column.`, 'fatal', 'SHEET_COLUMNS');
  const row = (await api.read(`${rowIndex}:${rowIndex}`))[0] ?? [];
  const at = (i: number) => i < 0 ? '' : row[i] ?? '';
  return { url: at(urlIdx).trim(), text: at(postIdx), status: at(columnIndex(header, cols.status)).trim(), postUrl: at(columnIndex(header, cols.postUrl)).trim(), cell: `${columnLetter(postIdx)}${rowIndex}` };
}

/**
 * Writes the generated text into "<Platform> Post" of ONE row, right before the daemon would look at it. It reads the
 * row again first and refuses (throws) when:
 *  - the row no longer holds the report the text was written for (a row was inserted or sorted in between),
 *  - the platform's Post URL or Status is already filled (the daemon has handled, or is handling, this row),
 *  - the Post cell already has text and `overwrite` was not asked for.
 * It touches no other cell. After writing it reads the cell back to confirm.
 */
export async function writeGeneratedPost(
  api: SheetsApi,
  platform: SheetPlatform,
  expected: { rowIndex: number; url: string },
  text: string,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const cols = PLATFORM_COLUMNS[platform];
  const header = (await api.read('1:1'))[0] ?? [];
  const postIdx = columnIndex(header, cols.post);
  if (postIdx < 0) throw new EngineError(`No "${cols.post[0]}" column in the sheet header.`, 'fatal', 'SHEET_COLUMNS');
  const urlIdx = columnIndex(header, URL_COLUMNS);
  const statusIdx = columnIndex(header, cols.status);
  const postUrlIdx = columnIndex(header, cols.postUrl);
  const row = (await api.read(`${expected.rowIndex}:${expected.rowIndex}`))[0] ?? [];
  const at = (i: number): string => (i >= 0 ? (row[i] ?? '').trim() : '');

  if (urlIdx >= 0 && at(urlIdx).replace(/\/+$/, '') !== expected.url.trim().replace(/\/+$/, '')) {
    throw new EngineError(`Row ${expected.rowIndex} no longer holds this report (found "${at(urlIdx).slice(0, 80)}"). Not written.`, 'fatal', 'SHEET_ROW_MOVED');
  }
  if (at(postUrlIdx) !== '' || at(statusIdx) !== '') {
    throw new EngineError(`Row ${expected.rowIndex} already has a ${cols.label} status or post URL (the daemon has handled it). Not written.`, 'fatal', 'SHEET_ROW_PROCESSED');
  }
  if (at(postIdx) !== '' && !options.overwrite) {
    throw new EngineError(`Row ${expected.rowIndex} already has text in "${cols.post[0]}". Not overwritten (pass --overwrite to replace it).`, 'fatal', 'SHEET_CELL_FILLED');
  }

  const cell = `${columnLetter(postIdx)}${expected.rowIndex}`;
  await api.writeCell(cell, text);
  const back = (await api.read(cell))[0]?.[0] ?? '';
  return { cell, verified: back === text };
}
