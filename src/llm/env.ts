import fs from 'node:fs';
import { parse } from 'dotenv';

export interface EnvLoadResult {
  /** Files that were read (paths only, never contents). */
  loaded: string[];
  /** Files that were named but could not be read. */
  missing: string[];
}

/**
 * Reads the extra env file named by CE_ENV_FILE (for example the legacy repo's
 * .env that already holds the free-tier API keys) WITHOUT copying it anywhere.
 * Values are parsed in memory and only fill variables that are not already
 * set, so the engine's own environment always wins. Nothing is written to disk
 * and no value is ever logged.
 */
export function loadEnvFiles(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): EnvLoadResult {
  const result: EnvLoadResult = { loaded: [], missing: [] };
  const file = env.CE_ENV_FILE?.trim();
  if (!file) return result;
  let text: string;
  try {
    text = readFile(file);
  } catch {
    result.missing.push(file);
    return result;
  }
  for (const [key, value] of Object.entries(parse(text))) {
    if (env[key] === undefined || env[key] === '') env[key] = value;
  }
  result.loaded.push(file);
  return result;
}
