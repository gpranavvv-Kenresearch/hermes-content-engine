import { describe, expect, it } from 'vitest';
import { campaigns } from '../../src/config/campaign.config.js';
import { personas } from '../../src/config/persona.config.js';
import { BriefSchema, type PlanningSignal } from '../../src/schemas/index.js';
import { buildBrief, selectBriefFacts } from '../../src/strategy/brief-builder.js';
import { buildPillarOutline, buildRefreshNotes } from '../../src/strategy/evergreen.js';
import { compareOutline, extractHeadings } from '../../src/strategy/serp-gap.js';
import { loadFacts, loadPage } from '../fixtures/strategy/load.js';

const facts = loadFacts();
const item = { id: 'item-1', title: 'Examplestan Widget Market', reportUrl: 'https://www.kenresearch.com/examplestan-widget-market' };
const campaign = { ...campaigns[0]!, keywordCluster: ['widget market', 'examplestan widgets'] };
const persona = personas.find((p) => p.id === 'pe-vc')!;
const now = new Date('2026-10-13T00:00:00Z');

describe('extractHeadings', () => {
  it('reads h1-h3 text in order and ignores scripts and other tags', () => {
    const h = extractHeadings('<h1> A  B </h1><p>x</p><script>var h2="no"</script><h2>C</h2><h4>skip</h4><h3>C</h3>');
    expect(h).toEqual(['A B', 'C']);
  });
});

describe('compareOutline', () => {
  const ours = ['Examplestan Widget Market Size', 'Growth drivers'];
  const pageA = extractHeadings(loadPage('page-a'));
  const pageB = extractHeadings(loadPage('page-b'));
  const pageC = extractHeadings(loadPage('page-c'));
  const points = compareOutline(ours, [pageA, pageB, pageC]);

  it('finds topical gaps others cover and we lack', () => {
    const joined = points.join(' ').toLowerCase();
    expect(joined).toContain('pricing');
    expect(joined).toContain('supply chain');
    expect(joined).toContain('sustainability');
  });

  it('suggests angles nobody covers', () => {
    expect(points.some((p) => p.startsWith('Take an angle no compared outline takes'))).toBe(true);
  });

  it('never contains source titles, headings, URLs or quoted text', () => {
    const all = [...pageA, ...pageB, ...pageC, 'Examplestan Widget Market Pricing Guide 2026'];
    for (const p of points) {
      for (const heading of all) expect(p).not.toContain(heading);
      expect(p).not.toMatch(/https?:|www\.|\.com/i);
      expect(p).not.toMatch(/["“”]/);
    }
  });

  it('never surfaces competitor names even when they dominate headings', () => {
    expect(points.join(' ').toLowerCase()).not.toContain('mordor');
  });

  it('is deterministic', () => {
    expect(compareOutline(ours, [pageA, pageB, pageC])).toEqual(points);
  });

  it('returns nothing topical when the outline already covers everything', () => {
    const covered = compareOutline([...pageA, ...pageB], [pageA, pageB]);
    expect(covered.filter((p) => p.startsWith('Add a dedicated'))).toEqual([]);
  });
});

describe('buildBrief', () => {
  const signals: PlanningSignal[] = [
    { title: 'Widget policy update from a ministry', sourceUrl: 'https://widgets.gov.examplestan.gov.in/n/1', signalKind: 'govt_update', purpose: 'planning' },
  ];

  it('produces a schema-valid brief with only verified, non-conflicting fact ids', () => {
    const brief = buildBrief({ item, facts, campaign, persona, signals, now, personaReason: 'growth heavy' });
    expect(BriefSchema.safeParse(brief).success).toBe(true);
    expect(brief.factIds).toEqual(['F1', 'F2', 'F3']);
    expect(brief.planningSignals).toEqual(signals);
    expect(brief.personaReason).toBe('growth heavy');
    expect(brief.createdAt).toBe(now.toISOString());
  });

  it('excludes value-conflicting groups even if each is individually verified', () => {
    const twin = { ...facts[0]!, id: 'F1b', value: 13.9 };
    expect(selectBriefFacts([...facts, twin]).map((f) => f.id)).toEqual(['F2', 'F3']);
  });

  it('derives keywords from the cluster plus the item title', () => {
    const brief = buildBrief({ item, facts, campaign, persona, now });
    expect(brief.keywords).toEqual(['widget market', 'examplestan widgets', 'examplestan widget market']);
  });

  it('chooses the angle from the strongest fact; signals add framing but not their titles', () => {
    const brief = buildBrief({ item, facts, campaign, persona, signals, now });
    expect(brief.angle).toContain('market size');
    expect(brief.angle).toContain('Examplestan');
    expect(brief.angle).toContain('regulatory backdrop');
    expect(brief.angle).not.toContain('ministry');
    expect(buildBrief({ item, facts, campaign, persona, signals, now }).angle).toBe(brief.angle);
  });

  it('keeps signals out of facts: signal URLs never appear in factIds or angle', () => {
    const brief = buildBrief({ item, facts, campaign, persona, signals, now });
    expect(JSON.stringify([brief.factIds, brief.angle])).not.toContain(signals[0]!.sourceUrl);
  });

  it('rejects a persona outside the campaign pool', () => {
    expect(() => buildBrief({ item, facts, campaign, persona: { ...persona, id: 'ghost' }, now })).toThrow(/persona pool/);
  });
});

describe('evergreen', () => {
  const brief = buildBrief({ item, facts, campaign: { ...campaigns[1]!, keywordCluster: ['widget market'] }, persona, now });

  it('builds the pillar sections and attaches only brief facts', () => {
    const outline = buildPillarOutline(brief, facts);
    expect(outline.sections.map((s) => s.id)).toEqual(['definition', 'segmentation', 'drivers', 'constraints', 'regulatory', 'outlook']);
    const attached = outline.sections.flatMap((s) => s.factIds);
    expect(attached.sort()).toEqual([...brief.factIds].sort());
    expect(attached).not.toContain('F4');
    expect(outline.faq.length).toBeGreaterThan(5);
    expect(outline.faq.every((q) => q.endsWith('?'))).toBe(true);
  });

  it('flags stale facts in refresh notes and promises no rankings', () => {
    const notes = buildRefreshNotes(facts.slice(0, 1), { now: new Date('2027-10-13T00:00:00Z') });
    expect(notes.join(' ')).toMatch(/F1/);
    const outline = buildPillarOutline(brief, facts);
    expect(JSON.stringify(outline)).not.toMatch(/rank|guarantee|#1|top spot/i);
  });
});
