import { describe, expect, it } from 'vitest';
import { competitors } from '../../src/config/competitors.config.js';
import { buildCompetitorDetector } from '../../src/validation/competitors.js';
import { countHashtags, extractUrls, payloadLength } from '../../src/utils/text.js';
import { platformLimits } from '../../src/config/platform-limits.config.js';

const detector = buildCompetitorDetector(competitors);

describe('competitor detector', () => {
  it.each([
    ['According to IMARC Group the market grows', 'IMARC Group'],
    ['mordor intelligence says so', 'Mordor Intelligence'],
    ['Per Markets & Markets analysis', 'MarketsandMarkets'],
    ['MarketsandMarkets reports', 'MarketsandMarkets'],
    ["Statista's data", 'Statista'],
    ['see https://www.grandviewresearch.com/industry-analysis/x', 'Grand View Research'],
    ['numbers from market.us show', 'Market.us'],
    ['6WResearch estimates', '6Wresearch'],
  ])('finds a competitor in "%s"', (text, expected) => {
    expect(detector.find(text).map((m) => m.competitor)).toContain(expected);
  });

  it('does not flag clean Ken Research text', () => {
    const text = 'Ken Research finds that the Brazil logistics market is shifting toward cold chain. https://www.kenresearch.com/x';
    expect(detector.find(text)).toEqual([]);
  });

  it('does not match inside a longer word', () => {
    expect(detector.find('The immarcated boundary')).toEqual([]);
  });
});

describe('text utilities', () => {
  it('extracts URLs without trailing punctuation', () => {
    expect(extractUrls('Go https://kenresearch.com/a, then https://x.com/b.')).toEqual(['https://kenresearch.com/a', 'https://x.com/b']);
  });

  it('counts hashtags', () => {
    expect(countHashtags('Text #One #Two\n#Three and a#notTag')).toBe(3);
  });

  it('counts every URL as 23 chars on X', () => {
    const url = 'https://www.kenresearch.com/some/very/long/report/path/that/is/long?utm_source=x';
    const text = `Hello ${url}`;
    expect(payloadLength(text, platformLimits.x)).toBe('Hello '.length + 23);
  });

  it('uses literal UTF-16 length on platforms without URL normalization', () => {
    expect(payloadLength('abc', platformLimits.facebook)).toBe(3);
    // unicode bold letters are surrogate pairs and count as 2, the stricter measure
    expect(payloadLength('\u{1D5D4}', platformLimits.facebook)).toBe(2);
  });
});
