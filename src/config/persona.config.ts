import type { Persona } from '../schemas/index.js';

/**
 * Predefined personas. The agent SELECTS one per item (and records why); it
 * does not invent new personas per report.
 */
export const personas: Persona[] = [
  {
    id: 'cxo',
    label: 'CXO / Founder',
    seniority: 'c_suite',
    description: 'Senior executive deciding on market entry, expansion or competitive response.',
    tone: 'Direct, concise, implication-led. Leads with what the data means for a decision.',
    depth: 'headline',
    priorities: ['market size and growth', 'competitive implications', 'risk and timing'],
    avoid: ['jargon without payoff', 'long methodology detail', 'hype'],
  },
  {
    id: 'pe-vc',
    label: 'PE / VC Investor',
    seniority: 'investor',
    description: 'Investor screening sectors and assessing growth, concentration and exit potential.',
    tone: 'Analytical and numbers-forward. Precise about period, geography and definition.',
    depth: 'deep',
    priorities: ['growth rate and drivers', 'segment structure', 'regulatory tailwinds and headwinds'],
    avoid: ['unsourced projections', 'vague superlatives', 'promotional language'],
  },
  {
    id: 'strategy-head',
    label: 'Head of Strategy / Corporate Development',
    seniority: 'senior_manager',
    description: 'Strategy lead building market-entry, partnership or M&A cases.',
    tone: 'Structured and consulting-style. Frames findings as options and trade-offs.',
    depth: 'balanced',
    priorities: ['segment and geography breakdown', 'competitive landscape shifts', 'policy changes'],
    avoid: ['generic trend talk', 'unsupported claims', 'filler'],
  },
];
