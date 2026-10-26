/**
 * Sample mode: write ONE article with a chosen architecture for a chosen report and save it locally.
 * Nothing is written to the Sheet and no images are generated, so architectures can be compared safely.
 *
 *   npm run blog:sample -- --list
 *   npm run blog:sample -- --structure=question-ladder [--url=<report url>] [--title=<market name>] [--review]
 *
 * All samples reuse the same report (stored in output/blog-samples/target.json) so the comparison is fair.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../../../src/config/index.js';
import { describeStructure, STRUCTURE_CATALOG } from '../../src/agents/blogStructures.js';
import { openBlogChatSession } from '../../src/agents/blogGenAgent.js';
import { getContentPoolRowsNeedingGeneration } from '../../src/sheets/sheets.js';
import { gatherBlogEvidence } from './evidence.js';
import { formatMeasurements, measureBlog } from './measure.js';
import { BlogLimits, BlogSupervisor, createBlogHermesAsk, loadBlogRole } from './supervisor.js';

export const SAMPLES_ROOT = path.resolve('output/blog-samples');
const targetFile = path.join(SAMPLES_ROOT, 'target.json');

interface Target { url: string; title: string }

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { return null; }
}

export async function resolveTarget(opts: { url?: string; title?: string }): Promise<Target> {
  if (opts.url) {
    const t = { url: opts.url, title: opts.title ?? opts.url };
    await mkdir(SAMPLES_ROOT, { recursive: true });
    await writeFile(targetFile, JSON.stringify(t, null, 2), 'utf8');
    return t;
  }
  const saved = await readJson<Target>(targetFile);
  if (saved) return saved;
  const [first] = await getContentPoolRowsNeedingGeneration(1, 'newLogic');
  if (!first) throw new Error('No --url given, no saved sample target, and no pending Sheet row to borrow one from.');
  const t = { url: first.targetUrl, title: opts.title ?? (first.title || first.targetUrl) };
  await mkdir(SAMPLES_ROOT, { recursive: true });
  await writeFile(targetFile, JSON.stringify(t, null, 2), 'utf8');
  return t;
}

export function sampleDir(id: string): string {
  const n = STRUCTURE_CATALOG.findIndex((a) => a.id === id);
  return path.join(SAMPLES_ROOT, `${String(n + 1).padStart(2, '0')}-${id}`);
}

export async function listSamples(): Promise<string> {
  const target = await readJson<Target>(targetFile);
  const lines = [`Sample report: ${target ? `${target.title} | ${target.url}` : '(not chosen yet; the first sample picks it)'}`, ''];
  for (const a of STRUCTURE_CATALOG) {
    const done = await readJson<{ words: number; h2: number }>(path.join(sampleDir(a.id), 'summary.json'));
    lines.push(`${done ? '[done] ' : '[    ] '}${a.id.padEnd(28)} ${a.label}${done ? `  (${done.words} words, ${done.h2} H2)` : ''}`);
  }
  return lines.join('\n');
}

export const PREVIEW_CSS = 'body{font:17px/1.65 Georgia,serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1a1a1a}h1{font-size:30px;line-height:1.25}h2{font-size:23px;margin-top:2em}blockquote{border-left:4px solid #888;margin:1.5em 0;padding:.2em 1em;background:#f6f6f6}img{max-width:100%}a{color:#0b57d0}.meta{font:14px/1.5 system-ui,sans-serif;background:#eef3ff;padding:12px 16px;border-radius:8px;margin-bottom:28px}';

export async function runSample(opts: { structure: string; url?: string; title?: string; review: boolean; account?: string }): Promise<string> {
  const arch = describeStructure(opts.structure);
  if (!arch) throw new Error(`Unknown structure "${opts.structure}". Use one of: ${STRUCTURE_CATALOG.map((a) => a.id).join(', ')}`);

  const target = await resolveTarget({ ...(opts.url ? { url: opts.url } : {}), ...(opts.title ? { title: opts.title } : {}) });
  console.log(`[SAMPLE] ${arch.label} on "${target.title}"`);
  const config = loadConfig();
  const ev = await gatherBlogEvidence({ url: target.url, title: target.title }, { config });
  if (!ev.pageLoaded) throw new Error(`Sample report did not load: ${ev.summary}`);
  console.log(`[SAMPLE] Evidence: ${ev.summary.split('\n').slice(0, 3).join(' | ')}`);

  const session = await openBlogChatSession({ title: target.title, url: ev.finalUrl, structure: arch.id, ...(opts.account ? { accountHandle: opts.account } : {}) });
  let blog;
  try {
    blog = await session.generate();
  } finally {
    await session.close();
  }

  const m = measureBlog({ html: blog.html, seoTitle: blog.seoTitle, metaDescription: blog.description, primaryUrl: ev.finalUrl, evidenceText: ev.evidenceText });
  const dir = sampleDir(arch.id);
  await mkdir(dir, { recursive: true });
  const measurements = formatMeasurements(m);
  await writeFile(path.join(dir, 'article.html'), blog.html, 'utf8');
  await writeFile(path.join(dir, 'measurements.txt'), measurements, 'utf8');
  await writeFile(path.join(dir, 'deliverable.txt'), `SEO TITLE\n${blog.seoTitle}\n\nMETA DESCRIPTION\n${blog.description}\n\nKEY SNAPSHOT METRICS\n${blog.imageData}\n\nIMAGE 2 INSIGHTS\n${blog.imageData2}\n`, 'utf8');
  await writeFile(
    path.join(dir, 'preview.html'),
    `<!doctype html><meta charset="utf-8"><title>${blog.seoTitle.replace(/</g, '&lt;')}</title><style>${PREVIEW_CSS}</style>` +
      `<div class="meta"><b>${arch.label}</b> (${arch.id})<br>SEO title: ${blog.seoTitle.replace(/</g, '&lt;')}<br>Meta: ${blog.description.replace(/</g, '&lt;')}<br>${m.words} words, ${m.headings.h2} H2</div>` +
      blog.html.replace(/YOUR_IMAGE_URL_HERE(_2)?/g, 'data:image/gif;base64,R0lGODlhAQABAAAAACw='),
    'utf8',
  );

  let review = '';
  if (opts.review) {
    const limits = new BlogLimits();
    const sup = new BlogSupervisor(createBlogHermesAsk(), loadBlogRole(), limits);
    const material = [`EVIDENCE\n${ev.summary}`, ev.pageText ? `\nREPORT PAGE TEXT (Ken Research's own data; figures that appear here are supported)\n${ev.pageText}` : '', `\nSTRUCTURE IN USE: ${arch.id}${arch.family === 'format' ? `\nFORMAT SPEC (this format's own shape and length band govern; judge the article against it)\n${arch.summary}` : ''}`, `\nCODE MEASUREMENTS\n${measurements}`, `\nSEO TITLE: ${blog.seoTitle}\nMETA DESCRIPTION: ${blog.description}`, `\nARTICLE HTML\n${blog.html}`].join('\n');
    const d = await sup.decide({ gate: 'draft', material, history: [], limitsNote: limits.note() });
    review = JSON.stringify(d.decision, null, 2);
    await writeFile(path.join(dir, 'hermes-review.json'), review, 'utf8');
  }

  await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ structure: arch.id, words: m.words, h2: m.headings.h2, h2Texts: m.headings.h2Texts, target, at: new Date().toISOString() }, null, 2), 'utf8');
  const out = [
    `\n[SAMPLE] ${arch.label}: ${m.words} words, ${m.headings.h2} H2 (${m.headings.h2QuestionCount} questions), ${m.links.total} links`,
    ...m.headings.h2Texts.map((t, i) => `   ${i + 1}. ${t}`),
    review ? `\nHermes draft-gate verdict:\n${review}` : '',
    `\nOpen in your browser: ${path.join(dir, 'preview.html')}`,
  ].join('\n');
  console.log(out);
  return out;
}
