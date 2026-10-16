import { describe, expect, it } from 'vitest';
import { sourcePolicy } from '../../src/config/source-policy.config.js';
import { classifyUrl, validateFetchedSource } from '../../src/evidence/source-validator.js';

const c = (url: string, purpose: 'fact' | 'citation' | 'planning' = 'fact') => classifyUrl(url, purpose, sourcePolicy);

describe('classifyUrl allowed hosts', () => {
  it('allows Ken Research with www, uppercase, trailing dot, port 443 and subdomains', () => {
    for (const u of [
      'https://www.kenresearch.com/report/x',
      'HTTPS://KenResearch.COM/a',
      'https://kenresearch.com./a',
      'https://kenresearch.com:443/a',
      'http://kenresearch.com:80/a',
      'https://blog.kenresearch.com/a',
    ]) {
      const r = c(u);
      expect(r.allowed, u).toBe(true);
      expect(r.sourceType).toBe('ken_research');
    }
  });

  it('allows government hosts and extra allowed hosts', () => {
    expect(c('https://data.example.gov/stats').sourceType).toBe('government');
    expect(c('https://www.mof.gov.in/x').sourceType).toBe('government');
    expect(c('https://www.example.go.jp/x').sourceType).toBe('government');
    expect(c('https://ec.europa.eu/eurostat').sourceType).toBe('extra_allowed');
  });
});

describe('classifyUrl look-alikes and tricks', () => {
  it.each([
    'https://kenresearch.com.evil.com/a',
    'https://kenresearch.com@evil.com/a',
    'https://evil.com@kenresearch.com/a',
    'https://user:pw@kenresearch.com/a',
    'https://xgov.in/a',
    'https://gov.evil.com/a',
    'https://notkenresearch.com/a',
    'https://kenresearch.com.au/a',
    'https://evil.com/?u=https://kenresearch.com',
    'https://evil.com/kenresearch.com',
  ])('rejects %s for fact', (u) => {
    expect(c(u).allowed).toBe(false);
  });

  it('rejects non-http schemes and malformed input', () => {
    for (const u of ['ftp://kenresearch.com/a', 'javascript:alert(1)', 'file:///etc/passwd', '', 'not a url', 'https://', 'https://kenresearch.com\\@evil.com/']) {
      expect(c(u).allowed, u).toBe(false);
    }
  });

  it('rejects IP literals (decimal, hex, v6) and local hosts', () => {
    for (const u of ['http://127.0.0.1/', 'http://0x7f.1/', 'http://2130706433/', 'http://[::1]/', 'http://localhost/', 'http://intranet/']) {
      expect(c(u).allowed, u).toBe(false);
      expect(c(u, 'planning').allowed, u).toBe(false);
    }
  });

  it('rejects non-standard ports', () => {
    expect(c('https://kenresearch.com:8443/a').allowed).toBe(false);
  });

  it('handles punycode and IDN homographs as distinct hosts', () => {
    expect(c('https://xn--kenresearch-9ib.com/a').allowed).toBe(false);
    expect(c('https://kenresearch.com/a').allowed).toBe(true);
    // Cyrillic 'e' in kenresearch
    expect(c('https://kеnresearch.com/a').allowed).toBe(false);
  });
});

describe('classifyUrl competitors and planning', () => {
  it('blocks competitors for every purpose including planning', () => {
    for (const purpose of ['fact', 'citation', 'planning'] as const) {
      const r = c('https://www.imarcgroup.com/report', purpose);
      expect(r.allowed).toBe(false);
      expect(r.sourceType).toBe('competitor_blocked');
    }
  });

  it('blocks competitor subdomains but not look-alike hosts', () => {
    expect(c('https://sub.imarcgroup.com/x', 'planning').sourceType).toBe('competitor_blocked');
    expect(c('https://IMARCGROUP.com./x', 'planning').sourceType).toBe('competitor_blocked');
    expect(c('https://evil-imarcgroup.com/x', 'planning').allowed).toBe(true);
    expect(c('https://evil-imarcgroup.com/x', 'fact').allowed).toBe(false);
    expect(c('https://market.us/x', 'planning').sourceType).toBe('competitor_blocked');
  });

  it('planning allows other hosts as planning_other; fact does not', () => {
    expect(c('https://example.org/trends', 'planning')).toMatchObject({ allowed: true, sourceType: 'planning_other' });
    expect(c('https://example.org/trends', 'fact')).toMatchObject({ allowed: false, sourceType: 'disallowed' });
    expect(c('https://example.org/trends', 'citation').allowed).toBe(false);
  });

  it('checks blocked hosts before allow rules', () => {
    const policy = { ...sourcePolicy, extraAllowedHosts: ['imarcgroup.com'] };
    expect(classifyUrl('https://imarcgroup.com/x', 'fact', policy).sourceType).toBe('competitor_blocked');
  });
});

describe('validateFetchedSource', () => {
  const now = new Date('2026-10-13T00:00:00Z');
  const ok = 'https://www.kenresearch.com/report/examplestan-widget-market';

  it('allows a clean source and fills the record', () => {
    const v = validateFetchedSource({ requestedUrl: ok, finalUrl: ok, canonicalUrl: ok }, 'fact', sourcePolicy, { now });
    expect(v.allowed).toBe(true);
    expect(v.record).toMatchObject({ sourceType: 'ken_research', allowlistStatus: 'allowed', purpose: 'fact', fetchedAt: now.toISOString() });
  });

  it('uses finalUrl as canonical when none is given', () => {
    const v = validateFetchedSource({ requestedUrl: ok, finalUrl: ok }, 'fact', sourcePolicy);
    expect(v.record.canonicalUrl).toBe(ok);
  });

  it('fails the whole source when a redirect lands on a competitor', () => {
    const v = validateFetchedSource({ requestedUrl: ok, finalUrl: 'https://www.imarcgroup.com/x' }, 'fact', sourcePolicy);
    expect(v.allowed).toBe(false);
    expect(v.record.sourceType).toBe('competitor_blocked');
    expect(v.record.allowlistStatus).toBe('blocked');
  });

  it('fails when the canonical is hijacked to a non-allowed host', () => {
    const v = validateFetchedSource({ requestedUrl: ok, finalUrl: ok, canonicalUrl: 'https://evil.com/copy' }, 'fact', sourcePolicy);
    expect(v.allowed).toBe(false);
    expect(v.record.reason).toContain('canonical');
  });

  it('fails when the requested url was non-allowed even if final is fine', () => {
    const v = validateFetchedSource({ requestedUrl: 'https://evil.com/r', finalUrl: ok }, 'fact', sourcePolicy);
    expect(v.allowed).toBe(false);
  });

  it('competitor canonical wins the sourceType over a plain disallowed one', () => {
    const v = validateFetchedSource(
      { requestedUrl: 'https://evil.com/r', finalUrl: ok, canonicalUrl: 'https://technavio.com/x' },
      'fact',
      sourcePolicy,
    );
    expect(v.record.sourceType).toBe('competitor_blocked');
  });

  it('planning purpose allows other hosts but never a competitor canonical', () => {
    const u = 'https://example.org/post';
    expect(validateFetchedSource({ requestedUrl: u, finalUrl: u }, 'planning', sourcePolicy).allowed).toBe(true);
    expect(validateFetchedSource({ requestedUrl: u, finalUrl: u, canonicalUrl: 'https://technavio.com/x' }, 'planning', sourcePolicy).allowed).toBe(false);
  });
});
