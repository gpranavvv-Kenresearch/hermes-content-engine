import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Storage behind a small interface so the JSON-file implementation can be
 * swapped for Postgres later without touching callers. Collections hold JSON
 * documents addressed by id.
 */
export interface Store {
  put<T>(collection: string, id: string, value: T): Promise<void>;
  get<T>(collection: string, id: string): Promise<T | undefined>;
  list<T>(collection: string): Promise<Array<{ id: string; value: T }>>;
  delete(collection: string, id: string): Promise<boolean>;
}

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function assertSafe(kind: string, segment: string): void {
  if (!SAFE_SEGMENT_RE.test(segment) || segment === '.' || segment === '..') {
    throw new Error(`Unsafe ${kind} name for store: "${segment}"`);
  }
}

export class MemoryStore implements Store {
  private readonly data = new Map<string, Map<string, string>>();

  async put<T>(collection: string, id: string, value: T): Promise<void> {
    assertSafe('collection', collection);
    assertSafe('id', id);
    const col = this.data.get(collection) ?? new Map<string, string>();
    col.set(id, JSON.stringify(value));
    this.data.set(collection, col);
  }

  async get<T>(collection: string, id: string): Promise<T | undefined> {
    const raw = this.data.get(collection)?.get(id);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  async list<T>(collection: string): Promise<Array<{ id: string; value: T }>> {
    const col = this.data.get(collection);
    if (!col) return [];
    return [...col.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, raw]) => ({ id, value: JSON.parse(raw) as T }));
  }

  async delete(collection: string, id: string): Promise<boolean> {
    return this.data.get(collection)?.delete(id) ?? false;
  }
}

/**
 * One JSON file per document under <root>/<collection>/<id>.json. Writes go to
 * a temp file and are renamed into place, so a crash mid-write never leaves a
 * half-written document.
 */
export class JsonFileStore implements Store {
  constructor(private readonly root: string) {}

  private dir(collection: string): string {
    assertSafe('collection', collection);
    return join(this.root, collection);
  }

  private file(collection: string, id: string): string {
    assertSafe('id', id);
    return join(this.dir(collection), `${id}.json`);
  }

  async put<T>(collection: string, id: string, value: T): Promise<void> {
    await mkdir(this.dir(collection), { recursive: true });
    const target = this.file(collection, id);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
    await rename(temp, target);
  }

  async get<T>(collection: string, id: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.file(collection, id), 'utf8')) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }

  async list<T>(collection: string): Promise<Array<{ id: string; value: T }>> {
    let names: string[];
    try {
      names = await readdir(this.dir(collection));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const out: Array<{ id: string; value: T }> = [];
    for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
      const id = name.slice(0, -'.json'.length);
      const value = await this.get<T>(collection, id);
      if (value !== undefined) out.push({ id, value });
    }
    return out;
  }

  async delete(collection: string, id: string): Promise<boolean> {
    try {
      await rm(this.file(collection, id));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }
}
