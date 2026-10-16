import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentName, Gate } from './types.js';

export interface LedgerEvent {
  at?: string;
  type: 'agent' | 'decision' | 'control' | 'result';
  agent?: AgentName;
  gate?: Gate;
  data: unknown;
}

export class Ledger {
  readonly dir: string;
  private readonly file: string;

  /** `onEvent` lets the CLI print each event as it happens; it never affects the run. */
  constructor(
    root: string,
    readonly runId: string,
    private readonly onEvent?: (event: LedgerEvent) => void,
  ) {
    this.dir = path.join(root, 'runs', runId);
    this.file = path.join(this.dir, 'events.jsonl');
  }

  async append(event: LedgerEvent): Promise<void> {
    const stamped = { ...event, at: event.at ?? new Date().toISOString() };
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file, `${JSON.stringify(stamped)}\n`, 'utf8');
    try {
      this.onEvent?.(stamped);
    } catch {
      /* progress output must never break a run */
    }
  }

  /** Exact source material for auditing a review after the source page changes. */
  async saveEvidence(evidence: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
  }

  /** Keeps every draft (rejected ones too) as `drafts/NN.txt`, with the verdict beside it as `drafts/NN-verdict.txt`. */
  async saveDraft(n: number, text: string, verdict: string): Promise<void> {
    const dir = path.join(this.dir, 'drafts');
    await mkdir(dir, { recursive: true });
    const id = String(n).padStart(2, '0');
    await writeFile(path.join(dir, `${id}.txt`), text, 'utf8');
    await writeFile(path.join(dir, `${id}-verdict.txt`), verdict, 'utf8');
  }

  static async read(root: string, runId: string): Promise<LedgerEvent[]> {
    try {
      const raw = await readFile(path.join(root, 'runs', runId, 'events.jsonl'), 'utf8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as LedgerEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
}
