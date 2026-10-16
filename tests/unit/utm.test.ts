import { describe, expect, it } from 'vitest';
import { applyUtm, applyUtmToText, findUtmProblems, isKenResearchUrl } from '../../src/utils/utm.js';

const utm = { source: 'linkedin', medium: 'referral', campaign: 'automation' };
const HOSTS = ['kenresearch.com'];
const CANON = 'utm_source=linkedin&utm_medium=referral&utm_campaign=automation';

describe('applyUtm', () => {
  it('appends the canonical UTM to a bare URL', () => {
    expect(applyUtm('https://www.kenresearch.com/report', utm)).toBe(`https://www.kenresearch.com/report?${CANON}`);
  });

  it('is idempotent (normalizing twice changes nothing)', () => {
    const once = applyUtm('https://www.kenresearch.com/report?a=1&utm_source=x', utm);
    expect(applyUtm(once, utm)).toBe(once);
  });

  it('replaces duplicated, differently-cased and stale utm params with exactly one set', () => {
    const messy = 'https://kenresearch.com/r?UTM_Source=a&utm_source=b&utm_medium=c&utm_campaign=d&utm_term=e&utm_content=f';
    expect(applyUtm(messy, utm)).toBe(`https://kenresearch.com/r?${CANON}`);
  });

  it('keeps non-utm params byte-for-byte and in order, and keeps the fragment', () => {
    const out = applyUtm('https://kenresearch.com/r?b=2&a=1&utm_source=z#section', utm);
    expect(out).toBe(`https://kenresearch.com/r?b=2&a=1&${CANON}#section`);
  });

  it('decodes HTML-escaped separators', () => {
    const out = applyUtm('https://kenresearch.com/r?a=1&amp;utm_source=z&amp;utm_medium=y', utm);
    expect(out).toBe(`https://kenresearch.com/r?a=1&${CANON}`);
  });

  it('keeps the legacy raw "ppt/pdf" source unencoded', () => {
    const out = applyUtm('https://kenresearch.com/r', { source: 'ppt/pdf', medium: 'referral', campaign: 'automation' });
    expect(out).toContain('utm_source=ppt/pdf&');
  });
});

describe('applyUtmToText', () => {
  it('tags only Ken Research links and leaves others untouched', () => {
    const text = 'Read https://www.kenresearch.com/r and https://example.com/x?y=1 today.';
    const out = applyUtmToText(text, utm, HOSTS);
    expect(out).toContain(`https://www.kenresearch.com/r?${CANON} and`);
    expect(out).toContain('https://example.com/x?y=1 today.');
  });

  it('preserves trailing sentence punctuation', () => {
    const out = applyUtmToText('See https://kenresearch.com/r.', utm, HOSTS);
    expect(out).toBe(`See https://kenresearch.com/r?${CANON}.`);
  });

  it('is idempotent over a whole text', () => {
    const text = 'A https://kenresearch.com/a, B https://kenresearch.com/b?x=1.';
    const once = applyUtmToText(text, utm, HOSTS);
    expect(applyUtmToText(once, utm, HOSTS)).toBe(once);
  });
});

describe('isKenResearchUrl', () => {
  it('accepts the host and subdomains', () => {
    expect(isKenResearchUrl('https://www.kenresearch.com/x', HOSTS)).toBe(true);
    expect(isKenResearchUrl('https://blog.kenresearch.com/x', HOSTS)).toBe(true);
  });

  it('rejects look-alikes', () => {
    expect(isKenResearchUrl('https://kenresearch.com.evil.com/x', HOSTS)).toBe(false);
    expect(isKenResearchUrl('https://notkenresearch.com/x', HOSTS)).toBe(false);
    expect(isKenResearchUrl('https://kenresearch.com@evil.com/x', HOSTS)).toBe(false);
  });
});

describe('findUtmProblems', () => {
  it('passes a correctly tagged link', () => {
    expect(findUtmProblems(`Go https://kenresearch.com/r?${CANON}`, utm, HOSTS)).toEqual([]);
  });

  it('flags a missing UTM', () => {
    expect(findUtmProblems('Go https://kenresearch.com/r', utm, HOSTS)).toEqual([{ url: 'https://kenresearch.com/r', kind: 'missing_utm' }]);
  });

  it('flags duplicate UTM params', () => {
    const url = 'https://kenresearch.com/r?utm_source=linkedin&utm_source=x&utm_medium=referral&utm_campaign=automation';
    expect(findUtmProblems(url, utm, HOSTS)[0]?.kind).toBe('duplicate_utm');
  });

  it('flags a UTM that is not the approved one', () => {
    const url = 'https://kenresearch.com/r?utm_source=facebook&utm_medium=referral&utm_campaign=automation';
    expect(findUtmProblems(url, utm, HOSTS)[0]?.kind).toBe('wrong_utm');
  });

  it('flags a UTM tagged twice in the same text via two links', () => {
    const text = `A https://kenresearch.com/r?${CANON} B https://kenresearch.com/r`;
    expect(findUtmProblems(text, utm, HOSTS)).toHaveLength(1);
  });

  it('ignores non-Ken-Research links', () => {
    expect(findUtmProblems('https://example.com/r', utm, HOSTS)).toEqual([]);
  });
});
