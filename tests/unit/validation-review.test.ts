import { describe, expect, it } from 'vitest';
import {
  checkAiTell,
  checkBannedPhrase,
  checkBannedPromoWord,
  checkGenericPromotional,
  checkHashtagCount,
  checkLowSentenceVariance,
  checkReadability,
  checkRepetitivePhrasing,
  checkSuspiciouslyShort,
  checkTargetBand,
  checkTone,
  checkWeakEvidenceWording,
} from '../../src/validation/checks/review.js';
import { countSyllables, textStats } from '../../src/validation/text-stats.js';
import { codesOf } from '../fixtures/validation/helpers.js';

describe('target band', () => {
  it('flags below and above the band', () => {
    expect(codesOf(checkTargetBand, 'a'.repeat(700), 'facebook')).toEqual(['BELOW_TARGET_BAND']);
    expect(codesOf(checkTargetBand, 'a'.repeat(2250), 'facebook')).toEqual(['ABOVE_TARGET_BAND']);
  });
  it('accepts text inside the band, and platforms without a band', () => {
    expect(codesOf(checkTargetBand, 'a'.repeat(1300), 'linkedin')).toEqual([]);
    expect(codesOf(checkTargetBand, 'a'.repeat(5000), 'blog')).toEqual([]);
  });
  it('uses the platform URL accounting (X: URL = 23)', () => {
    const text = 'a'.repeat(200) + ' https://www.kenresearch.com/' + 'p'.repeat(100);
    expect(codesOf(checkTargetBand, text, 'x')).toEqual([]); // 200 + 1 + 23 = 224 <= 256
  });
});

describe('SUSPICIOUSLY_SHORT (replaces the legacy length<100 refusal rule)', () => {
  it('flags a very short LinkedIn post and ignores URLs/hashtags in the count', () => {
    expect(codesOf(checkSuspiciouslyShort, 'Widgets are rising. https://www.kenresearch.com/a #Widgets', 'linkedin')).toEqual(['SUSPICIOUSLY_SHORT']);
  });
  it('accepts a normal short X post and a long LinkedIn post', () => {
    expect(codesOf(checkSuspiciouslyShort, 'Ken Research finds widget demand rising in Examplestan.', 'x')).toEqual([]);
    expect(codesOf(checkSuspiciouslyShort, 'Widgets rise. '.repeat(40), 'linkedin')).toEqual([]);
  });
});

describe('HASHTAG_COUNT', () => {
  it('flags too many and too few', () => {
    expect(codesOf(checkHashtagCount, 'text #a #b #c #d #e', 'x')).toEqual(['HASHTAG_COUNT']);
    expect(codesOf(checkHashtagCount, 'text with none', 'x')).toEqual(['HASHTAG_COUNT']);
  });
  it('accepts a count inside the range, and ignores "#1" style ranks and URL fragments', () => {
    expect(codesOf(checkHashtagCount, 'the #1 vendor #Widgets https://x.org/a#section', 'x')).toEqual([]);
  });
  it('flags hashtags on a blog (range 0..0)', () => {
    expect(codesOf(checkHashtagCount, '# Title\n\nbody #oops', 'blog')).toEqual(['HASHTAG_COUNT']);
    expect(codesOf(checkHashtagCount, '# Title\n\nbody', 'blog')).toEqual([]);
  });
});

describe('BANNED_PHRASE / BANNED_PROMO_WORD', () => {
  it('flags brand-banned phrases, including curly apostrophes', () => {
    expect(codesOf(checkBannedPhrase, 'The market is projected to reach new highs.')).toEqual(['BANNED_PHRASE']);
    expect(codesOf(checkBannedPhrase, 'It’s important to note the risks.')).toEqual(['BANNED_PHRASE']);
  });
  it('does not flag near-miss wording', () => {
    expect(codesOf(checkBannedPhrase, 'Analysts expect the market to reach new highs.')).toEqual([]);
  });
  it('flags hype words as whole words only', () => {
    expect(codesOf(checkBannedPromoWord, 'A booming, revolutionary segment.')).toEqual(['BANNED_PROMO_WORD']);
    expect(codesOf(checkBannedPromoWord, 'The boom was massively overstated and the segment is unstoppably dull.')).toEqual([]);
  });
});

describe('AI_TELL', () => {
  it('flags curated tells beyond the brand list', () => {
    expect(codesOf(checkAiTell, "In today's fast-paced market, buyers adapt.")).toEqual(['AI_TELL']);
    expect(codesOf(checkAiTell, "It's worth noting that costs rose.")).toEqual(['AI_TELL']);
    expect(codesOf(checkAiTell, 'The report will delve deeper into hubs.')).toEqual(['AI_TELL']);
    expect(codesOf(checkAiTell, 'A tapestry of suppliers.')).toEqual(['AI_TELL']);
  });
  it('does not flag lookalike words or competitor-like tokens', () => {
    expect(codesOf(checkAiTell, 'Delivery of the plan arrived. Tapas bars and a delvelike name.')).toEqual([]);
    expect(codesOf(checkAiTell, 'The pipeline moved quickly and the teams adapted in a fast market.')).toEqual([]);
  });
  it('does not double-report phrases already covered by BANNED_PHRASE', () => {
    expect(codesOf(checkAiTell, 'We will delve into the numbers.')).toEqual([]);
  });
});

describe('REPETITIVE_PHRASING', () => {
  it('flags a repeated 4-gram', () => {
    const t = 'Costs rise in the north region. Margins fall in the north region. Demand holds in the north region.';
    expect(codesOf(checkRepetitivePhrasing, t)).toEqual(['REPETITIVE_PHRASING']);
  });
  it('flags repeated sentence openers', () => {
    const t = 'Buyers want service. Buyers want price clarity. Buyers want financing. Importers face rules. Makers add capacity.';
    expect(codesOf(checkRepetitivePhrasing, t)).toEqual(['REPETITIVE_PHRASING']);
  });
  it('does not flag varied text or repeated Ken Research attribution openers', () => {
    const t = 'Ken Research finds costs rising. Ken Research reports margins falling. Ken Research identifies new hubs. Buyers wait. Importers adapt.';
    expect(codesOf(checkRepetitivePhrasing, t)).toEqual([]);
  });
});

describe('WEAK_EVIDENCE_WORDING', () => {
  it('flags vague attribution with no source', () => {
    expect(codesOf(checkWeakEvidenceWording, 'Studies show that demand is rising.')).toEqual(['WEAK_EVIDENCE_WORDING']);
    expect(codesOf(checkWeakEvidenceWording, 'Experts say prices will fall. Many believe so.')).toEqual(['WEAK_EVIDENCE_WORDING']);
  });
  it('allows the same wording when the sentence names Ken Research or links a source', () => {
    expect(codesOf(checkWeakEvidenceWording, 'Ken Research studies show that demand is rising.')).toEqual([]);
    expect(codesOf(checkWeakEvidenceWording, 'Studies show demand is rising (https://www.kenresearch.com/a).')).toEqual([]);
  });
  it('does not flag unrelated uses of the words', () => {
    expect(codesOf(checkWeakEvidenceWording, 'The data shows a 4% rise. Experts were consulted by Ken Research.')).toEqual([]);
  });
});

describe('GENERIC_PROMOTIONAL', () => {
  it('flags sales boilerplate', () => {
    expect(codesOf(checkGenericPromotional, 'Our world-class, cutting-edge solution. Act now!')).toEqual(['GENERIC_PROMOTIONAL']);
  });
  it('does not flag analytical wording', () => {
    expect(codesOf(checkGenericPromotional, 'Class A suppliers and edge cases in testing; the limited supply persists.')).toEqual([]);
  });
});

describe('READABILITY and sentence statistics', () => {
  const dense =
    'Notwithstanding considerable macroeconomic heterogeneity, institutional stakeholders increasingly operationalize comprehensive methodological frameworks incorporating multidimensional regulatory considerations, thereby necessitating substantially differentiated capitalization strategies across jurisdictional boundaries. ' +
    'Consequently, contemporary organizational decision architectures demonstrate pronounced susceptibility toward environmental volatility and administrative fragmentation, notwithstanding persistent informational asymmetries.';
  const choppy = 'Costs rose. Demand fell. Buyers wait. Makers adapt. Rules tighten. Prices drift. Hubs grow. Trade shifts. Credit tightens. Stock builds. Orders slow. Margins thin. Plans change. Fees climb. Risk grows. Cash tightens. Banks pause. Deals stall. Hubs idle. Trucks wait. Ports queue. Rates jump. Stocks dip. Staff leave.';
  const good =
    'Ken Research finds that distributors in Examplestan now sign multi-year supply contracts rather than buying shipment by shipment. ' +
    'Industrial buyers weigh service coverage more heavily than price, and financing remains the main limit on fleet replacement. ' +
    'Regulation is tightening around certification, which raises entry costs for small importers and favours firms with local content.';

  it('flags dense text as too dense and choppy text as too choppy', () => {
    expect(codesOf(checkReadability, dense, 'blog')).toEqual(['READABILITY']);
    expect(codesOf(checkReadability, choppy, 'blog')).toEqual(['READABILITY']);
  });
  it('accepts senior B2B prose, and skips very short text', () => {
    expect(codesOf(checkReadability, good, 'blog')).toEqual([]);
    expect(codesOf(checkReadability, 'Short post only.', 'x')).toEqual([]);
  });
  it('computes plausible statistics', () => {
    expect(countSyllables('market')).toBe(2);
    expect(countSyllables('the')).toBe(1);
    const s = textStats(good);
    expect(s.sentences).toBe(3);
    expect(s.words).toBeGreaterThan(40);
  });
});

describe('LOW_SENTENCE_VARIANCE', () => {
  it('flags uniformly sized sentences', () => {
    const t = Array(7).fill(0).map((_, i) => `Buyers in hub ${i} pay for the same service level.`).join(' ');
    expect(codesOf(checkLowSentenceVariance, t)).toEqual(['LOW_SENTENCE_VARIANCE']);
  });
  it('accepts varied sentences and short texts', () => {
    const t =
      'Costs rise. Importers in the coastal provinces face certification rules that have been tightened twice since the last review cycle ended. Margins thin. Distributors respond by signing longer supply contracts with a smaller set of makers. Buyers wait. The inland hubs, by contrast, still depend on informal channels for most of their volume and will adapt more slowly.';
    expect(codesOf(checkLowSentenceVariance, t)).toEqual([]);
    expect(codesOf(checkLowSentenceVariance, 'One. Two. Three.')).toEqual([]);
  });
});

describe('TONE', () => {
  it('flags exclamation marks, emoji and we/our', () => {
    expect(codesOf(checkTone, 'Big news!')).toEqual(['TONE']);
    expect(codesOf(checkTone, 'Growth is here \u{1F680}')).toEqual(['TONE']);
    expect(codesOf(checkTone, 'We analysed the market and our view is firm.')).toEqual(['TONE']);
  });
  it('ignores URL bangs, trademark symbols, quoted speech and the word "us" or "weekly"', () => {
    expect(codesOf(checkTone, 'Report © 2026 and brand™. The CEO said "we will expand". Weekly US data. https://x.org/a!b')).toEqual([]);
  });
});
