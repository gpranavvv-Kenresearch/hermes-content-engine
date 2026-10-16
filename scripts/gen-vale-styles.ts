/**
 * Regenerates .vale.ini and styles/KenResearch/*.yml from the brand config.
 * Usage: npx tsx scripts/gen-vale-styles.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/index.js';
import { generateValeFiles } from '../src/validation/vale.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = generateValeFiles(loadConfig().brand);
for (const [rel, contents] of Object.entries(files)) {
  const target = resolve(root, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
  console.log(`wrote ${rel}`);
}
