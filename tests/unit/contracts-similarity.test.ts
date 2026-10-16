import { describe, expect, it } from 'vitest';
import { OUTPUT_BEGIN, OUTPUT_END, TEXT_MARKER, outputFormatInstruction, parseModelOutput } from '../../src/contracts.js';
import { jaccard, mostSimilar, shingles, textSimilarity } from '../../src/utils/similarity.js';

describe('parseModelOutput', () => {
  const good = `${OUTPUT_BEGIN}\nFACT_IDS: f1, f2\n${TEXT_MARKER}\nLine one.\n\nLine two.\n${OUTPUT_END}`;

  it('parses a well-formed reply, keeping blank lines inside the text', () => {
    const r = parseModelOutput(good);
    expect(r).toEqual({ ok: true, output: { factIds: ['f1', 'f2'], text: 'Line one.\n\nLine two.' } });
  });

  it('treats "none" and a missing FACT_IDS line as no facts', () => {
    expect(parseModelOutput(`${OUTPUT_BEGIN}\nFACT_IDS: none\n${TEXT_MARKER}\nHi\n${OUTPUT_END}`)).toMatchObject({ ok: true, output: { factIds: [] } });
    expect(parseModelOutput(`${OUTPUT_BEGIN}\n${TEXT_MARKER}\nHi\n${OUTPUT_END}`)).toMatchObject({ ok: true, output: { factIds: [] } });
  });

  it('ignores an echoed copy of the instructions that came before the real reply', () => {
    const echoed = `${outputFormatInstruction()}\n\nSure!\n${good}`;
    expect(parseModelOutput(echoed)).toMatchObject({ ok: true, output: { text: 'Line one.\n\nLine two.' } });
  });

  it('detects truncation (no end marker) and other malformed replies', () => {
    expect(parseModelOutput(`${OUTPUT_BEGIN}\nFACT_IDS: f1\n${TEXT_MARKER}\nCut off mid`)).toEqual({ ok: false, reason: 'missing_end' });
    expect(parseModelOutput('just prose')).toEqual({ ok: false, reason: 'missing_begin' });
    expect(parseModelOutput(`${OUTPUT_BEGIN}\nFACT_IDS: f1\n${OUTPUT_END}`)).toEqual({ ok: false, reason: 'missing_text' });
    expect(parseModelOutput(`${OUTPUT_BEGIN}\n${TEXT_MARKER}\n   \n${OUTPUT_END}`)).toEqual({ ok: false, reason: 'empty_text' });
  });
});

describe('similarity', () => {
  it('scores identical text as 1 and unrelated text near 0', () => {
    expect(textSimilarity('the quick brown fox jumps', 'the quick brown fox jumps')).toBe(1);
    expect(textSimilarity('the quick brown fox jumps over', 'completely different words appear here today')).toBeLessThan(0.1);
  });

  it('ignores URLs, hashtags and punctuation', () => {
    const a = 'Logistics demand is shifting. https://kenresearch.com/a #Logistics';
    const b = 'Logistics demand is shifting! https://kenresearch.com/b #Cargo';
    expect(textSimilarity(a, b)).toBe(1);
  });

  it('handles short and empty text', () => {
    expect(shingles('', 3).size).toBe(0);
    expect(shingles('two words', 3).size).toBe(1);
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it('finds the closest candidate', () => {
    const r = mostSimilar('cold chain demand is rising fast in brazil', [
      'banking regulation changes in europe this year',
      'cold chain demand is rising fast in brazil today',
    ]);
    expect(r.index).toBe(1);
    expect(r.score).toBeGreaterThan(0.5);
  });
});
