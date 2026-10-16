import type { LedgerEvent } from './ledger.js';

const time = (at: string | undefined): string => (at ? at.slice(11, 19) : '--:--:--');
const asRecord = (data: unknown): Record<string, unknown> => (data && typeof data === 'object' ? (data as Record<string, unknown>) : {});

/** One line per ledger event, for `hermes:status`. */
export function formatTimeline(events: readonly LedgerEvent[]): string {
  if (events.length === 0) return 'no events recorded for this run';
  return events
    .map((e) => {
      const d = asRecord(e.data);
      switch (e.type) {
        case 'agent':
          return `${time(e.at)}  agent ${e.agent}: ${String(d.summary ?? '')}${Array.isArray(d.concerns) && d.concerns.length ? ` | concerns: ${d.concerns.join('; ')}` : ''}`;
        case 'decision': {
          const final = asRecord(d.final);
          const flags = [d.overridden ? 'overridden by code' : '', d.failedClosed ? 'supervisor failed closed' : ''].filter(Boolean);
          return `${time(e.at)}  gate ${e.gate}: ${String(final.action ?? '?')} (${String(final.reason ?? '')})${flags.length ? ` [${flags.join('; ')}]` : ''}`;
        }
        case 'control':
          return `${time(e.at)}  control: ${String(d.message ?? '')}`;
        case 'result':
          return `${time(e.at)}  result: ${String(d.status ?? '?')} - ${String(d.reason ?? '')}`;
      }
    })
    .join('\n');
}
