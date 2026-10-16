import { describe, expect, it } from 'vitest';
import { OUTPUT_BEGIN, OUTPUT_END, TEXT_MARKER, parseModelOutputLenient, salvagePlainText } from '../../src/contracts.js';

describe('salvagePlainText', () => {
  it.each([
    ['Plain post text.', 'Plain post text.'],
    ["Sure! Here's the post:\n\nThe market is shifting.", 'The market is shifting.'],
    ['Revised post:\nThe market is shifting.', 'The market is shifting.'],
    ['Updated version:\n\nThe market is shifting.', 'The market is shifting.'],
    ['Key takeaways:\n- demand is shifting', 'Key takeaways:\n- demand is shifting'],
    ['```\nThe market is shifting.\n```', 'The market is shifting.'],
    ['Tweet: The market is shifting.', 'The market is shifting.'],
    ['"The market is shifting."', 'The market is shifting.'],
    [`${TEXT_MARKER}\nThe market is shifting.`, 'The market is shifting.'],
  ])('cleans %j', (raw, expected) => {
    expect(salvagePlainText(raw)).toBe(expected);
  });

  it('keeps a real first sentence that merely starts with "Sure"', () => {
    expect(salvagePlainText('Sure to rise, demand is shifting.')).toBe('Sure to rise, demand is shifting.');
  });

  it('does not strip quotes that are part of a longer quoted passage', () => {
    expect(salvagePlainText('He said "yes" and "no".')).toBe('He said "yes" and "no".');
  });

  it('returns null for empty or marker-only text', () => {
    expect(salvagePlainText('   ')).toBeNull();
    expect(salvagePlainText(`${OUTPUT_BEGIN}\n${OUTPUT_END}`)).toBeNull();
  });
});

describe('parseModelOutputLenient', () => {
  it('parses a well-formed reply exactly like the strict parser (not marked salvaged)', () => {
    const raw = `${OUTPUT_BEGIN}\nFACT_IDS: F1\n${TEXT_MARKER}\nThe post.\n${OUTPUT_END}`;
    expect(parseModelOutputLenient(raw)).toEqual({ ok: true, output: { factIds: ['F1'], text: 'The post.' } });
  });

  it('salvages a reply that ignored the format and marks it salvaged', () => {
    expect(parseModelOutputLenient("Here is the post:\nThe market is shifting.")).toEqual({
      ok: true,
      output: { factIds: [], text: 'The market is shifting.', salvaged: true },
    });
  });

  it('salvages a reply with markers but no text marker', () => {
    const raw = `${OUTPUT_BEGIN}\nThe market is shifting.\n${OUTPUT_END}`;
    expect(parseModelOutputLenient(raw)).toMatchObject({ ok: true, output: { text: 'The market is shifting.', salvaged: true } });
  });

  it('still rejects a truncated reply (format started, never ended)', () => {
    expect(parseModelOutputLenient(`${OUTPUT_BEGIN}\nFACT_IDS: F1\n${TEXT_MARKER}\nCut off mid`)).toEqual({ ok: false, reason: 'missing_end' });
  });

  it('fails on an empty reply', () => {
    expect(parseModelOutputLenient('   ')).toEqual({ ok: false, reason: 'empty_text' });
  });
});
