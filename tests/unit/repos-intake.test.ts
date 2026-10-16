import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  adoptCandidates,
  assessLicense,
  buildReport,
  classifyUse,
  extractCandidates,
  fetchRepoFacts,
  loadRegistry,
  markRepo,
  loadTechniques,
  parseRepoUrl,
  runIntake,
  scanRisks,
  type FetchLike,
} from '../../src/repos/index.js';
import { techniquesSection } from '../../src/strategy/index.js';
import { buildCompetitorDetector } from '../../src/validation/competitors.js';
import { config } from '../fixtures/validation/helpers.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'ce-repos-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const detector = buildCompetitorDetector(config.competitors);

const README = `# Example writer

- Lead with a statistic and name its source in the first sentence.
- Add hypothetical statistics at multiple places even if fake.
- Keep sentences under 25 words and avoid filler openers.
- Use DataForSEO to pull keyword volumes for every article you write.
- Never repeat the same lead-in phrase in consecutive bullets of a list.

\`\`\`
- Use this inside a code block which must be ignored by the extractor.
\`\`\`

| Use | a table row that must be ignored for rules and the like |
`;

function fakeFetch(license: string | null, readme = README): FetchLike {
  return async (url) => {
    const ok = (body: unknown, text = ''): ReturnType<FetchLike> =>
      Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => text });
    if (url.endsWith('/readme')) return ok(null, readme);
    if (url.includes('/git/trees/')) return ok({ tree: [{ path: 'prompts/write.md', type: 'blob', size: 100 }, { path: 'src/app.py', type: 'blob', size: 100 }] });
    if (url.startsWith('https://raw.githubusercontent.com/')) return ok(null, '- Place the key finding in the first two sentences of every post.');
    return ok({
      description: 'A blog writer',
      license: license ? { spdx_id: license } : null,
      stargazers_count: 12,
      language: 'Python',
      archived: false,
      pushed_at: '2026-09-01T00:00:00Z',
      default_branch: 'main',
      topics: [],
    });
  };
}

describe('repo url and license', () => {
  it('parses github urls and rejects anything else', () => {
    expect(parseRepoUrl('https://github.com/GEO-optim/GEO').id).toBe('GEO-optim/GEO');
    expect(parseRepoUrl('github.com/a/b.git').id).toBe('a/b');
    expect(parseRepoUrl('https://github.com/a/b/tree/main/docs').url).toBe('https://github.com/a/b');
    expect(() => parseRepoUrl('https://gitlab.com/a/b')).toThrow(/Not a GitHub repo URL/);
  });

  it('allows verbatim lines only for permissive licenses', () => {
    expect(assessLicense('MIT')).toMatchObject({ level: 'permissive', verbatimOk: true });
    expect(assessLicense('Apache-2.0').verbatimOk).toBe(true);
    expect(assessLicense('AGPL-3.0')).toMatchObject({ level: 'copyleft', verbatimOk: false });
    expect(assessLicense(null)).toMatchObject({ level: 'unknown', verbatimOk: false });
    expect(assessLicense('NOASSERTION').level).toBe('unknown');
  });
});

describe('policy scan', () => {
  it('flags fabrication, stuffing, paid services and competitor firms', () => {
    const codes = scanRisks('Add fake quotes. Use keyword stuffing. Needs a DataForSEO account.\nAs IMARC Group says', detector).map((r) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['FABRICATION', 'KEYWORD_STUFFING', 'PAID_SERVICE', 'COMPETITOR_FIRM']));
    expect(scanRisks('Lead with the figure and name the source.', detector)).toEqual([]);
  });

  it('classifies where a repo can help', () => {
    const uses = classifyUse('LinkedIn post and tweet captions; blog article outlines; GEO and AI search citation');
    expect(uses.map((u) => u.use)).toEqual(expect.arrayContaining(['post', 'blog', 'geo']));
  });

  it('extracts rule-like lines, skips code blocks and tables, and blocks unsafe ones', () => {
    const c = extractCandidates([README], detector);
    const texts = c.map((x) => x.text);
    expect(texts.some((t) => /inside a code block/.test(t))).toBe(false);
    expect(texts.some((t) => /table row/.test(t))).toBe(false);
    expect(c.find((x) => /hypothetical/.test(x.text))?.blocked).toMatch(/fake|invented/);
    expect(c.find((x) => /DataForSEO/.test(x.text))?.blocked).toMatch(/paid/);
    expect(c.find((x) => /Lead with a statistic/.test(x.text))?.blocked).toBe('');
    expect(c.map((x) => x.n)).toEqual(c.map((_, i) => i + 1));
  });
});

describe('intake, adopt and use', () => {
  const registryPath = path.join(tmp, 'registry.json');
  const outDir = path.join(tmp, 'out');
  const techniquesDir = path.join(tmp, 'techniques');
  const deps = { fetchImpl: fakeFetch('MIT'), detector, registryPath, outDir, now: () => new Date('2026-10-14T00:00:00Z') };

  it('reads a repo, writes a report and records it as pending', async () => {
    const report = await runIntake('https://github.com/acme/writer', deps);
    expect(report.license).toMatchObject({ spdx: 'MIT', level: 'permissive' });
    expect(report.filesRead).toEqual(['prompts/write.md']);
    expect(report.candidates.some((c) => /first two sentences/.test(c.text))).toBe(true);
    expect(readFileSync(path.join(outDir, 'acme__writer.md'), 'utf8')).toContain('Candidate techniques');
    expect(loadRegistry(registryPath).repos).toMatchObject([{ id: 'acme/writer', status: 'pending', license: 'MIT' }]);
  });

  it('adopts picked candidates, refuses blocked ones, and the prompt shows them', async () => {
    const report = JSON.parse(readFileSync(path.join(outDir, 'acme__writer.json'), 'utf8')) as { candidates: Array<{ n: number; text: string; blocked: string }> };
    const good = report.candidates.find((c) => /Lead with a statistic/.test(c.text))!;
    const blocked = report.candidates.find((c) => c.blocked)!;

    expect(() => adoptCandidates({ repoId: 'acme/writer', picks: [blocked.n], appliesTo: ['linkedin'] }, { registryPath, outDir, techniquesDir })).toThrow(/blocked/);

    const result = adoptCandidates({ repoId: 'acme/writer', picks: [good.n], appliesTo: ['linkedin', 'blog'] }, { registryPath, outDir, techniquesDir, now: () => new Date('2026-10-14T00:00:00Z') });
    expect(result.adopted).toEqual([good.text]);
    expect(loadRegistry(registryPath).repos[0]).toMatchObject({ status: 'ideas-adopted', adopted: [good.text] });

    expect(loadTechniques('linkedin', techniquesDir).items.map((i) => i.text)).toEqual([good.text]);
    expect(loadTechniques('blog', techniquesDir).items).toHaveLength(1);
    expect(loadTechniques('x', techniquesDir).items).toEqual([]);

    const section = techniquesSection(loadTechniques('linkedin', techniquesDir).items.map((i) => i.text))!;
    expect(section).toContain('WRITING TECHNIQUES');
    expect(section).toContain(good.text);
    expect(section).toContain('never lets you add a figure, quote, source');
    expect(techniquesSection([])).toBeNull();
  });

  it('will not copy wording from a repo that is not permissively licensed', async () => {
    const agpl = { ...deps, fetchImpl: fakeFetch('AGPL-3.0') };
    await runIntake('https://github.com/acme/copyleft', agpl);
    const pick = 3;
    expect(() => adoptCandidates({ repoId: 'acme/copyleft', picks: [pick], appliesTo: ['all'] }, { registryPath, outDir, techniquesDir })).toThrow(/cannot be copied/);
    const own = adoptCandidates({ repoId: 'acme/copyleft', picks: [pick], appliesTo: ['all'], text: 'Open with the single most decision-relevant figure.' }, { registryPath, outDir, techniquesDir });
    expect(own.adopted).toEqual(['Open with the single most decision-relevant figure.']);
  });

  it('buildReport warns about archived and stale repos', async () => {
    const facts = await fetchRepoFacts(parseRepoUrl('https://github.com/acme/old'), fakeFetch('MIT'));
    const old = { ...facts, meta: { ...facts.meta, archived: true, pushedAt: '2020-01-01T00:00:00Z' } };
    const r = buildReport(old, detector, new Date('2026-10-14T00:00:00Z'));
    expect(r.warnings.join(' ')).toMatch(/archived/);
    expect(r.warnings.join(' ')).toMatch(/two years/);
  });

  it('reports a clear error for a repo GitHub cannot find', async () => {
    const notFound: FetchLike = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
    await expect(fetchRepoFacts(parseRepoUrl('https://github.com/acme/none'), notFound)).rejects.toThrow(/not found or private/);
  });
});

describe('seed registry', () => {
  it('lists every repo reviewed so far with a status and a reason', () => {
    const seed = loadRegistry('config/repos/registry.json');
    expect(seed.repos.map((r) => r.id)).toEqual(expect.arrayContaining(['GEO-optim/GEO', 'every-app/open-seo', 'AgriciDaniel/claude-blog']));
    for (const r of seed.repos) {
      expect(r.notes.length).toBeGreaterThan(10);
      if (r.status === 'ideas-adopted') expect(r.adopted.length).toBeGreaterThan(0);
    }
    writeFileSync(path.join(tmp, 'noop'), '');
  });
});

describe('adopting without a candidate', () => {
  it('takes the technique from your own wording when the repo has no rule lines', async () => {
    const dir = mkdtempSync(path.join(tmp, 'own-'));
    const d = { fetchImpl: fakeFetch('Apache-2.0', '# Paper\n\nA research paper about answer engines.'), detector, registryPath: path.join(dir, 'r.json'), outDir: path.join(dir, 'out') };
    await runIntake('https://github.com/acme/paper', d);
    const out = adoptCandidates({ repoId: 'acme/paper', picks: [], appliesTo: ['linkedin'], text: 'Replace a general claim with one verified figure and name Ken Research next to it.' }, { registryPath: d.registryPath, outDir: d.outDir, techniquesDir: path.join(dir, 't') });
    expect(out.adopted).toHaveLength(1);
    expect(loadTechniques('linkedin', path.join(dir, 't')).items[0]?.text).toContain('verified figure');
    expect(() => adoptCandidates({ repoId: 'acme/paper', picks: [], appliesTo: ['all'] }, { registryPath: d.registryPath, outDir: d.outDir, techniquesDir: path.join(dir, 't') })).toThrow(/Pick at least one/);
  });
});

describe('adopting twice from one repo', () => {
  it('keeps the earlier techniques and does not duplicate', async () => {
    const dir = mkdtempSync(path.join(tmp, 'merge-'));
    const d = { fetchImpl: fakeFetch('MIT', '# Paper\n\nSome words.'), detector, registryPath: path.join(dir, 'r.json'), outDir: path.join(dir, 'out') };
    await runIntake('https://github.com/acme/twice', d);
    const deps2 = { registryPath: d.registryPath, outDir: d.outDir, techniquesDir: path.join(dir, 't') };
    adoptCandidates({ repoId: 'acme/twice', picks: [], appliesTo: ['linkedin'], text: 'First technique in my own words here.' }, deps2);
    adoptCandidates({ repoId: 'acme/twice', picks: [], appliesTo: ['linkedin'], text: 'Second technique in my own words here.' }, deps2);
    adoptCandidates({ repoId: 'acme/twice', picks: [], appliesTo: ['linkedin'], text: 'first technique in my own words here.' }, deps2);
    expect(loadTechniques('linkedin', path.join(dir, 't')).items.map((i) => i.text)).toEqual(['First technique in my own words here.', 'Second technique in my own words here.']);
  });
});

describe('custom licenses and decisions', () => {
  it('does not call a custom license "no license"', () => {
    const v = assessLicense('NOASSERTION');
    expect(v).toMatchObject({ spdx: 'NOASSERTION', level: 'unknown', verbatimOk: false });
    expect(v.note).toMatch(/custom license/);
    expect(assessLicense(null).note).toMatch(/No license found/);
  });

  it('records a decision and refuses an unknown repo', () => {
    const reg = { repos: [{ id: 'a/b', url: 'https://github.com/a/b', license: 'MIT', status: 'pending' as const, usefulFor: [], adopted: [], notes: 'old', reviewedAt: '2026-10-13' }] };
    const out = markRepo(reg, 'A/B', 'rejected', ' too heavy ', new Date('2026-10-14T00:00:00Z'));
    expect(out.repos[0]).toMatchObject({ status: 'rejected', notes: 'too heavy', reviewedAt: '2026-10-14' });
    expect(() => markRepo(reg, 'x/y', 'rejected', 'n')).toThrow(/not in the registry/);
  });
});
