import { describe, expect, it } from 'vitest';
import { defaultRawConfig, loadConfig, loadConfigFrom, type RawConfig } from '../../src/config/index.js';
import { ConfigError } from '../../src/errors.js';
import { platformLimits } from '../../src/config/platform-limits.config.js';
import { PlatformIdSchema } from '../../src/schemas/index.js';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function rawWith(mutate: (raw: any) => void): RawConfig {
  const raw = clone(defaultRawConfig) as any;
  mutate(raw);
  return raw as RawConfig;
}

function issuesOf(raw: RawConfig): string[] {
  try {
    loadConfigFrom(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).issues;
  }
  throw new Error('expected loadConfigFrom to throw');
}

describe('shipped config', () => {
  it('loads and validates', () => {
    const cfg = loadConfig();
    expect(cfg.brand.name).toBe('Ken Research');
    expect(cfg.version).toMatch(/^[0-9a-f]{12}$/);
  });

  it('has a deterministic version hash, and it changes when config changes', () => {
    const a = loadConfig().version;
    const b = loadConfig().version;
    expect(a).toBe(b);
    const changed = loadConfigFrom(rawWith((r) => (r.brand.tone = 'something else'))).version;
    expect(changed).not.toBe(a);
  });

  it('defines limits for every platform, and the FB/LI hard cap is 2280', () => {
    for (const p of PlatformIdSchema.options) expect(platformLimits[p]).toBeDefined();
    expect(platformLimits.facebook.hardMaxChars).toBe(2280);
    expect(platformLimits.linkedin.hardMaxChars).toBe(2280);
    expect(platformLimits.x.urlCountsAs).toBe(23);
  });

  it('blocks every competitor domain', () => {
    const cfg = loadConfig();
    for (const c of cfg.competitors) for (const d of c.domains) expect(cfg.sourcePolicy.blockedHosts).toContain(d);
  });
});

describe('invalid config fails startup with useful errors', () => {
  it('rejects a bad platform limit (min target above max)', () => {
    const issues = issuesOf(rawWith((r) => (r.platformLimits.facebook.targetMinChars = 5000)));
    expect(issues.join('\n')).toMatch(/platformLimits/);
  });

  it('rejects a campaign that references an unknown persona', () => {
    const issues = issuesOf(rawWith((r) => r.campaigns[0].personaIds.push('ghost')));
    expect(issues).toContain('campaigns.authority-insights: unknown persona "ghost"');
  });

  it('rejects a platform with no UTM entry', () => {
    const issues = issuesOf(rawWith((r) => delete r.utm.instagram));
    expect(issues.join('\n')).toMatch(/utm: no entry for platform "instagram"/);
  });

  it('rejects an un-normalized competitor alias', () => {
    const issues = issuesOf(rawWith((r) => r.competitors[0].aliases.push('Mordor Intelligence!')));
    expect(issues.join('\n')).toMatch(/must be written in normalized form/);
  });

  it('rejects duplicate competitor aliases and domains', () => {
    const issues = issuesOf(
      rawWith((r) => {
        r.competitors[1].aliases.push(r.competitors[0].aliases[0]);
        r.competitors[1].domains.push(r.competitors[0].domains[0]);
      }),
    );
    const text = issues.join('\n');
    expect(text).toMatch(/alias ".*" used by both/);
    expect(text).toMatch(/domain ".*" used by both/);
  });

  it('rejects a blocklist that misses a competitor domain', () => {
    const issues = issuesOf(rawWith((r) => (r.sourcePolicy.blockedHosts = r.sourcePolicy.blockedHosts.slice(1))));
    expect(issues.join('\n')).toMatch(/blockedHosts is missing competitor domain/);
  });

  it('rejects hosts with schemes or paths and invalid regexes', () => {
    const issues = issuesOf(
      rawWith((r) => {
        r.sourcePolicy.kenResearchHosts = ['https://kenresearch.com/path'];
        r.sourcePolicy.governmentHostPatterns.push('(unclosed');
      }),
    );
    const text = issues.join('\n');
    expect(text).toMatch(/must be a plain lowercase hostname/);
    expect(text).toMatch(/not a valid regex/);
  });

  it('rejects a host that is both allowed and blocked', () => {
    const issues = issuesOf(rawWith((r) => r.sourcePolicy.blockedHosts.push('kenresearch.com')));
    expect(issues.join('\n')).toMatch(/both allowed and blocked/);
  });

  it('rejects brand attribution that violates its own bans', () => {
    const issues = issuesOf(rawWith((r) => r.brand.attributionPhrases.push('Ken Research — a game-changing finding')));
    const text = issues.join('\n');
    expect(text).toMatch(/banned character/);
    expect(text).toMatch(/banned promo word/);
  });

  it('reports ALL problems at once, not just the first', () => {
    const issues = issuesOf(
      rawWith((r) => {
        r.campaigns[0].personaIds.push('ghost');
        delete r.utm.instagram;
      }),
    );
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });
});
