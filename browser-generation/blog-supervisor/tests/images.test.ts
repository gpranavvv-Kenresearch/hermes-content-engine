import { describe, expect, it } from 'vitest';
import { buildLandscapeHtml, parseLandscapeData } from '../../src/agents/blogLandscapeImageAgent.js';
import { buildSnapshotHtml, findHeroMetrics, parseSnapshotMetrics, withAlpha } from '../../src/agents/blogSnapshotImageAgent.js';

const metrics = parseSnapshotMetrics([
  'Base Market Value: USD 815.1 million in 2025',
  'Forecast Value: USD 1,428.3 million in 2031',
  'CAGR: 9.8%',
  'Market Volume / Units: 16.8 million transactions in 2025 → 35.2 million transactions in 2031',
].join('\n'));
const hero = findHeroMetrics(metrics);

describe('snapshot image', () => {
  it('fades only the fill of the earliest trend bubble, never its text', () => {
    const html = buildSnapshotHtml('South Africa BNPL', metrics);
    const bubble = /<div class="trend-bubble[^"]*" style="([^"]*)"/.exec(html)![1]!;
    expect(bubble).toContain('rgba(');
    expect(bubble).not.toMatch(/(^|;)\s*opacity:/);
  });
  it('is a wide horizontal card, 1132px wide, never more than two widget columns', () => {
    const many = parseSnapshotMetrics([
      'Base Market Value: USD 100 million in 2025', 'Forecast Value: USD 200 million in 2031', 'CAGR: 9.8%',
      'Online Share: 41.0% in 2025', 'Segment Breakdown: A 45%, B 30%, C 25%',
      'Active Users: 4.6 million in 2025 → 8.5 million in 2031', 'Market Share: P 34%, Q 22%, R 15%',
    ].join('\n'));
    const html = buildSnapshotHtml('Test Market', many);
    expect(html).toContain('html, body { width: 1132px; }');
    expect(html).not.toMatch(/repeat\(3,\s*1fr\)\s*;?\s*"/);
    expect(html).toMatch(/grid-template-columns:\s*repeat\(2,\s*1fr\)/);
  });
  it('a three-point trend takes the full row so its bubbles stay on one line', () => {
    const three = parseSnapshotMetrics('Completed Orders: 3.8 million in 2025 → 8.5 million in 2028 → 12.1 million in 2031');
    const html = buildSnapshotHtml('Test Market', three);
    expect(html).toContain('grid-column: 1 / -1;');
    expect(html).toContain('flex-wrap:nowrap');
  });
  it('shares go under the bubble, not inside it', () => {
    const html = buildSnapshotHtml('Test Market', parseSnapshotMetrics('Segment Breakdown: A 45%, B 30%, C 5%'));
    expect(html).toContain('bubble-pct-out');
    expect(html).not.toContain('<span class="bubble-pct">');
  });
  it('withAlpha converts a hex colour and leaves anything else alone', () => {
    expect(withAlpha('#2f5fa3', 0.35)).toBe('rgba(47,95,163,0.35)');
    expect(withAlpha('red', 0.5)).toBe('red');
  });
});

describe('landscape image', () => {
  it('keeps competitor shares when they are given', () => {
    const d = parseLandscapeData('Competitive Landscape: Provider A 36.9%, Provider B 22.1%');
    expect(d.competitive).toHaveLength(2);
    expect(d.competitiveNames).toEqual([]);
  });
  it('turns names without shares into a plain list and never invents shares', () => {
    const d = parseLandscapeData('Competitive Landscape: PayJustNow; Payflex; Mobicred, MoreTyme');
    expect(d.competitive).toEqual([]);
    expect(d.competitiveNames).toEqual(['PayJustNow', 'Payflex', 'Mobicred', 'MoreTyme']);
    const html = buildLandscapeHtml('South Africa BNPL', hero, d);
    expect(html).toContain('Key Players');
    expect(html).toContain('PayJustNow');
    expect(html).not.toContain('Competitive Landscape</div>');
  });
  it('puts the share under the bubble so a small share cannot clip its own label', () => {
    const html = buildLandscapeHtml('South Africa BNPL', hero, parseLandscapeData('Competitive Landscape: A 36.9%, B 6.2%'));
    expect(html).toContain('bubble-pct-out');
    expect(html).not.toContain('<span class="bubble-pct">');
  });
  it('scales the forecast bubbles to the panel and leaves room for the year label', () => {
    const html = buildLandscapeHtml('South Africa BNPL', hero, parseLandscapeData('Growth Drivers: One; Two'));
    expect(html).toContain('viewBox="0 0 400 184"');
    expect(html).toContain('width:100%');
    expect(html).not.toMatch(/<svg width="\d+"/);
  });
  it('is a wide horizontal card, 1132px', () => {
    const html = buildLandscapeHtml('South Africa BNPL', hero, parseLandscapeData('Growth Drivers: One; Two'));
    expect(html).toContain('html, body { width: 1132px; }');
  });
});

describe('landscape image is locked: every piece of supplied data must be drawn', () => {
  const full = parseLandscapeData([
    'Growth Drivers: Online retail checkout expansion; digital-payment readiness; merchant demand for conversion; bank-embedded instalments',
    'Competitive Landscape: PayJustNow; Payflex; Mobicred; MoreTyme; Happy Pay',
    'Regional Landscape: Gauteng 43%, Western Cape 24%',
  ].join('\n'));
  const html = buildLandscapeHtml('South Africa BNPL', hero, full);

  it('draws every section and stat', () => {
    for (const title of ['Forecast Growth', 'Key Players', 'Growth Drivers', 'Regional Heat Map', 'Key Takeaways']) expect(html).toContain(title);
    for (const chip of ['CAGR', 'Incremental Growth', 'Growth Multiple']) expect(html).toContain(chip);
    expect(html).toContain('USD 815.1');
    expect(html).toContain('USD 1,428.3');
  });
  it('draws every driver, player and region, plus the share left over', () => {
    for (const t of ['Online retail checkout expansion', 'digital-payment readiness', 'merchant demand for conversion', 'bank-embedded instalments']) expect(html).toContain(t);
    for (const n of ['PayJustNow', 'Payflex', 'Mobicred', 'MoreTyme', 'Happy Pay']) expect(html).toContain(n);
    for (const r of ['Gauteng', 'Western Cape', 'Other regions']) expect(html).toContain(r);
    expect(html).toContain('33%');
    expect(html).toContain('67%');
  });
  it('writes one takeaway for each of the four data groups', () => {
    expect((html.match(/class="takeaway-num"/g) ?? []).length).toBe(4);
    expect(html).toContain('1.75x');
  });
  it('keeps the wide horizontal layout: two panels on top, three below', () => {
    expect((html.match(/<div class="row">/g) ?? []).length).toBe(2);
    expect(html).toContain('html, body { width: 1132px; }');
  });
});

describe('snapshot image: growth path instead of repeating the key players', () => {
  const nl = String.fromCharCode(10);
  const base = ['Base Market Value: USD 815.1 million in 2025', 'Forecast Value: USD 1,428.3 million in 2031', 'CAGR: 9.8%'];
  it('draws the implied growth path with every year, ending exactly on the supplied figures', () => {
    const html = buildSnapshotHtml('Test Market', parseSnapshotMetrics([...base, 'Key Players: A, B, C'].join(nl)));
    expect(html).toContain('Implied Growth Path');
    for (const y of ['2025', '2026', '2027', '2028', '2029', '2030', '2031']) expect(html).toContain('>' + y + '</text>');
    expect(html).toContain('>815</text>');
    expect(html).toContain('>1,428</text>');
  });
  it('does not repeat the key players orbit that the landscape image already has', () => {
    const html = buildSnapshotHtml('Test Market', parseSnapshotMetrics([...base, 'Key Players: A, B, C'].join(nl)));
    expect(html).not.toContain('KEY PLAYERS');
  });
  it('falls back to the key players orbit only when there is no base-to-forecast pair', () => {
    const html = buildSnapshotHtml('Test Market', parseSnapshotMetrics(['Leading Segment: Cards', 'Key Players: A, B, C'].join(nl)));
    expect(html).toContain('KEY PLAYERS');
    expect(html).not.toContain('Implied Growth Path');
  });
});
