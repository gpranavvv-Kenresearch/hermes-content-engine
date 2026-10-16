import type { Fact } from '../../../src/schemas/index.js';

/** Obviously fake data. "Zorbland" does not exist. */
export function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: 'F1',
    metric: 'market_size',
    value: 12.5,
    unit: 'USD billion',
    period: '2025',
    geography: 'Zorbland',
    factType: 'observed',
    precision: 1,
    sourceUrl: 'https://www.kenresearch.com/fake-report-001',
    sourceTitle: 'FAKE Zorbland Widgets Report',
    sourceRetrievedAt: '2026-01-01T00:00:00.000Z',
    verificationStatus: 'verified',
    ...overrides,
  };
}

export const FAKE_GOV_URL = 'https://stats.example.gov/fake-table-7';
export const FAKE_COMPETITOR_URL = 'https://www.mordorintelligence.com/industry-reports/fake';

/** Three verified, same-unit facts for different years (a trend). */
export function trendFacts(): Fact[] {
  return [
    makeFact({ id: 'T1', value: 10, period: '2023', geography: 'Zorbland' }),
    makeFact({ id: 'T2', value: 12.5, period: '2024', geography: 'Zorbland' }),
    makeFact({ id: 'T3', value: 15.75, period: '2025', geography: 'Zorbland', precision: 2, sourceUrl: FAKE_GOV_URL }),
  ];
}

/** Three verified, same-unit facts for different countries (a comparison). */
export function geoFacts(): Fact[] {
  return [
    makeFact({ id: 'G1', value: 4, geography: 'Zorbland' }),
    makeFact({ id: 'G2', value: 7, geography: 'Quuxia' }),
    makeFact({ id: 'G3', value: 2.5, geography: 'Blorptopia' }),
  ];
}
