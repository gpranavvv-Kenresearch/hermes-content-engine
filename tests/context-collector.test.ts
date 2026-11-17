import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TrendsRunOptions, TrendsRunResult } from '../src/signals/trends-browser.js';

// The cache directory is resolved from the working directory at import time, so move into a temp dir first.
let collect: typeof import('../src/signals/context-collector.js').collectSearchContext;
beforeAll(async () => {
  process.chdir(mkdtempSync(path.join(os.tmpdir(), 'ctx-collector-')));
  ({ collectSearchContext: collect } = await import('../src/signals/context-collector.js'));
});

const sec = (kind: string, rows: Array<Record<string, string>>) => ({ kind, file: `${kind}.csv`, header: [], rows }) as TrendsRunResult['sections'][number];
const queries = [{ query: 'engine oil price', 'search interest': '100', 'increase percent': '5%' }];
const res = (o: TrendsRunOptions, sections: TrendsRunResult['sections'], status: TrendsRunResult['status'] = 'PARTIAL'): TrendsRunResult =>
  ({ status, keyword: o.q, geo: o.geo ?? '', date: 'today 12-m', startedAt: '', note: '', runDir: '/run', sections });

describe('collectSearchContext', () => {
  it('runs Worldwide and country side by side, needs only queries, and merges across retries', async () => {
    const events: string[] = [];
    const calls: Record<string, number> = {};
    const out = await collect('Kenya Lubricants Market', {
      gapMs: 1, log: () => undefined,
      fetchRun: async (o) => {
        const scope = o.geo || 'WW';
        calls[scope] = (calls[scope] ?? 0) + 1;
        events.push(`start ${scope}#${calls[scope]}`);
        await new Promise((r) => setTimeout(r, 20));
        events.push(`end ${scope}#${calls[scope]}`);
        expect(o.queriesOnly).toBe(true);
        if (scope === 'KE') return res(o, [sec('top_queries', queries)]);
        // Worldwide: the first attempt brings nothing, the retry brings the queries.
        return calls[scope] === 1 ? res(o, [], 'NO_DOWNLOADS') : res(o, [sec('top_queries', queries), sec('rising_queries', queries)]);
      },
    });
    expect(out.status).toBe('COLLECTED');
    // Both first-wave fetches started before either finished.
    expect(events.slice(0, 2).every((e) => e.startsWith('start'))).toBe(true);
    // Kenya is complete after one attempt, so it is not fetched again.
    expect(calls).toEqual({ WW: 2, KE: 1 });
    const ww = out.context!.entries.find((e) => e.scope === 'Worldwide')!;
    expect(ww.status).toBe('OK');
    expect(ww.top.map((q) => q.query)).toEqual(['engine oil price']);
    expect(out.context!.entries.find((e) => e.scope === 'Kenya')!.status).toBe('OK');
  });

  it('reports FAILED, not empty data, when Google asks for sign-in', async () => {
    const out = await collect('Brazil Seed Market', {
      gapMs: 1, log: () => undefined, force: true,
      fetchRun: async (o) => res(o, [], 'SIGN_IN_REQUIRED'),
    });
    expect(out.status).toBe('FAILED');
    expect(out.note).toMatch(/session expired/);
  });
});
