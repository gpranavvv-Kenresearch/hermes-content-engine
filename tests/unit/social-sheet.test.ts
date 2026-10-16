import { describe, expect, it } from 'vitest';
import { parseSheetPlatform, pickNextRow } from '../../src/sheets/social-sheet.js';

const H = ['Blog Title', 'Report URL', 'X Status', 'X Post URL', 'FB Status', 'FB Post URL', 'LinkedIn Status', 'LinkedIn Post URL'];
const rows = [
  H,
  ['A', 'https://www.kenresearch.com/a', 'Posted', 'https://x.com/1', '', '', '', ''],
  ['B', 'https://www.kenresearch.com/b', 'Failed', '', 'Posted', '', '', ''],
  ['C', 'https://www.kenresearch.com/c', '', '', '', '', '', ''],
  ['D', 'https://www.kenresearch.com/d', '', '', '', '', '', ''],
];

describe('pickNextRow', () => {
  it('picks the first row after the last processed one, per platform', () => {
    expect(pickNextRow(rows, 'x')).toEqual({ rowIndex: 4, title: 'C', url: 'https://www.kenresearch.com/c' });
    expect(pickNextRow(rows, 'facebook')).toEqual({ rowIndex: 4, title: 'C', url: 'https://www.kenresearch.com/c' });
    expect(pickNextRow(rows, 'linkedin')).toEqual({ rowIndex: 2, title: 'A', url: 'https://www.kenresearch.com/a' });
  });

  it('does not go back to an empty row above the last processed one', () => {
    const gap = [H, ['A', 'https://k/a', '', '', '', '', '', ''], ['B', 'https://k/b', 'Posted', '', '', '', '', '']];
    expect(pickNextRow(gap, 'x')).toBeNull();
  });

  it('returns null when nothing is left, and honours an explicit row', () => {
    expect(pickNextRow([H, rows[1]!], 'x')).toBeNull();
    expect(pickNextRow(rows, 'x', 5)).toEqual({ rowIndex: 5, title: 'D', url: 'https://www.kenresearch.com/d' });
    expect(pickNextRow(rows, 'x', 99)).toBeNull();
  });

  it('fails clearly when a column is missing', () => {
    expect(() => pickNextRow([['Blog Title', 'Report URL']], 'x')).toThrow(/status or post-URL/);
    expect(() => pickNextRow([['Blog Title']], 'x')).toThrow(/report URL column/);
  });

  it('accepts li, fb and x as platform names', () => {
    expect(['li', 'FB', 'x', 'twitter'].map(parseSheetPlatform)).toEqual(['linkedin', 'facebook', 'x', 'x']);
    expect(() => parseSheetPlatform('tiktok')).toThrow(/Unknown platform/);
    expect(parseSheetPlatform('Tumblr')).toBe('tumblr');
  });
});

import { columnLetter, createSheetsApi, writeGeneratedPost, type SheetsApi } from '../../src/sheets/social-sheet.js';

describe('columnLetter', () => {
  it('maps indexes to A1 letters', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });
});

describe('skipGenerated', () => {
  const H2 = ['targetUrl', 'title', 'LinkedIn Post', 'LinkedIn Status', 'LinkedIn Post URL'];
  const rows = [
    H2,
    ['https://k/a', 'A', 'done', 'Posted', 'https://l/1'],
    ['https://k/b', 'B', 'already generated text', '', ''],
    ['https://k/c', 'C', '', '', ''],
  ];
  it('moves past rows that already hold generated text, but not when a row is forced', () => {
    expect(pickNextRow(rows, 'linkedin')?.rowIndex).toBe(3);
    expect(pickNextRow(rows, 'linkedin', undefined, { skipGenerated: true })?.rowIndex).toBe(4);
    expect(pickNextRow(rows, 'linkedin', 3, { skipGenerated: true })?.rowIndex).toBe(3);
  });
});

/** An in-memory sheet that records every write. */
function fakeApi(rows: string[][]): SheetsApi & { writes: Array<{ a1: string; text: string }>; rows: string[][] } {
  const writes: Array<{ a1: string; text: string }> = [];
  return {
    tab: 'Social Media',
    rows,
    writes,
    async read(range) {
      if (range === '1:1') return [rows[0]!];
      const row = range.match(/^(\d+):\1$/);
      if (row) return [rows[Number(row[1]) - 1] ?? []];
      const cell = range.match(/^([A-Z]+)(\d+)$/);
      if (cell) {
        const col = [...cell[1]!].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        return [[rows[Number(cell[2]) - 1]?.[col] ?? '']];
      }
      throw new Error(`unexpected range ${range}`);
    },
    async writeCell(a1, text) {
      writes.push({ a1, text });
      const m = a1.match(/^([A-Z]+)(\d+)$/)!;
      const col = [...m[1]!].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const r = rows[Number(m[2]) - 1]!;
      while (r.length <= col) r.push('');
      r[col] = text;
    },
  };
}

describe('writeGeneratedPost', () => {
  it('picks and writes the Tumblr Post column with the usual status and read-back guards', async () => {
    const header = ['targetUrl', 'title', 'Tumblr Post', 'Tumblr Post URL', 'Tumblr Status'];
    const api = fakeApi([header, ['https://k/a', 'A', '', '', ''], ['https://k/b', 'B', '', '', '']]);
    expect(pickNextRow(api.rows, 'tumblr', undefined, { skipGenerated: true })?.rowIndex).toBe(2);
    expect(await writeGeneratedPost(api, 'tumblr', { rowIndex: 2, url: 'https://k/a' }, 'Tumblr text')).toEqual({ cell: 'C2', verified: true });
    expect(pickNextRow(api.rows, 'tumblr', undefined, { skipGenerated: true })?.rowIndex).toBe(3);
  });
  const header = ['targetUrl', 'title', 'LinkedIn Post', 'LinkedIn Post URL', 'LinkedIn Status', 'X Post'];
  const make = () => [header, ['https://k/a', 'A', '', '', '', ''], ['https://k/b', 'B', '', '', '', '']];
  const where = { rowIndex: 2, url: 'https://k/a' };

  it('writes ONLY the platform Post cell, and confirms it by reading it back', async () => {
    const api = fakeApi(make());
    const out = await writeGeneratedPost(api, 'linkedin', where, 'The post text');
    expect(out).toEqual({ cell: 'C2', verified: true });
    expect(api.writes).toEqual([{ a1: 'C2', text: 'The post text' }]);
    expect(api.rows[1]).toEqual(['https://k/a', 'A', 'The post text', '', '', '']);
  });

  it('writes to the right column for each platform', async () => {
    const api = fakeApi(make());
    expect((await writeGeneratedPost(api, 'x', where, 'tweet')).cell).toBe('F2');
  });

  it('never overwrites text that is already there unless asked', async () => {
    const rows = make();
    rows[1]![2] = 'earlier text';
    const api = fakeApi(rows);
    await expect(writeGeneratedPost(api, 'linkedin', where, 'new')).rejects.toMatchObject({ code: 'SHEET_CELL_FILLED' });
    expect(api.writes).toEqual([]);
    expect((await writeGeneratedPost(api, 'linkedin', where, 'new', { overwrite: true })).verified).toBe(true);
    expect(api.rows[1]![2]).toBe('new');
  });

  it('refuses a row the daemon has handled or is handling (status or post URL filled)', async () => {
    const posted = make();
    posted[1]![4] = 'Posted';
    await expect(writeGeneratedPost(fakeApi(posted), 'linkedin', where, 't')).rejects.toMatchObject({ code: 'SHEET_ROW_PROCESSED' });
    const withUrl = make();
    withUrl[1]![3] = 'https://linkedin.com/x';
    await expect(writeGeneratedPost(fakeApi(withUrl), 'linkedin', where, 't')).rejects.toMatchObject({ code: 'SHEET_ROW_PROCESSED' });
  });

  it('refuses when the row no longer holds the report the text was written for', async () => {
    const api = fakeApi(make());
    await expect(writeGeneratedPost(api, 'linkedin', { rowIndex: 3, url: 'https://k/a' }, 't')).rejects.toMatchObject({ code: 'SHEET_ROW_MOVED' });
    expect(api.writes).toEqual([]);
  });

  it('refuses a missing Post column', async () => {
    const api = fakeApi([['targetUrl', 'title'], ['https://k/a', 'A']]);
    await expect(writeGeneratedPost(api, 'linkedin', where, 't')).rejects.toMatchObject({ code: 'SHEET_COLUMNS' });
  });

  it('a read-only connection cannot write', async () => {
    const api = createSheetsApi({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b.c', private_key: 'x' }), CE_SHEET_ID: 'sheet-id' }, { write: false });
    await expect(api.writeCell('A1', 'x')).rejects.toMatchObject({ code: 'SHEET_READ_ONLY' });
  });

  it('requires the target Sheet ID to come from the private environment', () => {
    expect(() => createSheetsApi({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b.c', private_key: 'x' }) })).toThrow('CE_SHEET_ID');
  });
});

describe('exclude', () => {
  const H3 = ['targetUrl', 'title', 'X Status', 'X Post URL', 'X Post'];
  const rows3 = [H3, ['https://k/a', 'A', '', '', ''], ['https://k/b', 'B', '', '', ''], ['https://k/c', 'C', '', '', '']];
  it('passes over rows that are known to have no usable facts', () => {
    expect(pickNextRow(rows3, 'x')?.rowIndex).toBe(2);
    expect(pickNextRow(rows3, 'x', undefined, { exclude: new Set([2]) })?.rowIndex).toBe(3);
    expect(pickNextRow(rows3, 'x', undefined, { exclude: new Set([2, 3, 4]) })).toBeNull();
    expect(pickNextRow(rows3, 'x', 2, { exclude: new Set([2]) })?.rowIndex).toBe(2); // a forced row is never skipped
  });
});
