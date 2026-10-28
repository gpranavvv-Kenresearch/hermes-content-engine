import { describe, expect, it } from 'vitest';
import { formatMeasurements, looksGovernmentHost, measureBlog, structuralHardFails } from '../src/measure.js';
import { makeArticle, makeBlog, REPORT_URL } from './fixtures.js';

const measure = (o = {}) => {
  const b = makeBlog(o);
  return measureBlog({ html: b.html, seoTitle: b.seoTitle, metaDescription: b.description, primaryUrl: REPORT_URL, evidenceText: '8.7 12.1 4.8 8.70' });
};

describe('measureBlog on a V1.3-shaped article', () => {
  const m = measure();

  it('counts structure', () => {
    expect(m.headings.h1).toBe(1);
    expect(m.headings.h2).toBe(6);
    expect(m.headings.h2QuestionCount).toBe(4);
    expect(m.tables).toBe(0);
    expect(m.blockquotes).toBe(1);
    expect(m.emDashes).toBe(0);
    expect(m.words).toBeGreaterThan(900);
    expect(structuralHardFails(m)).toEqual([]);
  });

  it('classifies links against the V1.3 link plan', () => {
    expect(m.links.kenHomepage).toBe(1);
    expect(m.links.kenAdjacent).toBe(4);
    expect(m.links.kenPrimary).toBe(1);
    expect(m.links.government).toBe(3);
    expect(m.links.googlePreferredSource).toBe(1);
    expect(m.links.primaryOnlyInFinalParagraph).toBe(true);
    expect(m.links.inHeadings).toBe(0);
    expect(m.links.maxLinksInOneBlock).toBe(1);
    expect(m.links.introHasNonKenLink).toBe(false);
  });

  it('reports bolding', () => {
    expect(m.kenResearch.mentions).toBeGreaterThanOrEqual(4);
    expect(m.kenResearch.unbolded).toBe(0);
    expect(m.numbers.unbolded).toBe(0);
  });

  it('reports the SEO title and meta description lengths', () => {
    expect(m.seoTitle?.length).toBeGreaterThan(30);
    expect(m.seoTitle?.containsKenResearch).toBe(false);
    expect(m.seoTitle?.equalsH1).toBe(false);
    expect(m.metaDescription?.length).toBeGreaterThan(100);
  });

  it('formats a table the supervisor can read', () => {
    const text = formatMeasurements(m);
    expect(text).toContain('Words:');
    expect(text).toContain('Links total');
    expect(text).toContain('SEO title:');
  });
});

describe('measureBlog detects problems', () => {
  it('unbolded Ken Research', () => {
    expect(measure({ unboldedKen: true }).kenResearch.unbolded).toBeGreaterThan(0);
  });
  it('tables and em dashes', () => {
    const m = measure({ table: true, emDash: true });
    expect(m.tables).toBe(1);
    expect(m.emDashes).toBe(1);
    expect(structuralHardFails(m).join(' ')).toContain('table');
  });
  it('a missing primary report link', () => {
    const m = measure({ noPrimaryLink: true });
    expect(m.links.kenPrimary).toBe(0);
    expect(m.links.primaryOnlyInFinalParagraph).toBe(false);
  });
  it('a non-government external host is listed for the supervisor to judge', () => {
    const m = measure({ badExternal: true });
    expect(m.links.otherExternal).toBe(1);
    expect(m.links.externalHosts).toContain('seedtradeassociation.org');
  });
  it('leftover image placeholders', () => {
    expect(measure({ placeholder: true }).imagePlaceholders).toBe(1);
  });
  it('unbolded figures outside headings', () => {
    const m = measure({ unboldedNumber: true });
    expect(m.numbers.unbolded).toBe(1);
    expect(m.numbers.sampleUnbolded).toEqual(['42']);
  });
  it('bold figures that are not in the evidence', () => {
    const b = makeBlog();
    const m = measureBlog({ html: b.html, primaryUrl: REPORT_URL, evidenceText: '8.7 4.8' });
    expect(m.figuresNotInEvidence).toContain('12.1');
    expect(m.figuresNotInEvidence).not.toContain('8.7');
  });
  it('too few sections or words is structural garbage', () => {
    const m = measureBlog({ html: '<h1>T</h1><p>short</p>' });
    expect(structuralHardFails(m).length).toBeGreaterThanOrEqual(2);
  });
  it('detects back-to-back linked paragraphs outside the intro', () => {
    const html = '<h1>T</h1><h2>A?</h2><p><a href="https://www.kenresearch.com/industry-reports/x">x</a> one</p><p><a href="https://www.ibge.gov.br/a">y</a> two</p>';
    expect(measureBlog({ html }).links.consecutiveLinkedBlocks).toBe(1);
  });
});

describe('style measurements', () => {
  const para = (t: string) => `<p>${t} ${'word '.repeat(40)}</p>`;
  it('lists stock phrases found in the article', () => {
    const html = `<h1>T</h1>${para("In today's digital landscape the market will delve into growth and leverage")}${para('It is a game-changer')}`;
    const m = measureBlog({ html });
    expect(m.style.stockPhrases).toEqual(expect.arrayContaining(["in today's digital landscape", 'delve', 'game-changer']));
  });
  it('counts paragraphs that open with "Here"', () => {
    const html = `<h1>T</h1>${para("Here's why this matters")}${para('Here are three reasons')}${para('The market grows')}`;
    expect(measureBlog({ html }).style.hereOpeners).toBe(2);
  });
  it('reports the figure density of the densest paragraph', () => {
    const dense = `<p>${'<strong>1</strong> <strong>2</strong> <strong>3</strong> <strong>4</strong> <strong>5</strong> <strong>6</strong> '}${'word '.repeat(34)}</p>`;
    const m = measureBlog({ html: `<h1>T</h1>${dense}${para('plain')}` });
    expect(m.numbers.densestPer100).toBeGreaterThanOrEqual(10);
  });
  it('flags headings that all share one grammatical shape', () => {
    const qs = ['How big is it?', 'Why is it growing?', 'Who competes?', 'What are the risks?', 'Where next?'].map((h) => `<h2>${h}</h2>${para('x')}`).join('');
    expect(measureBlog({ html: `<h1>T</h1>${qs}` }).style.sameShapeHeadings).toBe(true);
    const mixed = ['How big is it?', 'Growth Is Concentrated in Two Segments', 'Who competes?', 'Regulation Raises Entry Costs', 'Where next?'].map((h) => `<h2>${h}</h2>${para('x')}`).join('');
    expect(measureBlog({ html: `<h1>T</h1>${mixed}` }).style.sameShapeHeadings).toBe(false);
  });
  it('the clean fixture article shows no stock phrases', () => {
    expect(measure().style.stockPhrases).toEqual([]);
  });
});

describe('looksGovernmentHost', () => {
  it.each(['ibge.gov.br', 'bls.gov', 'ec.europa.eu', 'stats.gov.sa', 'canada.ca', 'mapa.gob.ar'])('%s is government-looking', (h) => {
    expect(looksGovernmentHost(h)).toBe(true);
  });
  it.each(['seedtradeassociation.org', 'mckinsey.com', 'reuters.com'])('%s is not', (h) => {
    expect(looksGovernmentHost(h)).toBe(false);
  });
});

void makeArticle;
