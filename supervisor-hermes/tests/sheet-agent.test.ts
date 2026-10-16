import { describe, expect, it } from 'vitest';
import type { SheetsApi } from '../../src/sheets/social-sheet.js';
import { pickRowAgent, writeRowAgent } from '../src/agents/sheet.js';

const header = ['targetUrl', 'title', 'seoKeywords', 'FB Post', 'FB Post URL', 'FB Status', 'LinkedIn Post', 'LinkedIn Post URL', 'LinkedIn Status'];
const rows = [
  header,
  ['https://www.kenresearch.com/a', 'Alpha Widget Market Share, Companies & Trends Report 2025', '', '', 'https://fb/1', 'Posted', '', '', ''],
  ['https://www.kenresearch.com/b', 'Beta Gadget Market', 'beta gadget outlook', '', '', '', '', '', ''],
  ['https://www.kenresearch.com/c', 'Gamma Parts Market', '', '', '', '', '', '', ''],
];

describe('pickRowAgent', () => {
  it('picks the first unprocessed row after the last processed one and uses seoKeywords', () => {
    const r = pickRowAgent(rows, 'facebook', new Set())!;
    expect(r.output).toMatchObject({ rowIndex: 3, url: 'https://www.kenresearch.com/b', keyword: 'beta gadget outlook' });
  });
  it('infers the keyword from the title when seoKeywords is empty, and skips excluded rows', () => {
    const r = pickRowAgent(rows, 'facebook', new Set([3]))!;
    expect(r.output.rowIndex).toBe(4);
    expect(r.output.keyword).toBe('Gamma Parts Market');
  });
  it('lets an override keyword win', () => {
    expect(pickRowAgent(rows, 'facebook', new Set(), 'my phrase here')!.output.keyword).toBe('my phrase here');
  });
  it('returns null when no row is left', () => {
    expect(pickRowAgent(rows, 'facebook', new Set([3, 4]))).toBeNull();
  });
});

describe('writeRowAgent', () => {
  it('writes one Post cell and reports the verified read-back', async () => {
    const cells = new Map<string, string>();
    const api: SheetsApi = {
      tab: 'Social Media',
      async read(range) {
        if (range === '1:1') return [header];
        if (/^\d+:\d+$/.test(range)) return [['https://www.kenresearch.com/b', 'Beta Gadget Market', '', '', '', '', '', '', '']];
        return [[cells.get(range) ?? '']];
      },
      async writeCell(a1, text) {
        cells.set(a1, text);
      },
    };
    const report = await writeRowAgent(api, 'facebook', { rowIndex: 3, url: 'https://www.kenresearch.com/b', title: 'Beta Gadget Market', keyword: 'beta gadget' }, 'POST TEXT');
    expect(report.output).toEqual({ cell: 'D3', verified: true });
    expect(cells.get('D3')).toBe('POST TEXT');
  });
});
