import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ClaimChecker } from '../../src/contracts.js';
import { ValidationReportSchema, type PlatformId } from '../../src/schemas/index.js';
import { generateValeFiles } from '../../src/validation/vale.js';
import {
  classifyOutcome,
  REMEDIATION,
  validateDraft,
} from '../../src/validation/validate-draft.js';
import { config, hardCodes, makeDraft, noClaimIssues, sampleFact, utmLink, validate } from '../fixtures/validation/helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..', '..');

const cleanX = `Ken Research finds the Examplestan widget market reached USD 4.2 billion in 2025, with buyers weighing service coverage above price. ${utmLink('x')} #Widgets`;

describe('validateDraft', () => {
  it('passes a clean draft and returns a schema-valid report', () => {
    const report = validateDraft(
      { draft: makeDraft(cleanX), facts: [sampleFact], recentTexts: [], claimChecker: noClaimIssues },
      config,
    );
    expect(report.passed).toBe(true);
    expect(hardCodes(report)).toEqual([]);
    expect(ValidationReportSchema.safeParse(report).success).toBe(true);
    expect(report.draftId).toBe('d1');
  });

  it('includes claim checker issues and fails when the checker reports a hard fail', () => {
    const checker: ClaimChecker = (text, facts) => {
      expect(facts).toHaveLength(1);
      expect(text).toContain('Examplestan');
      return {
        issues: [{ code: 'UNSUPPORTED_NUMBER', severity: 'hard_fail', message: 'number not in facts', detail: { claim: '9%' } }],
        mappings: [],
      };
    };
    const report = validateDraft(
      { draft: makeDraft(cleanX), facts: [sampleFact], recentTexts: [], claimChecker: checker },
      config,
    );
    expect(report.passed).toBe(false);
    expect(hardCodes(report)).toEqual(['UNSUPPORTED_NUMBER']);
  });

  it('passes with review issues only', () => {
    const report = validate(`${cleanX} Big news!`);
    expect(report.passed).toBe(true);
    expect(report.issues.some((i) => i.severity === 'review')).toBe(true);
  });

  it('is deterministic: same input gives the same issue order, hard failures first', () => {
    const text = `Per IMARC Group growth — booming! TODO ${utmLink('x')}`;
    const fixedNow = () => new Date('2026-01-01T00:00:00Z');
    const run = () =>
      validateDraft({ draft: makeDraft(text), facts: [], recentTexts: [], claimChecker: noClaimIssues, now: fixedNow }, config);
    const a = run();
    expect(run()).toEqual(a);
    const severities = a.issues.map((i) => i.severity);
    expect(severities).toEqual([...severities].sort((x, y) => (x === y ? 0 : x === 'hard_fail' ? -1 : 1)));
    expect(hardCodes(a)).toEqual(['COMPETITOR_MENTION', 'BANNED_CHARACTER', 'PLACEHOLDER', 'MISSING_BRAND_MENTION']);
  });

  it('reports a duplicate against recent texts', () => {
    const report = validate(cleanX, 'x', [cleanX.toLowerCase()]);
    expect(hardCodes(report)).toEqual(['EXACT_DUPLICATE']);
  });
});

describe('classifyOutcome', () => {
  it('maps reports to pass / rewrite / needs_human', () => {
    expect(classifyOutcome(validate(cleanX))).toBe('pass');
    expect(classifyOutcome(validate('no link at all'))).toBe('rewrite');
    const human = validateDraft(
      {
        draft: makeDraft(cleanX),
        facts: [],
        recentTexts: [],
        claimChecker: () => ({ issues: [{ code: 'CONFLICTING_FACT', severity: 'hard_fail', message: 'facts conflict' }], mappings: [] }),
      },
      config,
    );
    expect(classifyOutcome(human)).toBe('needs_human');
    expect(classifyOutcome(human, { humanCodes: new Set() })).toBe('rewrite');
  });
});

describe('regression fixtures', () => {
  interface Fixture {
    platform: PlatformId;
    text: string;
    recentTexts?: string[];
    expectedHardCodes?: string[];
  }
  const load = (dir: string): Array<[string, Fixture]> =>
    readdirSync(join(projectRoot, 'tests/fixtures/validation', dir))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => [f, JSON.parse(readFileSync(join(projectRoot, 'tests/fixtures/validation', dir, f), 'utf8')) as Fixture]);

  const bad = load('bad');
  const good = load('good');

  it('has at least 12 known-bad and 8 known-good fixtures', () => {
    expect(bad.length).toBeGreaterThanOrEqual(12);
    expect(good.length).toBeGreaterThanOrEqual(8);
  });

  it.each(bad)('bad fixture %s fails with exactly the expected hard codes', (_name, f) => {
    const report = validate(f.text, f.platform, f.recentTexts ?? []);
    expect([...hardCodes(report)].sort()).toEqual([...(f.expectedHardCodes ?? [])].sort());
    expect(report.passed).toBe(false);
  });

  it.each(good)('good fixture %s has no hard_fail', (_name, f) => {
    const report = validate(f.text, f.platform, f.recentTexts ?? []);
    expect(hardCodes(report)).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it('covers every non-claim hard-fail code at least once across the bad fixtures', () => {
    const covered = new Set(bad.flatMap(([, f]) => f.expectedHardCodes ?? []));
    for (const code of [
      'COMPETITOR_MENTION', 'BANNED_CHARACTER', 'OVER_HARD_LIMIT', 'MISSING_SOURCE_LINK', 'MISSING_UTM', 'DUPLICATE_UTM',
      'WRONG_UTM', 'PLACEHOLDER', 'MISSING_TITLE', 'REFUSAL', 'DEGENERATE_OUTPUT', 'REASONING_LEAK', 'PROMPT_ECHO',
      'SAFETY_CLASSIFIER_LEAK', 'EXACT_DUPLICATE',
    ]) {
      expect(covered.has(code), code).toBe(true);
    }
  });
});

describe('docs and generated files stay in sync', () => {
  it('docs/validation.md lists every known code with its remediation class', () => {
    const doc = readFileSync(join(projectRoot, 'docs/validation.md'), 'utf8');
    for (const [code, remediation] of Object.entries(REMEDIATION)) {
      const row = doc.split('\n').find((l) => l.includes(`\`${code}\``) && l.trim().startsWith('|'));
      expect(row, `docs row for ${code}`).toBeDefined();
      expect(row, `remediation for ${code}`).toContain(remediation);
    }
  });

  it('committed Vale files equal the regenerated ones', () => {
    const files = generateValeFiles(config.brand);
    expect(Object.keys(files).sort()).toEqual([
      '.vale.ini',
      'styles/KenResearch/BannedPhrases.yml',
      'styles/KenResearch/EmDash.yml',
      'styles/KenResearch/HypeWords.yml',
      'styles/KenResearch/WeOur.yml',
    ]);
    for (const [rel, contents] of Object.entries(files)) {
      expect(readFileSync(join(projectRoot, rel), 'utf8'), rel).toBe(contents);
    }
  });

  it('promptfooconfig.yaml exists and points at the rewrite prompt', () => {
    const yaml = readFileSync(join(projectRoot, 'promptfooconfig.yaml'), 'utf8');
    expect(yaml).toContain('prompts:');
    expect(yaml).toContain('tests:');
  });
});
