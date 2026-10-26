import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BLOG_FORMATS, buildFormatPrompt, FIXED_RULES, OUTPUT_CONTRACT } from '../../src/agents/blogFormats.js';
import { buildMasterBlogPrompt } from '../../src/agents/blogGenAgent.js';
import { ARCHITECTURES, chooseStructure, describeStructure, idsInFamily, STRUCTURE_CATALOG, structureFile } from '../../src/agents/blogStructures.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'blogfmt-'));
  process.env.BLOG_STRUCTURE_USAGE_FILE = path.join(dir, 'usage.json');
});
afterEach(async () => {
  delete process.env.BLOG_STRUCTURE_USAGE_FILE;
  await rm(dir, { recursive: true, force: true });
});

describe('blog formats', () => {
  it('has 11 distinct ids that do not collide with the architectures', () => {
    expect(BLOG_FORMATS).toHaveLength(11);
    const ids = STRUCTURE_CATALOG.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of BLOG_FORMATS) expect(f.id.startsWith('f-')).toBe(true);
    expect(idsInFamily('architecture')).toHaveLength(ARCHITECTURES.length);
    expect(idsInFamily('format')).toHaveLength(11);
  });

  it.each(BLOG_FORMATS.map((f) => [f.id, f] as const))('%s is a compact standalone prompt that carries every fixed rule and the output contract', (_id, f) => {
    const prompt = buildFormatPrompt(f);
    expect(prompt.length).toBeLessThan(18_000);
    expect(prompt).toContain(FIXED_RULES.slice(0, 80));
    expect(prompt).toContain(OUTPUT_CONTRACT.slice(0, 60));
    expect(prompt).toContain('{{REPORT_TITLE}}');
    expect(prompt).toContain('{{REPORT_URL}}');
    // the three rules the user fixed
    expect(prompt).toContain('<strong>Ken Research</strong>');
    expect(prompt).toContain('Every meaningful number is bold');
    expect(prompt).toContain('government sources');
    expect(prompt).toContain('https://www.kenresearch.com/');
    // pipeline contract
    for (const label of ['SEO Title', 'Meta Description', 'Primary Search Intent', 'Key Snapshot Metrics for Image', 'Key Qualitative Insights for Image 2', 'FINAL ARTICLE']) {
      expect(prompt).toContain(`\n${label}\n`);
    }
    expect(prompt).toContain('YOUR_IMAGE_URL_HERE_2');
    expect(prompt).toContain('Primary report could not be verified');
    // not derived from V1.3
    expect(prompt).not.toContain('V1.3');
    expect(prompt).not.toContain('Pattern A');
    expect(prompt).not.toContain('silently create');
    // code adds the preferred-source CTA, so the format must not ask for one
    expect(f.spec).not.toMatch(/blockquote/i);
  });

  it('every format carries the research-driven rules', () => {
    for (const f of BLOG_FORMATS) {
      const prompt = buildFormatPrompt(f);
      expect(prompt).toContain('must come from the Primary Report page or from an official or government page you opened');
      expect(prompt).toContain('A paragraph never carries two links');
      expect(prompt).toContain('differ from the report by more than about 2x');
      expect(prompt).toContain('what the headline figure counts');
    }
  });

  it('formats really differ in shape, not just in topic order', () => {
    const specs = BLOG_FORMATS.map((f) => f.spec);
    expect(new Set(specs).size).toBe(11);
    expect(BLOG_FORMATS.find((f) => f.id === 'f-exec-brief')!.spec).toContain('900 to 1,100 words');
    expect(BLOG_FORMATS.find((f) => f.id === 'f-deep-dive')!.spec).toContain('1,900 to 2,300 words');
    expect(BLOG_FORMATS.find((f) => f.id === 'f-qa-knowledge')!.spec).toContain('EVERY one phrased as a real question');
    expect(BLOG_FORMATS.find((f) => f.id === 'f-playbook')!.spec).toContain('"Step 1:"');
    expect(BLOG_FORMATS.find((f) => f.id === 'f-scenarios')!.spec).toContain('exactly three H3s');
    expect(BLOG_FORMATS.find((f) => f.id === 'f-estimate-reconciliation')!.spec).toContain('never name or link a competing research firm');
    expect(BLOG_FORMATS.find((f) => f.id === 'f-regulatory-explainer')!.spec).toContain('not legal advice');
    expect(BLOG_FORMATS.find((f) => f.id === 'f-niche-brief')!.spec).toContain('Reported');
  });
});

describe('structure selection', () => {
  it('rotate and random keep using only the 8 V1.3-based architectures', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) seen.add(chooseStructure('rotate'));
    expect(seen.size).toBe(8);
    for (const id of seen) expect(describeStructure(id)!.family).toBe('architecture');
  });

  it('rotate-formats cycles through the 11 standalone formats without repeating back to back', () => {
    const picks = Array.from({ length: 11 }, () => chooseStructure('rotate-formats'));
    expect(new Set(picks).size).toBe(11);
    for (const id of picks) expect(describeStructure(id)!.family).toBe('format');
  });

  it('rotate-all covers both families', () => {
    const picks = Array.from({ length: 19 }, () => chooseStructure('rotate-all'));
    expect(new Set(picks).size).toBe(19);
  });

  it('an explicit format id is accepted and an unknown one is not', () => {
    expect(chooseStructure('f-playbook')).toBe('f-playbook');
    expect(() => chooseStructure('f-nope')).toThrow(/Unknown BLOG_STRUCTURE/);
  });

  it('resolves format ids to the formats folder and architecture ids to the structures folder', () => {
    expect(structureFile('f-roadmap')).toContain(`${path.sep}formats${path.sep}f-roadmap.txt`);
    expect(structureFile('question-ladder')).toContain(`${path.sep}structures${path.sep}question-ladder.txt`);
  });

  it('builds the prompt for a format with the report title and URL filled in', () => {
    const prompt = buildMasterBlogPrompt('Brazil Seed Market', 'https://www.kenresearch.com/industry-reports/brazil-seed-market', 'f-exec-brief');
    expect(prompt).toContain('Report Title: Brazil Seed Market');
    expect(prompt).toContain('Primary Report URL: https://www.kenresearch.com/industry-reports/brazil-seed-market');
    expect(prompt).not.toContain('{{');
    expect(prompt).toContain('ARTICLE FORMAT: EXECUTIVE BRIEF');
  });

  it('the generated prompt files on disk match the source', () => {
    for (const f of BLOG_FORMATS) {
      const onDisk = readFileSync(structureFile(f.id), 'utf8').replace(/\r\n/g, '\n');
      expect(onDisk).toBe(buildFormatPrompt(f));
    }
  });
});
