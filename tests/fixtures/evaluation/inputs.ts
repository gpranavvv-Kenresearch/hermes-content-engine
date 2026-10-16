import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaimMapping } from '../../../src/contracts.js';
import type { ScoreInput } from '../../../src/evaluation/scoring.js';
import type { Fact } from '../../../src/schemas/index.js';
import { makeFact } from '../assets/facts.js';

const here = dirname(fileURLToPath(import.meta.url));

export function readFixture(name: string): string {
  return readFileSync(join(here, name), 'utf8');
}

export const facts: Fact[] = [
  makeFact({ id: 'F1', metric: 'market_size', value: 12.5 }),
  makeFact({ id: 'F2', metric: 'cagr', value: 8.2, unit: 'percent', period: '2025-2030', sourceUrl: 'https://stats.example.gov/fake-table-7' }),
  makeFact({ id: 'F3', metric: 'top_buyer_share', value: 61.4, unit: 'percent' }),
];

export const mappings: ClaimMapping[] = [
  { claim: '12.5 USD billion', status: 'supported', factId: 'F1' },
  { claim: '8.2%', status: 'supported', factId: 'F2' },
  { claim: '61.4%', status: 'supported', factId: 'F3' },
];

export function baseInput(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    text: readFixture('article.md'),
    facts,
    claimMappings: mappings,
    brief: {
      angle: 'Zorbland widget demand and buyer supply risks',
      keywords: ['widget market', 'Zorbland', 'supply contracts'],
      beatPoints: ['regional demand split', 'supply risks for buyers'],
    },
    platform: 'blog',
    corpus: ['An unrelated synthetic note about gadgets in Quuxia that shares nothing with the article text at all.'],
    ...overrides,
  };
}
