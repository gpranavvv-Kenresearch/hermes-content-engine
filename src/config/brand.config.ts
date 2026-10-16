import type { BrandConfig } from '../schemas/index.js';

/**
 * Brand voice for Ken Research. Authoritative, analytical, consulting-style.
 * bannedPhrases mixes (a) phrases the legacy prompts already forbade and (b) a
 * SEED list of common AI-tell phrases. The seed list is meant to be curated
 * against vale-ai-tells (Phase 3) after reading its rules, not trusted as-is.
 */
export const brandConfig: BrandConfig = {
  name: 'Ken Research',
  tone: 'authoritative, analytical, factual, consulting-style',
  stance:
    'An independent senior market analyst speaking to senior decision makers. Evidence first, no hype, no filler.',
  audience: [
    'CEOs and founders',
    'Investors (PE/VC)',
    'Heads of strategy and corporate development',
    'Senior managers in market-entry and planning roles',
  ],
  bannedPromoWords: [
    'booming',
    'massive',
    'revolutionary',
    'game-changing',
    'game-changer',
    'unstoppable',
    'skyrocketing',
    'mind-blowing',
  ],
  bannedPhrases: [
    // legacy prompt bans
    'projected to reach',
    'anticipated to grow',
    'value expected to reach',
    'driving innovation',
    'growing demand for',
    // seed AI-tell phrases (to be curated)
    'in today\'s rapidly evolving landscape',
    'in the ever-evolving',
    'it is important to note',
    'it\'s important to note',
    'delve into',
    'navigate the complexities',
    'a testament to',
    'rich tapestry',
    'unlock the potential',
    'in conclusion,',
  ],
  bannedCharacters: ['—', '–'], // em dash, en dash
  attributionPhrases: [
    'Ken Research finds',
    'Ken Research identifies',
    'Ken Research reports',
    'According to Ken Research',
    'Ken Research analysis shows',
  ],
};
