import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';
import { JsonFileStore, MemoryStore, type Store } from '../../src/store/store.js';

let tmpRoot: string | undefined;
afterAll(async () => {
  if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
});

async function contractTests(store: Store) {
  await store.put('drafts', 'd1', { text: 'hello' });
  await store.put('drafts', 'd2', { text: 'world' });
  expect(await store.get('drafts', 'd1')).toEqual({ text: 'hello' });
  expect(await store.get('drafts', 'missing')).toBeUndefined();
  expect((await store.list('drafts')).map((r) => r.id)).toEqual(['d1', 'd2']);
  expect(await store.list('empty')).toEqual([]);
  await store.put('drafts', 'd1', { text: 'updated' });
  expect(await store.get('drafts', 'd1')).toEqual({ text: 'updated' });
  expect(await store.delete('drafts', 'd1')).toBe(true);
  expect(await store.delete('drafts', 'd1')).toBe(false);
  await expect(store.put('../escape', 'x', 1)).rejects.toThrow(/Unsafe/);
  await expect(store.put('drafts', '../x', 1)).rejects.toThrow(/Unsafe/);
}

describe('stores', () => {
  it('MemoryStore satisfies the Store contract', async () => {
    await contractTests(new MemoryStore());
  });

  it('JsonFileStore satisfies the Store contract and leaves no temp files', async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'ce-store-'));
    await contractTests(new JsonFileStore(tmpRoot));
    const files = await readdir(join(tmpRoot, 'drafts'));
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('logger', () => {
  it('redacts secrets and stamps a runId', async () => {
    const chunks: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString());
        cb();
      },
    });
    const log = createLogger({ runId: 'run-123', destination: sink });
    log.info({ apiKey: 'sk-secret', cookie: 'abc', nested: { token: 't0k3n' }, safe: 'visible' }, 'hello');
    await new Promise((r) => setTimeout(r, 10));
    const line = chunks.join('');
    expect(line).toContain('run-123');
    expect(line).toContain('visible');
    expect(line).not.toContain('sk-secret');
    expect(line).not.toContain('t0k3n');
    expect(line).toContain('[REDACTED]');
  });
});
