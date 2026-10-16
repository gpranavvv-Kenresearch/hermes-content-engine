import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FactSchema, type Fact } from '../../../src/schemas/index.js';

const dir = fileURLToPath(new URL('.', import.meta.url));

export function loadFacts(): Fact[] {
  const raw = JSON.parse(readFileSync(`${dir}facts.json`, 'utf8')) as unknown[];
  return raw.map((r) => FactSchema.parse(r));
}

export function loadPage(name: 'page-a' | 'page-b' | 'page-c'): string {
  return readFileSync(`${dir}${name}.html`, 'utf8');
}
