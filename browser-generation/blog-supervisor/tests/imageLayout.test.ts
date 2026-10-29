import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLandscapeHtml, parseLandscapeData } from '../../src/agents/blogLandscapeImageAgent.js';
import { buildSnapshotHtml, findHeroMetrics, parseSnapshotMetrics } from '../../src/agents/blogSnapshotImageAgent.js';

// Locked design guard: whatever data a run supplies, both blog images must render as a wide horizontal card, never portrait,
// and nothing may overflow the card.
const NL = String.fromCharCode(10);
const HERO = ['Base Market Value: USD 815.1 million in 2025', 'Forecast Value: USD 1,428.3 million in 2031', 'CAGR: 9.8%'];
const SNAPSHOT_SETS: Record<string, string[]> = {
  typical: [...HERO, 'Leading Segment: Pay-in-3 and Pay-in-4 interest-free', 'Fastest-Growing Segment: In-store point-of-sale and bank-application distribution channels', 'Dominant Geography: Gauteng, 43% of gross merchandise value in 2025', 'Major Driver: Online retail expansion and broader merchant acceptance', 'Major Constraint: Consumer affordability and regulatory classification uncertainty', 'Market Volume / Units: 16.8 million in 2025 → 35.2 million in 2031', 'Key Players: PayJustNow, Payflex, Mobicred, MoreTyme, Happy Pay'],
  heavy: [...HERO, 'Online Share: 41.0% in 2025', 'Segment Breakdown: A 45%, B 30%, C 25%', 'Active Users: 4.6 million in 2025 → 8.5 million in 2031', 'Market Share: P 34%, Q 22%, R 15%', 'Leading Segment: Cards', 'Major Driver: Growth', 'Key Players: Alpha, Beta, Gamma, Delta'],
  noHero: ['Leading Segment: Cards', 'Major Driver: Growth', 'Key Players: Alpha, Beta, Gamma'],
};
const LANDSCAPE_SETS: Record<string, string> = {
  names: ['Growth Drivers: Online retail checkout expansion; digital-payment readiness; merchant demand for conversion; bank-embedded instalments', 'Competitive Landscape: PayJustNow; Payflex; Mobicred; MoreTyme; Happy Pay', 'Regional Landscape: Gauteng 43%, Western Cape 24%'].join(NL),
  shares: ['Growth Drivers: One; Two; Three', 'Competitive Landscape: A 36.9%, B 22.1%, C 14.0%, D 9.5%, E 6.2%, F 4.1%', 'Regional Landscape: North 38%, South 27%, East 19%, West 11%'].join(NL),
  manyPlayers: ['Growth Drivers: One; Two; Three; Four; Five; Six', 'Competitive Landscape: P1; P2; P3; P4; P5; P6; P7; P8', 'Regional Landscape: R1 30%, R2 22%, R3 18%, R4 12%, R5 9%'].join(NL),
};

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, 60_000);
afterAll(async () => { await browser?.close(); });

async function cardSize(html: string): Promise<{ w: number; h: number; overflow: boolean }> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 2400 } });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const box = await page.locator('.card').first().boundingBox();
    const overflow = await page.evaluate(() => {
      const card = document.querySelector('.card') as HTMLElement;
      return card.scrollWidth > card.clientWidth + 1;
    });
    return { w: box!.width, h: box!.height, overflow };
  } finally { await page.close(); }
}

describe('snapshot image stays a wide horizontal card', () => {
  for (const [name, lines] of Object.entries(SNAPSHOT_SETS)) {
    it(`${name}: wider than 1.4:1 and nothing spills out`, async () => {
      const { w, h, overflow } = await cardSize(buildSnapshotHtml('Test Market', parseSnapshotMetrics(lines.join(NL))));
      expect(w / h).toBeGreaterThanOrEqual(1.4);
      expect(overflow).toBe(false);
    }, 30_000);
  }
});

describe('landscape image stays a wide horizontal card', () => {
  const hero = findHeroMetrics(parseSnapshotMetrics(HERO.join(NL)));
  for (const [name, text] of Object.entries(LANDSCAPE_SETS)) {
    it(`${name}: wider than 1.4:1 and nothing spills out`, async () => {
      const { w, h, overflow } = await cardSize(buildLandscapeHtml('Test Market', hero, parseLandscapeData(text)));
      expect(w / h).toBeGreaterThanOrEqual(1.4);
      expect(overflow).toBe(false);
    }, 30_000);
  }
});
