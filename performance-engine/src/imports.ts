import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { Metrics, Strategy, timestamp } from './contracts.js';

export const ImportRow = z.object({ postUrl: z.url(), accountId: z.string().min(1), publishedAt: timestamp, observedAt: timestamp, metrics: Metrics, source: z.string().min(1), scope: z.enum(['all', 'organic', 'unknown']), contentType: z.enum(['text', 'image', 'video', 'unknown']).optional(), distribution: z.enum(['organic', 'paid', 'unknown']).optional(), nativeUrn: z.string().optional(), nativePostId: z.string().optional(), strategy: Strategy.optional() });
export function parseCsv(raw: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '"') { if (quoted && raw[i + 1] === '"') { field += '"'; i++; } else if (!field || quoted) quoted = !quoted; else throw new Error('Invalid CSV quoting'); }
    else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && raw[i + 1] === '\n') i++; row.push(field); if (row.some(Boolean)) rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (quoted) throw new Error('Unterminated CSV quoted field');
  row.push(field); if (row.some(Boolean)) rows.push(row);
  return rows;
}
export async function readImport(file: string): Promise<Array<z.infer<typeof ImportRow>>> {
  const raw = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
  if (!file.toLowerCase().endsWith('.csv')) return z.array(ImportRow).parse(JSON.parse(raw));
  const rows = parseCsv(raw); const header = rows.shift();
  if (!header || new Set(header).size !== header.length) throw new Error('CSV headers missing or duplicated');
  return rows.map(row => {
    const values = Object.fromEntries(header.map((h, i) => [h, row[i]?.trim() ?? '']));
    const metrics = Object.fromEntries(Object.keys(Metrics.shape).map(k => [k, values[k] === undefined || values[k] === '' ? null : Number(values[k])]));
    const strategy = Object.fromEntries(Object.keys(Strategy.shape).filter(k => values[k]).map(k => [k, values[k]]));
    return ImportRow.parse({ ...values, metrics, strategy, contentType: values.contentType || undefined, distribution: values.distribution || undefined, nativeUrn: values.nativeUrn || undefined, nativePostId: values.nativePostId || undefined });
  });
}
