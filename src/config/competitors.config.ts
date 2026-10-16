import type { CompetitorEntry } from '../schemas/index.js';

/**
 * The ONE competitor list. Replaces ~8 diverging copies in the legacy prompts
 * plus the separate COMPETITOR_DOMAINS list. These are market-research firms
 * that must never be cited, quoted, linked or even fetched.
 *
 * Seeded from the legacy domain list and prompt text, plus a few well-known
 * peers. Extend freely; loadConfig() rejects duplicate aliases/domains.
 */
export const competitors: CompetitorEntry[] = [
  { name: 'Mordor Intelligence', aliases: ['mordor intelligence', 'mordor'], literals: [], domains: ['mordorintelligence.com'] },
  { name: 'IMARC Group', aliases: ['imarc', 'imarc group'], literals: [], domains: ['imarcgroup.com'] },
  { name: 'Precedence Research', aliases: ['precedence research'], literals: [], domains: ['precedenceresearch.com'] },
  { name: 'Future Market Insights', aliases: ['future market insights'], literals: [], domains: ['futuremarketinsights.com'] },
  { name: 'Renub Research', aliases: ['renub', 'renub research'], literals: [], domains: ['renub.com'] },
  { name: 'Market Research Future', aliases: ['market research future'], literals: [], domains: ['marketresearchfuture.com'] },
  {
    name: 'MarketsandMarkets',
    aliases: ['marketsandmarkets', 'markets and markets'],
    literals: [],
    domains: ['marketsandmarkets.com'],
  },
  { name: 'Technavio', aliases: ['technavio'], literals: [], domains: ['technavio.com'] },
  { name: 'Credence Research', aliases: ['credence research'], literals: [], domains: ['credenceresearch.com'] },
  { name: 'Marketsandata', aliases: ['marketsandata'], literals: [], domains: ['marketsandata.com'] },
  { name: 'ChemAnalyst', aliases: ['chemanalyst'], literals: [], domains: ['chemanalyst.com'] },
  { name: 'PS Market Research', aliases: ['ps market research'], literals: [], domains: ['psmarketresearch.com'] },
  { name: 'SkyQuest', aliases: ['skyquest', 'skyquest technology'], literals: [], domains: ['skyquestt.com'] },
  { name: 'DelveInsight', aliases: ['delveinsight', 'delve insight'], literals: [], domains: ['delveinsight.com'] },
  { name: 'Strategic Market Research', aliases: ['strategic market research'], literals: [], domains: ['strategicmarketresearch.com'] },
  { name: 'KBV Research', aliases: ['kbv research'], literals: [], domains: ['kbvresearch.com'] },
  { name: 'IndustryARC', aliases: ['industryarc', 'industry arc'], literals: [], domains: ['industryarc.com'] },
  { name: 'SNS Insider', aliases: ['sns insider'], literals: [], domains: ['snsinsider.com'] },
  { name: 'Market.us', aliases: [], literals: ['market.us'], domains: ['market.us'] },
  { name: 'TechSci Research', aliases: ['techsci research'], literals: [], domains: ['techsciresearch.com'] },
  { name: 'Towards Healthcare', aliases: ['towards healthcare'], literals: [], domains: ['towardshealthcare.com'] },
  { name: 'Fortune Business Insights', aliases: ['fortune business insights'], literals: [], domains: ['fortunebusinessinsights.com'] },
  { name: 'Intel Market Research', aliases: ['intel market research'], literals: [], domains: ['intelmarketresearch.com'] },
  { name: 'Maximize Market Research', aliases: ['maximize market research'], literals: [], domains: ['maximizemarketresearch.com'] },
  { name: 'Grand View Research', aliases: ['grand view research', 'grandview research'], literals: [], domains: ['grandviewresearch.com'] },
  { name: 'Allied Market Research', aliases: ['allied market research'], literals: [], domains: ['alliedmarketresearch.com'] },
  { name: 'Global Market Insights', aliases: ['global market insights'], literals: [], domains: ['globalmarketinsights.com'] },
  { name: 'Business Research Insights', aliases: ['business research insights'], literals: [], domains: ['businessresearchinsights.com'] },
  { name: 'Verified Market Research', aliases: ['verified market research'], literals: [], domains: ['verifiedmarketresearch.com'] },
  { name: 'DataM Intelligence', aliases: ['datam intelligence'], literals: [], domains: ['datamintelligence.com'] },
  { name: 'Spherical Insights', aliases: ['spherical insights'], literals: [], domains: ['sphericalinsights.com'] },
  { name: 'Marketintelo', aliases: ['marketintelo'], literals: [], domains: ['marketintelo.com'] },
  { name: 'Statista', aliases: ['statista'], literals: [], domains: ['statista.com'] },
  {
    name: 'Research and Markets',
    aliases: ['research and markets', 'researchandmarkets'],
    literals: [],
    domains: ['researchandmarkets.com'],
  },
  { name: '6Wresearch', aliases: ['6wresearch', '6w research'], literals: [], domains: ['6wresearch.com'] },
  { name: 'GlobalData', aliases: ['globaldata'], literals: [], domains: ['globaldata.com'] },
  {
    name: 'The Business Research Company',
    aliases: ['the business research company', 'business research company'],
    literals: [],
    domains: ['thebusinessresearchcompany.com'],
  },
  { name: 'Polaris Market Research', aliases: ['polaris market research'], literals: [], domains: ['polarismarketresearch.com'] },
  { name: 'Coherent Market Insights', aliases: ['coherent market insights'], literals: [], domains: ['coherentmarketinsights.com'] },
  { name: 'Expert Market Research', aliases: ['expert market research'], literals: [], domains: ['expertmarketresearch.com'] },
  { name: 'Straits Research', aliases: ['straits research'], literals: [], domains: ['straitsresearch.com'] },
  { name: 'Research Nester', aliases: ['research nester'], literals: [], domains: ['researchnester.com'] },
  { name: 'Emergen Research', aliases: ['emergen research'], literals: [], domains: ['emergenresearch.com'] },
  { name: 'Zion Market Research', aliases: ['zion market research'], literals: [], domains: ['zionmarketresearch.com'] },
];
