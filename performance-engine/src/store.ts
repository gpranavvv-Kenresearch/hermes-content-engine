import { mkdir, readFile, rename, writeFile, open, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { stableId } from './contracts.js';

export async function atomicWrite(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx');
  try { await handle.writeFile(JSON.stringify(value, null, 2), 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file);
}
export class PerformanceStore {
  constructor(readonly root = path.resolve('output/performance-engine/state')) {}
  file(collection: string, id: string): string {
    if (!/^[a-z-]+$/.test(collection)) throw new Error('Invalid collection');
    return path.join(this.root, collection, `${stableId(id)}.json`);
  }
  async put(collection: string, id: string, value: unknown): Promise<void> { await atomicWrite(this.file(collection, id), value); }
  async get<T>(collection: string, id: string, schema: z.ZodType<T>): Promise<T | null> {
    try { return schema.parse(JSON.parse(await readFile(this.file(collection, id), 'utf8'))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  async list<T>(collection: string, schema: z.ZodType<T>): Promise<T[]> {
    let names: string[];
    try { names = await readdir(path.join(this.root, collection)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
    return Promise.all(names.filter(n => n.endsWith('.json')).sort().map(async n => schema.parse(JSON.parse(await readFile(path.join(this.root, collection, n), 'utf8')))));
  }
  async lock<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const file = path.join(this.root, 'writer.lock');
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const h = await open(file, 'wx'); try { await h.writeFile(JSON.stringify({ pid: process.pid, token })); } finally { await h.close(); } break; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const old = JSON.parse(await readFile(file, 'utf8')) as { pid: number; token: string };
        if (!Number.isInteger(old.pid) || old.pid <= 0) throw new Error('Invalid performance lock; inspect it before recovery');
        let alive = true;
        try { process.kill(old.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive || attempt === 1) throw new Error('Performance engine already running');
        // Exclusive reclaimer prevents two processes deleting a newly acquired writer lock.
        const reclaim = await open(`${file}.reclaim`, 'wx');
        try { if ((await readFile(file, 'utf8')) === JSON.stringify(old)) await unlink(file); }
        finally { await reclaim.close(); await unlink(`${file}.reclaim`); }
      }
    }
    try { return await action(); }
    finally { try { const current = JSON.parse(await readFile(file, 'utf8')); if (current.token === token) await unlink(file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  }
}
