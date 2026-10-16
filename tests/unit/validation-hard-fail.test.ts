import { describe, expect, it } from 'vitest';
import {
  checkBannedCharacter,
  checkCompetitorMention,
  checkOverHardLimit,
  checkPlaceholder,
  checkSourceLink,
  checkTitle,
  checkUtm,
} from '../../src/validation/checks/hard-fail.js';
import {
  checkDegenerate,
  checkPromptEcho,
  checkReasoningLeak,
  checkRefusal,
  checkSafetyClassifierLeak,
} from '../../src/validation/checks/model-artifacts.js';
import { codesOf, utmLink, BASE_URL } from '../fixtures/validation/helpers.js';

describe('COMPETITOR_MENTION', () => {
  it('flags a competitor by name and by domain', () => {
    expect(codesOf(checkCompetitorMention, 'Per Mordor Intelligence the market grows')).toEqual(['COMPETITOR_MENTION']);
    expect(codesOf(checkCompetitorMention, 'see https://www.imarcgroup.com/x')).toEqual(['COMPETITOR_MENTION']);
  });
  it('does not flag clean Ken Research text', () => {
    expect(codesOf(checkCompetitorMention, `Ken Research finds growth. ${utmLink('x')}`)).toEqual([]);
  });
});

describe('BANNED_CHARACTER', () => {
  it('flags em and en dashes', () => {
    expect(codesOf(checkBannedCharacter, 'growth — fast')).toEqual(['BANNED_CHARACTER']);
    expect(codesOf(checkBannedCharacter, '2025–2030')).toEqual(['BANNED_CHARACTER']);
  });
  it('allows hyphens and minus signs', () => {
    expect(codesOf(checkBannedCharacter, 'multi-year, 2025-2030, -3% change')).toEqual([]);
  });
});

describe('OVER_HARD_LIMIT', () => {
  it('flags a facebook post over 2280 characters', () => {
    expect(codesOf(checkOverHardLimit, 'a'.repeat(2281), 'facebook')).toEqual(['OVER_HARD_LIMIT']);
  });
  it('allows exactly 2280 on facebook and linkedin', () => {
    expect(codesOf(checkOverHardLimit, 'a'.repeat(2280), 'facebook')).toEqual([]);
    expect(codesOf(checkOverHardLimit, 'a'.repeat(2280), 'linkedin')).toEqual([]);
    expect(codesOf(checkOverHardLimit, 'a'.repeat(2281), 'linkedin')).toEqual(['OVER_HARD_LIMIT']);
  });
  it('counts a URL as 23 on X', () => {
    const url = utmLink('x'); // far longer than 23 literally
    expect(url.length).toBeGreaterThan(100);
    const fits = 'a'.repeat(280 - 23 - 1) + ' ' + url; // payload 280
    expect(codesOf(checkOverHardLimit, fits, 'x')).toEqual([]);
    expect(codesOf(checkOverHardLimit, 'b' + fits, 'x')).toEqual(['OVER_HARD_LIMIT']);
  });
  it('does nothing for a platform with no hard cap', () => {
    expect(codesOf(checkOverHardLimit, 'a'.repeat(50_000), 'blog')).toEqual([]);
  });
});

describe('MISSING_SOURCE_LINK', () => {
  it('flags text with no Ken Research link, even if another link exists', () => {
    expect(codesOf(checkSourceLink, 'no link here')).toEqual(['MISSING_SOURCE_LINK']);
    expect(codesOf(checkSourceLink, 'see https://www.example.org/report')).toEqual(['MISSING_SOURCE_LINK']);
  });
  it('accepts a Ken Research link (with or without www)', () => {
    expect(codesOf(checkSourceLink, `see ${utmLink('x')}`)).toEqual([]);
    expect(codesOf(checkSourceLink, 'see https://kenresearch.com/a')).toEqual([]);
  });
});

describe('UTM codes', () => {
  it('MISSING_UTM', () => {
    expect(codesOf(checkUtm, `see ${BASE_URL}`)).toEqual(['MISSING_UTM']);
  });
  it('DUPLICATE_UTM', () => {
    expect(codesOf(checkUtm, `see ${BASE_URL}?utm_source=x&utm_source=x&utm_medium=referral&utm_campaign=automation`)).toEqual(['DUPLICATE_UTM']);
  });
  it('WRONG_UTM', () => {
    expect(codesOf(checkUtm, `see ${BASE_URL}?utm_source=facebook&utm_medium=referral&utm_campaign=automation`, 'x')).toEqual(['WRONG_UTM']);
  });
  it('accepts the exact approved UTM and ignores non-Ken links', () => {
    expect(codesOf(checkUtm, `see ${utmLink('x')} and https://www.example.org/a`)).toEqual([]);
  });
});

describe('PLACEHOLDER', () => {
  it.each([
    '[DATA NEEDED]',
    '[Market size NEEDED]',
    '[Insert company name]',
    '{{market_name}}',
    'TODO fix this',
    'value is TBD',
    'Lorem ipsum dolor sit amet',
    'XXX',
    '[figure omitted]',
  ])('flags %s', (snippet) => {
    expect(codesOf(checkPlaceholder, `Ken Research finds ${snippet} here.`)).toEqual(['PLACEHOLDER']);
  });
  it('does not flag ordinary words that merely contain the letters', () => {
    expect(codesOf(checkPlaceholder, 'The todo list, the tbd-free plan, Xxl sizes, and [1] a footnote.')).toEqual([]);
    expect(codesOf(checkPlaceholder, 'Insert molding is a process. Needed capacity rose.')).toEqual([]);
  });
});

describe('MISSING_TITLE', () => {
  it('flags a blog without a title line', () => {
    expect(codesOf(checkTitle, 'Plain opening paragraph.\n\nMore.', 'blog')).toEqual(['MISSING_TITLE']);
    expect(codesOf(checkTitle, '## Subheading only\n\ntext', 'blog')).toEqual(['MISSING_TITLE']);
  });
  it('accepts an H1 or a Title: line', () => {
    expect(codesOf(checkTitle, '\n# A Title\n\ntext', 'blog')).toEqual([]);
    expect(codesOf(checkTitle, 'Title: A Title\n\ntext', 'blog')).toEqual([]);
  });
  it('is not required on social platforms', () => {
    expect(codesOf(checkTitle, 'no title', 'x')).toEqual([]);
  });
});

describe('REFUSAL', () => {
  it.each([
    "I'm sorry, but I can't help with that.",
    'I cannot write this without data.',
    "Unfortunately, I am unable to produce this.",
    'As an AI language model, I do not have access to reports.',
    'Please provide the Ken Research report first.',
    'This request would require me to invent figures.',
  ])('flags %s', (text) => {
    expect(codesOf(checkRefusal, text)).toEqual(['REFUSAL']);
  });
  it('does not treat a SHORT genuine post as a refusal (legacy length<100 rule dropped)', () => {
    expect(codesOf(checkRefusal, 'Ken Research finds widget demand rising.')).toEqual([]);
  });
  it('does not flag "Unfortunately" analysis or a mid-post "please share" CTA', () => {
    expect(codesOf(checkRefusal, 'Unfortunately for importers, certification costs are rising. Please share this with your team.')).toEqual([]);
    expect(codesOf(checkRefusal, 'Buyers cannot complete the tender process quickly in some provinces.')).toEqual([]);
  });
});

describe('DEGENERATE_OUTPUT', () => {
  it('flags special-token junk, empty output and word loops', () => {
    expect(codesOf(checkDegenerate, '<pad><pad><pad><pad><pad><pad>')).toEqual(['DEGENERATE_OUTPUT']);
    expect(codesOf(checkDegenerate, '   ')).toEqual(['DEGENERATE_OUTPUT']);
    expect(codesOf(checkDegenerate, 'growth growth growth growth growth growth growth growth growth growth')).toEqual(['DEGENERATE_OUTPUT']);
    expect(codesOf(checkDegenerate, Array(8).fill('same line again').join('\n'))).toEqual(['DEGENERATE_OUTPUT']);
  });
  it('accepts normal prose, including legitimately repeated short words', () => {
    expect(codesOf(checkDegenerate, 'Ken Research finds that the that the market is shifting toward local assembly.')).toEqual([]);
    expect(codesOf(checkDegenerate, 'Demand is rising in the north. Supply is rising in the south.')).toEqual([]);
  });
});

describe('REASONING_LEAK', () => {
  it.each([
    'We need to produce a post about widgets.',
    "Let's analyze the request first.",
    '<think>hmm</think> Ken Research finds growth.',
    'The user wants a LinkedIn post.',
    'Draft here. Note: keep it short. Actually, maybe shorter.',
  ])('flags %s', (text) => {
    expect(codesOf(checkReasoningLeak, text)).toEqual(['REASONING_LEAK']);
  });
  it('does not flag a post that starts with "First" (legacy false positive)', () => {
    expect(codesOf(checkReasoningLeak, 'First, the market is consolidating around three hubs.')).toEqual([]);
    expect(codesOf(checkReasoningLeak, 'Users want service coverage; user surveys confirm this. Note: figures are indicative.')).toEqual([]);
  });
});

describe('PROMPT_ECHO', () => {
  it.each([
    'STRICT RULES: be brief.',
    'You are a professional B2B content writer. Write a post.',
    'Output only the final text.',
    '<<<CE_OUTPUT>>>\nFACT_IDS: none',
    'HARD LIMIT 280 characters.',
    'STEP 1: read the facts',
  ])('flags %s', (text) => {
    expect(codesOf(checkPromptEcho, text)).toEqual(['PROMPT_ECHO']);
  });
  it('does not flag ordinary headings or sentences', () => {
    expect(codesOf(checkPromptEcho, 'KEY TAKEAWAYS:\n- Costs rise.\nYou are likely to see consolidation. Step changes in tenders matter.')).toEqual([]);
  });
});

describe('SAFETY_CLASSIFIER_LEAK', () => {
  it.each(['User Safety: safe', 'unsafe', 'safe.', 'S1 unsafe', 'Content policy violation', 'Category: S4'])('flags %s', (text) => {
    expect(codesOf(checkSafetyClassifierLeak, text)).toEqual(['SAFETY_CLASSIFIER_LEAK']);
  });
  it('does not flag real text that uses the word safe', () => {
    expect(codesOf(checkSafetyClassifierLeak, 'Certification keeps widgets safe for operators, and unsafe imports are blocked.')).toEqual([]);
  });
});
