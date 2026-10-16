import { existsSync, readFileSync } from 'node:fs';
import { FontNotFoundError } from './errors.js';

/** Well-known fonts, tried in order when CE_FONT_PATH is not set. */
export const FONT_CANDIDATES: readonly string[] = [
  'C:/Windows/Fonts/segoeui.ttf',
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/calibri.ttf',
  'C:/Windows/Fonts/tahoma.ttf',
  'C:/Windows/Fonts/verdana.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/Library/Fonts/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
];

export interface ResolvedFont {
  path: string;
  /** Family name read from the font's own name table (what resvg/vega must reference). */
  family: string;
  data: Buffer;
}

/** Path of the first usable font, or null. CE_FONT_PATH wins when it points at an existing file. */
export function findFontPath(
  env: Record<string, string | undefined> = process.env,
  candidates: readonly string[] = FONT_CANDIDATES,
): string | null {
  const fromEnv = env['CE_FONT_PATH'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** True when a font is available on this machine. Tests use this with describe.skipIf. */
export const fontAvailable: boolean = findFontPath() !== null;

/**
 * Family name (name ID 1) from a TrueType/OpenType font buffer. Handles
 * .ttc collections by reading the first font. Falls back to "sans-serif".
 */
export function readFontFamily(data: Buffer): string {
  try {
    let base = 0;
    if (data.toString('latin1', 0, 4) === 'ttcf') base = data.readUInt32BE(12);
    const numTables = data.readUInt16BE(base + 4);
    let nameOffset = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = base + 12 + i * 16;
      if (data.toString('latin1', rec, rec + 4) === 'name') {
        nameOffset = data.readUInt32BE(rec + 8);
        break;
      }
    }
    if (nameOffset < 0) return 'sans-serif';
    const count = data.readUInt16BE(nameOffset + 2);
    const stringOffset = nameOffset + data.readUInt16BE(nameOffset + 4);
    let fallback: string | undefined;
    for (let i = 0; i < count; i++) {
      const rec = nameOffset + 6 + i * 12;
      const platform = data.readUInt16BE(rec);
      const nameId = data.readUInt16BE(rec + 6);
      if (nameId !== 1) continue;
      const length = data.readUInt16BE(rec + 8);
      const offset = data.readUInt16BE(rec + 10);
      const raw = data.subarray(stringOffset + offset, stringOffset + offset + length);
      if (platform === 3 || platform === 0) {
        const be = Buffer.from(raw);
        be.swap16();
        return be.toString('utf16le');
      }
      fallback ??= raw.toString('latin1');
    }
    return fallback ?? 'sans-serif';
  } catch {
    return 'sans-serif';
  }
}

let cache: { key: string; font: ResolvedFont } | undefined;

/** Loads (and caches) the font. Throws FontNotFoundError when none exists. */
export function resolveFont(
  env: Record<string, string | undefined> = process.env,
  candidates: readonly string[] = FONT_CANDIDATES,
): ResolvedFont {
  const path = findFontPath(env, candidates);
  if (!path) {
    const tried = [...(env['CE_FONT_PATH'] ? [`CE_FONT_PATH=${env['CE_FONT_PATH']}`] : []), ...candidates];
    throw new FontNotFoundError(tried);
  }
  if (cache?.key === path) return cache.font;
  const data = readFileSync(path);
  const font = { path, family: readFontFamily(data), data };
  cache = { key: path, font };
  return font;
}
