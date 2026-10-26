import 'dotenv/config';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRUCTURE_CATALOG, structureFile } from '../../src/agents/blogStructures.js';
import { runBlogEngine } from './runner.js';
import { BlogStateStore } from './state.js';

export interface BlogCliArgs {
  command: string;
  loop: boolean;
  limit?: number;
  row?: number;
  withImage: boolean;
  structure: string;
  blogAccount?: string;
  imageAccount?: string;
  imagePromptChoice?: '1' | '2';
  url?: string;
  title?: string;
  rerender?: string;
  list: boolean;
  review: boolean;
  noReview: boolean;
  withCover: boolean;
}

export function parseBlogArgs(argv: string[]): BlogCliArgs {
  const [command = 'help', ...rest] = argv;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueNames = new Set(['limit', 'row', 'structure', 'blog-account', 'image-account', 'image-prompt', 'url', 'title', 'rerender']);
  const flagNames = new Set(['loop', 'with-image', 'list', 'review', 'show-browser', 'no-review', 'with-cover']);
  for (const arg of rest) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`Unknown argument: ${arg}`);
    const [, key, value] = m as unknown as [string, string, string | undefined];
    if (flagNames.has(key)) flags.add(key);
    else if (valueNames.has(key) && value) values.set(key, value);
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  const int = (key: string, min: number, max: number): number | undefined => {
    const raw = values.get(key);
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${key} must be ${min}-${max}.`);
    return n;
  };
  if (flags.has('show-browser')) process.env.BLOG_SHOW_BROWSER = '1';
  const prompt = values.get('image-prompt');
  if (prompt && prompt !== '1' && prompt !== '2') throw new Error('--image-prompt must be 1 or 2.');
  const limit = int('limit', 1, 500);
  const row = int('row', 2, 100000);
  const blogAccount = values.get('blog-account');
  const imageAccount = values.get('image-account');
  return {
    command,
    loop: flags.has('loop'),
    ...(limit !== undefined ? { limit } : {}),
    ...(row !== undefined ? { row } : {}),
    withImage: flags.has('with-image'),
    list: flags.has('list'),
    review: flags.has('review'),
    noReview: flags.has('no-review'),
    withCover: flags.has('with-cover'),
    ...(values.get('url') ? { url: values.get('url')! } : {}),
    ...(values.get('rerender') ? { rerender: values.get('rerender')! } : {}),
    ...(values.get('title') ? { title: values.get('title')! } : {}),
    structure: values.get('structure') ?? process.env.BLOG_STRUCTURE ?? 'v1.3',
    ...(blogAccount ? { blogAccount } : {}),
    ...(imageAccount ? { imageAccount } : {}),
    ...(prompt ? { imagePromptChoice: prompt as '1' | '2' } : {}),
  };
}

async function check(): Promise<void> {
  const exists = (p: string) => access(p).then(() => 'ok').catch(() => 'missing');
  const store = new BlogStateStore();
  const state = await store.load();
  const rows = Object.values(state.rows);
  const out = {
    structurePromptFiles: Object.fromEntries(await Promise.all(STRUCTURE_CATALOG.map(async (a) => [a.id, await exists(structureFile(a.id))]))),
    sheetCredential: process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? 'GOOGLE_SERVICE_ACCOUNT_JSON' : await exists(path.resolve('.accounts/google-service-account.json')),
    driveToken: await exists(path.resolve('.accounts/google-drive-token.json')),
    hermesCommand: process.env.HCE_HERMES_BIN ?? 'hermes',
    rowsTracked: rows.length,
    written: rows.filter((r) => r.status === 'written').length,
    skipped: rows.filter((r) => r.status === 'skipped').length,
    parked: rows.filter((r) => r.status === 'parked').length,
  };
  console.log(JSON.stringify(out, null, 2));
  console.log('To test Hermes itself run:  hermes chat --oneshot -q "Say ready" --provider openai-codex');
}

async function status(): Promise<void> {
  const store = new BlogStateStore();
  const beat = await store.readHeartbeat();
  console.log(beat ? JSON.stringify({ ...beat, updatedAgoSeconds: Math.round((Date.now() - Number(beat.updatedAt)) / 1000) }, null, 2) : 'Blog engine has not started yet.');
  const state = await store.load();
  const recent = Object.entries(state.rows).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 10);
  for (const [row, s] of recent) console.log(`row ${row}: ${s.status} (attempts ${s.attempts}) ${s.title} :: ${s.lastReason.slice(0, 140)}`);
}

export async function mainBlog(argv: string[]): Promise<void> {
  const args = parseBlogArgs(argv);
  if (args.command === 'check') return check();
  if (args.command === 'status') return status();
  if (args.command === 'unpark') {
    console.log(`Unparked ${await new BlogStateStore().unpark()} row(s).`);
    return;
  }
  if (args.command === 'final' && args.rerender) {
    const { rerenderImages } = await import('./final.js');
    await rerenderImages(args.rerender);
    return;
  }
  if (args.command === 'final') {
    if (args.structure === 'v1.3' && !process.argv.some((a) => a.startsWith('--structure'))) throw new Error('blog:final needs --structure=<id> (for example --structure=f-regulatory-explainer).');
    const { runFinal } = await import('./final.js');
    await runFinal({
      structure: args.structure, noReview: args.noReview, withCover: args.withCover,
      ...(args.url ? { url: args.url } : {}), ...(args.title ? { title: args.title } : {}),
      ...(args.blogAccount ? { blogAccount: args.blogAccount } : {}), ...(args.imageAccount ? { imageAccount: args.imageAccount } : {}),
    });
    return;
  }
  if (args.command === 'sample') {
    const { listSamples, runSample } = await import('./sample.js');
    if (args.list || args.structure === 'v1.3') {
      console.log(await listSamples());
      return;
    }
    await runSample({
      structure: args.structure, review: args.review,
      ...(args.url ? { url: args.url } : {}), ...(args.title ? { title: args.title } : {}),
      ...(args.blogAccount ? { account: args.blogAccount } : {}),
    });
    return;
  }
  if (args.command === 'run') {
    const result = await runBlogEngine({
      loop: args.loop, withImage: args.withImage, structureMode: args.structure,
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.row !== undefined ? { row: args.row } : {}),
      ...(args.blogAccount ? { blogAccount: args.blogAccount } : {}),
      ...(args.imageAccount ? { imageAccount: args.imageAccount } : {}),
      ...(args.imagePromptChoice ? { imagePromptChoice: args.imagePromptChoice } : {}),
    });
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`Hermes blog engine

  npm run blog:check
  npm run blog:status
  npm run blog:run -- --limit=1 --with-image [--structure=v1.3|rotate|random|rotate-formats|random-formats|rotate-all|random-all|<id>] [--row=N]
  (add --show-browser to any sample/run command to keep the ChatGPT window visible)
  npm run blog:final -- --rerender=<folder under output/blog-final>   (redraw the two images of an earlier final blog with the current image code; no ChatGPT, no Hermes)
  npm run blog:final -- --structure=<id> [--with-cover] [--no-review]  (the full finished blog with images, saved locally; nothing written to the Sheet or Drive)
  npm run blog:sample -- --list                                 (sample status for all 8 architectures)
  npm run blog:sample -- --structure=<id> [--review]             (one local sample, nothing written to the Sheet)
  npm run blog:run -- --loop --with-image --structure=v1.3      (continuous)
  npm run blog:unpark                                          (retry rows parked after repeated failures)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mainBlog(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
