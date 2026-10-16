import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger } from '../src/ledger.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('Ledger', () => {
  it('appends events in order and reads them back', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ledger-'));
    dirs.push(root);
    const ledger = new Ledger(root, 'run_1');
    await ledger.append({ type: 'agent', agent: 'evidence', data: { facts: 3 } });
    await ledger.append({ type: 'decision', gate: 'evidence', data: { action: 'proceed' } });
    const events = await Ledger.read(root, 'run_1');
    expect(events.map((e) => e.type)).toEqual(['agent', 'decision']);
    expect(events[0]!.at).toMatch(/^\d{4}-/);
  });
  it('calls onEvent for every appended event, with its timestamp, so the CLI can show progress live', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ledger-'));
    dirs.push(root);
    const seen: string[] = [];
    const ledger = new Ledger(root, 'run_2', (e) => seen.push(`${e.type}:${e.at ? 'at' : 'no-at'}`));
    await ledger.append({ type: 'agent', agent: 'sheet', data: {} });
    await ledger.append({ type: 'result', data: {} });
    expect(seen).toEqual(['agent:at', 'result:at']);
  });
  it('a failing onEvent never breaks the run', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ledger-'));
    dirs.push(root);
    const ledger = new Ledger(root, 'run_3', () => {
      throw new Error('console closed');
    });
    await expect(ledger.append({ type: 'agent', data: {} })).resolves.toBeUndefined();
    expect(await Ledger.read(root, 'run_3')).toHaveLength(1);
  });
  it('saves a draft and its verdict as numbered files in the run folder', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ledger-'));
    dirs.push(root);
    const ledger = new Ledger(root, 'run_4');
    await ledger.saveDraft(1, 'FIRST DRAFT TEXT', 'verdict one');
    await ledger.saveDraft(12, 'TWELFTH', 'verdict twelve');
    expect(readFileSync(path.join(ledger.dir, 'drafts', '01.txt'), 'utf8')).toBe('FIRST DRAFT TEXT');
    expect(readFileSync(path.join(ledger.dir, 'drafts', '01-verdict.txt'), 'utf8')).toBe('verdict one');
    expect(readFileSync(path.join(ledger.dir, 'drafts', '12.txt'), 'utf8')).toBe('TWELFTH');
  });
  it('returns [] for an unknown run', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ledger-'));
    dirs.push(root);
    expect(await Ledger.read(root, 'nope')).toEqual([]);
  });
});
