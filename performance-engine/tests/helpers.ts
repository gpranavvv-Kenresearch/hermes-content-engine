import { Post, Snapshot, emptyMetrics, type Account } from '../src/contracts.js';
import { legacyHeaders, type SheetGateway, type CellValue } from '../src/sheets.js';
export const post = (patch: Partial<Post> = {}): Post => Post.parse({ id: 'p1', platform: 'x', accountId: 'account', postId: '123', url: 'https://x.com/ken/status/123', reportUrl: 'https://www.kenresearch.com/example', text: 'Ken Research finding.', textHash: 'hash', publishedAt: '2026-09-01T00:00:00.000Z', publishedAtSource: 'publisher', discoveredAt: '2026-09-01T00:00:00.000Z', sourceRow: 2, strategy: { layout: 'insight-brief' }, contentType: 'text', distribution: 'organic', ...patch });
export const snapshot = (patch: Partial<Snapshot> = {}): Snapshot => Snapshot.parse({ id: 's1', postId: 'p1', platform: 'x', accountId: 'account', window: 14, dueAt: '2026-09-15T00:00:00.000Z', observedAt: '2026-09-15T00:00:00.000Z', ageHours: 336, status: 'ok', source: 'api', metrics: { ...emptyMetrics(), impressions: 1000, likes: 10, comments: 1, shares: 1 }, definitions: {}, scope: 'all', reason: null, rawRef: null, attempts: 1, nextAttemptAt: null, ...patch });
export const account = (): Account => ({ id: 'account', platform: 'x', kind: 'user', handles: ['ken'], matchUnknown: false, tokenEnv: 'TOKEN', facebookInsights: {} });
const col = (letters: string): number => [...letters].reduce((v, c) => v * 26 + c.charCodeAt(0) - 64, 0) - 1;
export class FakeSheet implements SheetGateway {
  rows: string[][] = [[...legacyHeaders], ['2026-10-01', 'Legacy report', '3', 'Keep old data', '7%', 'Daily count']];
  updates = 0; appends = 0; appendTimeout = false; badReadback = false;
  async ensureColumns(): Promise<void> {}
  async insertColumns(_tab: string, startIndex: number, count: number): Promise<void> {
    for (const row of this.rows) row.splice(startIndex, 0, ...Array<string>(count).fill(''));
  }
  async read(_tab: string, range: string): Promise<string[][]> {
    if (range === '1:1') return [this.rows[0]!.slice()];
    const rr = /^(\d+):(\d+)$/.exec(range);
    if (rr) return this.rows.slice(Number(rr[1]) - 1, Number(rr[2])).map(r => r.slice());
    const cc = /^([A-Z]+)(\d*)?:([A-Z]+)(\d*)?$/.exec(range);
    if (cc) { const a = col(cc[1]!), b = col(cc[3]!); return this.rows.slice(cc[2] ? Number(cc[2]) - 1 : 0, cc[4] ? Number(cc[4]) : undefined).map(r => r.slice(a, b + 1)); }
    throw new Error(`Unsupported fake range ${range}`);
  }
  async update(_tab: string, cells: Array<{ range: string; values: CellValue[][] }>): Promise<void> {
    this.updates++;
    for (const cell of cells) {
      const start = /^([A-Z]+)(\d+)/.exec(cell.range)!; const row = Number(start[2]) - 1, column = col(start[1]!);
      for (let r = 0; r < cell.values.length; r++) {
        this.rows[row + r] ??= [];
        for (let c = 0; c < cell.values[r]!.length; c++) this.rows[row + r]![column + c] = String(cell.values[r]![c]!);
      }
    }
  }
  async append(_tab: string, values: CellValue[]): Promise<void> { this.appends++; this.rows.push(values.map(String)); if (this.appendTimeout) { this.appendTimeout = false; throw new Error('Uncertain write timeout'); } }
}
