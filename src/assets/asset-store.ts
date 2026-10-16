import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '../store/store.js';
import type { AssetRecord } from './card-renderer.js';

export const ASSET_COLLECTION = 'assets';
export const DEFAULT_ASSET_DIR = join('output', 'assets');

const FILE_NAME_RE = /^[a-f0-9]{64}\.png$/;

/**
 * Writes the PNG to <assetDir>/<hash>.png (atomically) and the AssetRecord JSON
 * through the Store under collection "assets", id = hash. Idempotent: the same
 * image always lands on the same file name. Returns the PNG path.
 */
export async function saveAsset(
  store: Store,
  asset: { png: Buffer; record: AssetRecord },
  assetDir: string = DEFAULT_ASSET_DIR,
): Promise<{ pngPath: string; id: string }> {
  const { fileName } = asset.record;
  if (!FILE_NAME_RE.test(fileName)) throw new Error(`Refusing to write asset with unsafe file name "${fileName}"`);
  await mkdir(assetDir, { recursive: true });
  const pngPath = join(assetDir, fileName);
  const temp = `${pngPath}.${process.pid}.tmp`;
  await writeFile(temp, asset.png);
  await rename(temp, pngPath);
  const id = fileName.slice(0, -'.png'.length);
  await store.put<AssetRecord>(ASSET_COLLECTION, id, asset.record);
  return { pngPath, id };
}

export async function getAssetRecord(store: Store, id: string): Promise<AssetRecord | undefined> {
  return store.get<AssetRecord>(ASSET_COLLECTION, id);
}

export async function listAssetRecords(store: Store): Promise<AssetRecord[]> {
  return (await store.list<AssetRecord>(ASSET_COLLECTION)).map((r) => r.value);
}
