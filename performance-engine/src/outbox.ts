import { z } from 'zod';
import { hash } from './contracts.js';
import { PerformanceStore } from './store.js';
import { AnalyticsSheet, type SheetRecord } from './sheets.js';

export const RecordSchema = z.object({ id: z.string(), type: z.enum(['post', 'snapshot', 'learning', 'advice', 'research', 'experiment', 'report', 'capability']), at: z.iso.datetime({ offset: true }), status: z.string(), content: z.string(), recommendations: z.string().optional(), fields: z.record(z.string(), z.union([z.string(), z.number(), z.null()])), payload: z.unknown() });
export const Outbox = z.object({ record: RecordSchema, syncedHash: z.string().nullable(), lastError: z.string().nullable(), attempts: z.number().int().nonnegative() });
export async function enqueue(store: PerformanceStore, record: SheetRecord): Promise<void> {
  const clean = RecordSchema.parse(record);
  const previous = await store.get('outbox', clean.id, Outbox);
  const same = previous && JSON.stringify(previous.record) === JSON.stringify(clean);
  await store.put('outbox', clean.id, { record: clean, syncedHash: same ? previous.syncedHash : null, lastError: same ? previous.lastError : null, attempts: same ? previous.attempts : 0 });
}
export async function flush(store: PerformanceStore, sheet: AnalyticsSheet, limit = 25): Promise<{ verified: number; pending: number; errors: number }> {
  const all = await store.list('outbox', Outbox);
  const pending = all.filter(r => r.syncedHash !== hash(JSON.stringify(r.record))).sort((a, b) => a.record.at.localeCompare(b.record.at));
  let verified = 0, errors = 0;
  for (const item of pending.slice(0, limit)) {
    try {
      await sheet.upsert(item.record);
      await store.put('outbox', item.record.id, { ...item, syncedHash: hash(JSON.stringify(item.record)), lastError: null, attempts: item.attempts + 1 }); verified++;
    } catch (error) {
      // API exceptions can contain request config / tokens. Store only an actionable generic message.
      const status = (error as any)?.response?.status;
      const detail = error instanceof Error && /^(?:Analytics |Duplicate analytics|Missing existing Algo|Unknown analytics|Could not reconcile|Existing tab)/.test(error.message) ? error.message.slice(0, 220) : typeof status === 'number' ? `Google Sheets HTTP ${status}` : 'Network/authentication request failed';
      await store.put('outbox', item.record.id, { ...item, lastError: `Sheet sync failed: ${detail}. Saved locally for retry.`, attempts: item.attempts + 1 }); errors++; break;
    }
  }
  return { verified, pending: pending.length - verified, errors };
}
