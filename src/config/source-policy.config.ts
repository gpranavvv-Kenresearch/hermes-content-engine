import type { SourcePolicy } from '../schemas/index.js';
import { competitors } from './competitors.config.js';

/**
 * Source policy (locked 2026-10-13):
 *  - facts / numbers / citations: Ken Research + government/regulatory hosts only
 *  - planning signals (trends, SERP headings, leader angles): any host that is not blocked,
 *    but only as a planning signal, never as a fact or citation
 *  - competitor research firms: never fetched
 *  - supplementary evidence (2026-10-14, user decision): when the report page has no verified figure from 2024 or
 *    later, related Ken Research and government pages are read for figures (attributed to their real source) and other
 *    non-competitor pages (never a market-research publisher or press-release wire) give neutral, number-free
 *    background only. No figure from those pages is used and nothing from them is credited to Ken Research.
 *
 * governmentHostPatterns are regex sources tested against the lowercased,
 * www-stripped hostname. They are anchored so look-alikes such as
 * "gov.example.com" or "xgov.in" do not match.
 */
export const sourcePolicy: SourcePolicy = {
  kenResearchHosts: ['kenresearch.com'],
  governmentHostPatterns: [
    '(^|\\.)gov$', // *.gov
    '(^|\\.)gov\\.[a-z]{2,3}$', // gov.uk, gov.in, gov.au, gov.za ...
    '(^|\\.)go\\.[a-z]{2}$', // go.jp, go.kr, go.id, go.th, go.ke ...
    '(^|\\.)gob\\.[a-z]{2}$', // gob.mx, gob.es ...
    '(^|\\.)gouv\\.[a-z]{2,3}$', // gouv.fr ...
    '(^|\\.)nic\\.in$',
    '(^|\\.)gc\\.ca$',
    '(^|\\.)canada\\.ca$',
  ],
  // Supranational government institutions that are explicitly approved.
  extraAllowedHosts: ['europa.eu'],
  blockedHosts: competitors.flatMap((c) => c.domains),
};
