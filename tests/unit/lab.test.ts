import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkClaims } from '../../src/evidence/index.js';
import {
  addRepo,
  checkLabOutput,
  detectRunHints,
  findLabRepo,
  formatLabCheck,
  loadLab,
  runInRepo,
  saveLabCheck,
  scrubbedEnv,
  type ExecFn,
} from '../../src/lab/index.js';
import { config, sampleFact, utmLink } from '../fixtures/validation/helpers.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'ce-lab-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('scrubbed environment', () => {
  const base = { PATH: '/bin', USERPROFILE: 'C:/u', GROQ_API_KEY_1: 'secret-1', OPENROUTER_API_KEY_1: 'secret-2', TAVILY_API_KEY_1: 'secret-3', CE_ENV_FILE: 'x' };

  it('lets no key through by default', () => {
    const env = scrubbedEnv(base);
    expect(env).toEqual({ PATH: '/bin', USERPROFILE: 'C:/u' });
    expect(JSON.stringify(env)).not.toMatch(/secret/);
  });

  it('passes only the variables that are named', () => {
    expect(scrubbedEnv(base, ['GROQ_API_KEY_1'])).toMatchObject({ GROQ_API_KEY_1: 'secret-1' });
    expect(scrubbedEnv(base, ['GROQ_API_KEY_1']).OPENROUTER_API_KEY_1).toBeUndefined();
    expect(scrubbedEnv(base, ['NOT_SET'])).not.toHaveProperty('NOT_SET');
  });
});

describe('run hints', () => {
  it('reads what the repo says about running it', () => {
    const dir = mkdtempSync(path.join(tmp, 'hints-'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev', start: 'next start', lint: 'eslint' } }));
    writeFileSync(path.join(dir, '.env.example'), 'KEY=');
    writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}');
    writeFileSync(path.join(dir, 'README.md'), '# App\n\n```\nnpm run dev\n```\n\nSome prose.\n');
    const hints = detectRunHints(dir);
    expect(hints).toEqual(
      expect.arrayContaining(['Node project: `npm install` first', 'npm script "dev": next dev', 'npm script "start": next start', 'Has a docker compose file (needs Docker)', 'README: npm run dev']),
    );
    expect(hints.some((h) => h.includes('.env.example'))).toBe(true);
    expect(hints.some((h) => h.includes('lint'))).toBe(false);
  });

  it('gives no hints for an empty folder', () => {
    expect(detectRunHints(mkdtempSync(path.join(tmp, 'empty-')))).toEqual([]);
  });
});

describe('add and run', () => {
  const lab = path.join(tmp, 'lab');
  const now = () => new Date('2026-10-14T00:00:00Z');

  it('clones through git, records the repo and refuses a second clone', async () => {
    const calls: string[][] = [];
    const exec: ExecFn = async (cmd, args) => {
      calls.push([cmd, ...args]);
      mkdirSync(args.at(-1)!, { recursive: true });
      writeFileSync(path.join(args.at(-1)!, 'package.json'), '{"scripts":{"dev":"vite"}}');
      return { code: 0, output: '' };
    };
    const entry = await addRepo('https://github.com/acme/seo-tool', { lab, exec, now });
    expect(calls[0]!.slice(0, 7)).toEqual(['git', '-c', 'core.longpaths=true', 'clone', '--depth', '1', '--']);
    expect(calls[0]![7]).toBe('https://github.com/acme/seo-tool.git');
    expect(entry.hints).toContain('npm script "dev": vite');
    expect(findLabRepo(loadLab(lab), 'ACME/seo-tool')?.clonedAt).toBe('2026-10-14T00:00:00.000Z');
    await expect(addRepo('https://github.com/acme/seo-tool', { lab, exec })).rejects.toThrow(/already in the lab/);
    await expect(addRepo('https://example.com/acme/x', { lab, exec })).rejects.toThrow(/Not a GitHub repo URL/);
  });

  it('reports a failed clone clearly', async () => {
    const exec: ExecFn = async () => ({ code: 128, output: 'fatal: not found' });
    await expect(addRepo('https://github.com/acme/missing', { lab, exec })).rejects.toThrow(/git clone failed/);
  });

  it('runs a command in the repo folder with only the named keys, and logs it', async () => {
    let seen: { cwd?: string; env?: Record<string, string> } = {};
    const exec: ExecFn = async (_c, _a, options) => {
      seen = { cwd: options.cwd, env: options.env };
      return { code: 0, output: 'ok' };
    };
    const base = { PATH: '/bin', GROQ_API_KEY_1: 'k1', TAVILY_API_KEY_1: 'k2' };
    const out = await runInRepo('acme/seo-tool', 'npm run dev', { allowEnv: ['GROQ_API_KEY_1'], baseEnv: base }, { lab, exec, now });
    expect(out.code).toBe(0);
    expect(seen.cwd).toContain('acme__seo-tool');
    expect(seen.env).toEqual({ PATH: '/bin', GROQ_API_KEY_1: 'k1' });
    expect(readFileSync(out.log, 'utf8')).toContain('$ npm run dev');
    await expect(runInRepo('acme/unknown', 'x', {}, { lab, exec })).rejects.toThrow(/not in the lab/);
  });
});

describe('judging a repo output with the engine checks', () => {
  const good = `Ken Research finds the Examplestan widget market reached USD 4.2 billion in 2025, with buyers weighing service coverage above price. ${utmLink('x')} #Widgets`;
  const bad = 'According to IMARC Group, the widget market will double by 2030 thanks to AI 🚀 — a huge opportunity.';

  it('accepts a compliant text and rejects a non-compliant one with the reasons', () => {
    const ok = checkLabOutput({ repoId: 'acme/seo-tool', platform: 'x', text: good, facts: [sampleFact] }, config, checkClaims);
    expect(ok.wouldPass).toBe(true);
    expect(ok.hard).toEqual([]);

    const no = checkLabOutput({ repoId: 'acme/seo-tool', platform: 'x', text: bad, facts: [sampleFact] }, config, checkClaims);
    expect(no.wouldPass).toBe(false);
    const codes = no.hard.map((h) => h.code);
    expect(codes).toEqual(expect.arrayContaining(['COMPETITOR_MENTION', 'BANNED_CHARACTER', 'BANNED_EMOJI', 'MISSING_SOURCE_LINK']));
    expect(no.hard.find((h) => h.code === 'BANNED_EMOJI')?.fixable).toBe(true);
    expect(no.hard.find((h) => h.code === 'COMPETITOR_MENTION')?.fixable).toBe(false);
    expect(formatLabCheck(no)).toContain('REJECT');
    expect(formatLabCheck(ok)).toContain('would accept');
  });

  it('saves the text and the verdict under results/<repo>', () => {
    const lab = path.join(tmp, 'lab2');
    const result = checkLabOutput({ repoId: 'acme/seo-tool', platform: 'x', text: good, facts: [sampleFact] }, config, checkClaims);
    const file = saveLabCheck(result, good, { lab, now: () => new Date('2026-10-14T01:02:03Z') });
    expect(JSON.parse(readFileSync(file, 'utf8')).wouldPass).toBe(true);
    expect(readdirSync(path.dirname(file)).sort()).toEqual(['check-2026-10-14T01-02-03-000Z.json', 'check-2026-10-14T01-02-03-000Z.txt']);
  });
});
