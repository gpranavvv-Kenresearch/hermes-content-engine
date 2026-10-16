import type { Campaign } from '../schemas/index.js';

/**
 * Campaign-level SEO strategy. Each campaign owns its goal, keyword cluster,
 * search intent and persona pool. Add campaigns here; loadConfig() verifies the
 * referenced personas and platforms exist.
 */
export const campaigns: Campaign[] = [
  {
    id: 'authority-insights',
    name: 'Authority insights',
    goal: 'Build Ken Research authority with senior B2B readers and drive qualified visits to report pages.',
    platforms: ['x', 'facebook', 'linkedin', 'blog'],
    keywordCluster: [],
    searchIntent: 'informational',
    evergreen: false,
    seoStrategy:
      'Lead with one verified headline fact, state period and geography, link to the Ken Research report page.',
    personaIds: ['cxo', 'pe-vc', 'strategy-head'],
    active: true,
  },
  {
    id: 'evergreen-pillars',
    name: 'Evergreen pillars',
    goal: 'Publish durable, intent-matched pillar content that stays useful as data updates.',
    platforms: ['blog', 'linkedin'],
    keywordCluster: [],
    searchIntent: 'informational',
    evergreen: true,
    seoStrategy:
      'Pillar structure with definitions, segmentation, drivers and constraints; refresh figures from verified facts.',
    personaIds: ['strategy-head', 'pe-vc'],
    active: true,
  },
];
