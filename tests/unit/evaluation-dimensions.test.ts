import { describe, expect, it } from 'vitest';
import type { ClaimMapping } from '../../src/contracts.js';
import {
  countSyllables,
  findNumericFigures,
  fleschReadingEase,
  hierarchySkips,
  parseStructure,
  readabilityBandScore,
  scoreEvidenceCoverage,
  scoreIntentMatch,
  scoreOriginality,
  scoreReadability,
  scoreSourceTraceability,
  scoreStructure,
  scoreTechnical,
} from '../../src/evaluation/index.js';
import { FAKE_COMPETITOR_URL, makeFact } from '../fixtures/assets/facts.js';
import { baseInput, facts, mappings, readFixture } from '../fixtures/evaluation/inputs.js';

describe('evaluation: evidenceCoverage', () => {
  it('is 1 when every material claim is mapped', () => {
    const d = scoreEvidenceCoverage({ text: 'x', claimMappings: mappings });
    expect(d.score).toBe(1);
    expect(d.applicable).toBe(true);
  });

  it('counts unsupported, conflicting and ignored correctly', () => {
    const m: ClaimMapping[] = [
      { claim: 'a', status: 'supported', factId: 'F1' },
      { claim: 'b', status: 'derived', factId: 'F2' },
      { claim: 'c', status: 'unsupported' },
      { claim: 'd', status: 'conflicting', factId: 'F3' },
      { claim: 'e', status: 'ignored' },
    ];
    const d = scoreEvidenceCoverage({ text: 'x', claimMappings: m });
    expect(d.score).toBe(0.5); // 2 of 4 material; ignored excluded
    expect(d.evidence.join('\n')).toMatch(/unsupported: "c"/);
  });

  it('scores 0 when the text has figures but no mappings were supplied', () => {
    const d = scoreEvidenceCoverage({ text: 'Market grew 8.2% to 12.5 USD billion.', claimMappings: [] });
    expect(d.score).toBe(0);
    expect(d.applicable).toBe(true);
  });

  it('is not applicable for text with no numbers', () => {
    const d = scoreEvidenceCoverage({ text: 'Plain words only, in the year 2025.', claimMappings: [] });
    expect(d.applicable).toBe(false);
  });

  it('detects figures but not bare years', () => {
    expect(findNumericFigures('In 2025 it hit 8.2% and $1,200 and 3 billion')).toEqual(['8.2%', '$1,200', '3 billion']);
  });
});

describe('evaluation: sourceTraceability', () => {
  it('is 1 when every covered claim traces to a verified allowed-source fact', () => {
    expect(scoreSourceTraceability({ facts, claimMappings: mappings }).score).toBe(1);
  });

  it('fails unknown facts, unverified facts, bad sources and missing factIds', () => {
    const f = [
      makeFact({ id: 'A' }),
      makeFact({ id: 'B', verificationStatus: 'unverified' }),
      makeFact({ id: 'C', sourceUrl: FAKE_COMPETITOR_URL }),
    ];
    const m: ClaimMapping[] = [
      { claim: 'ok', status: 'supported', factId: 'A' },
      { claim: 'unverified', status: 'supported', factId: 'B' },
      { claim: 'competitor', status: 'supported', factId: 'C' },
      { claim: 'ghost', status: 'supported', factId: 'ZZZ' },
      { claim: 'nofact', status: 'derived' },
    ];
    const d = scoreSourceTraceability({ facts: f, claimMappings: m });
    expect(d.score).toBe(0.2);
    expect(d.evidence.join('\n')).toMatch(/not an allowed source/);
  });

  it('checks derivation inputs of derived facts', () => {
    const derived = makeFact({ id: 'D', factType: 'derived', derivation: { formula: 'A*2', inputFactIds: ['A', 'MISSING'] } });
    const d = scoreSourceTraceability({ facts: [makeFact({ id: 'A' }), derived], claimMappings: [{ claim: 'x', status: 'derived', factId: 'D' }] });
    expect(d.score).toBe(0);
    const ok = scoreSourceTraceability({
      facts: [makeFact({ id: 'A' }), makeFact({ id: 'D', factType: 'derived', derivation: { formula: 'A*2', inputFactIds: ['A'] } })],
      claimMappings: [{ claim: 'x', status: 'derived', factId: 'D' }],
    });
    expect(ok.score).toBe(1);
  });

  it('is not applicable without covered claims', () => {
    expect(scoreSourceTraceability({ facts, claimMappings: [{ claim: 'x', status: 'unsupported' }] }).applicable).toBe(false);
  });
});

describe('evaluation: intentMatch', () => {
  const text = 'The widget market in Zorbland depends on supply contracts for buyers.';

  it('scores full keyword and beat coverage as 1', () => {
    const d = scoreIntentMatch({ text, brief: { keywords: ['widget market', 'Zorbland'], beatPoints: ['supply contracts buyers'], angle: 'Zorbland widget market' } });
    expect(d.score).toBe(1);
  });

  it('gives half credit for non-adjacent keyword words and zero for missing', () => {
    const d = scoreIntentMatch({ text, brief: { keywords: ['market widget', 'quantum flux'], beatPoints: [], angle: '' } });
    expect(d.score).toBe(0.25); // (0.5 + 0) / 2
    expect(d.evidence.join('\n')).toMatch(/missing: quantum flux/);
  });

  it('measures beat-point word coverage', () => {
    const d = scoreIntentMatch({ text, brief: { keywords: [], beatPoints: ['supply regulation overview'], angle: '' } });
    expect(d.score).toBeCloseTo(1 / 3, 3);
  });

  it('is not applicable for an empty brief', () => {
    expect(scoreIntentMatch({ text, brief: { keywords: [], beatPoints: [], angle: ' ' } }).applicable).toBe(false);
  });
});

describe('evaluation: originality', () => {
  const text = 'The Zorbland widget market reached twelve billion dollars last year according to the fake report we cite here.';

  it('is 1 minus the highest similarity', () => {
    const d = scoreOriginality({ text, corpus: [text, 'something else entirely different words here'] });
    expect(d.score).toBe(0);
    const partial = scoreOriginality({ text, corpus: ['The Zorbland widget market reached twelve billion dollars and then it shrank by a lot in the next period'] });
    expect(partial.score).toBeGreaterThan(0);
    expect(partial.score).toBeLessThan(1);
  });

  it('is high for unrelated corpus and not applicable when empty', () => {
    expect(scoreOriginality({ text, corpus: ['completely unrelated gadget text from Quuxia about nothing'] }).score).toBe(1);
    expect(scoreOriginality({ text, corpus: [] }).applicable).toBe(false);
  });
});

describe('evaluation: readability', () => {
  it('syllable counter and Flesch are sane', () => {
    expect(countSyllables('cat')).toBe(1);
    expect(countSyllables('market')).toBe(2);
    expect(countSyllables('procurement')).toBeGreaterThanOrEqual(3);
    const easy = fleschReadingEase('The cat sat on the mat. The dog ran to the park. We all had fun.');
    expect(easy!.readingEase).toBeGreaterThan(90);
  });

  it('band scores follow the documented bands', () => {
    expect(readabilityBandScore(55)).toBe(1);
    expect(readabilityBandScore(47)).toBeCloseTo(5 / 7);
    expect(readabilityBandScore(68)).toBeCloseTo(3 / 7);
    expect(readabilityBandScore(95)).toBeCloseTo(1 / 7);
    expect(readabilityBandScore(10)).toBeCloseTo(1 / 7);
  });

  it('rates very easy text below the senior B2B band', () => {
    const d = scoreReadability({ text: 'The cat sat on the mat. The dog ran to the park. We all had fun. It was a good day for us all to play.' });
    expect(d.score).toBeCloseTo(1 / 7);
  });

  it('is not applicable for very short text', () => {
    expect(scoreReadability({ text: 'Too short.' }).applicable).toBe(false);
  });
});

describe('evaluation: structure', () => {
  it('is not applicable for non-blog platforms', () => {
    expect(scoreStructure({ text: readFixture('article.md'), platform: 'linkedin' }).applicable).toBe(false);
  });

  it('scores a well structured markdown article high', () => {
    const d = scoreStructure({ text: readFixture('article.md'), platform: 'blog' });
    expect(d.applicable).toBe(true);
    expect(d.score).toBeGreaterThanOrEqual(0.7);
    expect(d.evidence.join('\n')).toMatch(/answerFirst: 1/);
    expect(d.evidence.join('\n')).toMatch(/hierarchy: 1/);
  });

  it('flags heading skips, no H2, no lists, long answers', () => {
    const bad = '# Title\n\n#### Skipped\n\nShort text.\n\n## Why is it so?\n\n' + 'word '.repeat(80) + '\n';
    const d = scoreStructure({ text: bad, platform: 'blog' });
    expect(d.score).toBeLessThan(0.5);
    const ev = d.evidence.join('\n');
    expect(ev).toMatch(/hierarchy: 0/);
    expect(ev).toMatch(/listsOrTables: 0/);
    expect(ev).toMatch(/answerFirst: 0/);
  });

  it('parses HTML structure when given', () => {
    const s = parseStructure('', readFixture('page.html'));
    expect(s.h1Count).toBe(1);
    expect(s.listItemCount).toBe(3);
    expect(s.headings.map((h) => h.level)).toEqual([1, 2, 3]);
    expect(hierarchySkips(parseStructure('', readFixture('bad-page.html')).headings).length).toBe(1);
  });
});

describe('evaluation: technical', () => {
  it('is not applicable without html', () => {
    expect(scoreTechnical({}).applicable).toBe(false);
    expect(scoreTechnical({ html: '  ' }).applicable).toBe(false);
  });

  it('passes a complete page', () => {
    const d = scoreTechnical({ html: readFixture('page.html') });
    expect(d.score).toBe(1);
  });

  it('fails every check on the bad page', () => {
    const d = scoreTechnical({ html: readFixture('bad-page.html') });
    expect(d.score).toBe(0);
    const ev = d.evidence.join('\n');
    expect(ev).toMatch(/title: FAIL/);
    expect(ev).toMatch(/metaDescription: FAIL/);
    expect(ev).toMatch(/canonical: FAIL/);
    expect(ev).toMatch(/headingHierarchy: FAIL/);
    expect(ev).toMatch(/jsonLd: FAIL/);
    expect(ev).toMatch(/robotsIndexable: FAIL/);
    expect(ev).toMatch(/blocks AI use/);
  });

  it('technical dimension appears in scoreContent only with html', async () => {
    const { scoreContent } = await import('../../src/evaluation/index.js');
    const without = scoreContent(baseInput());
    const withHtml = scoreContent(baseInput({ html: readFixture('page.html') }));
    expect(without.dimensions.find((d) => d.name === 'technical')!.applicable).toBe(false);
    expect(withHtml.dimensions.find((d) => d.name === 'technical')!.applicable).toBe(true);
  });
});
