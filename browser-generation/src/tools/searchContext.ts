/**
 * Collect Google Trends search context for report titles, ahead of blog and image generation.
 *
 *   npm run trends:context -- --title "Kenya Lubricants Market" [--url https://...] [--force]
 *   npm run trends:context -- --from-sheet [--sheet newLogic|pool] [--limit 5] [--force]   same rows blog generation would pick (default newLogic)
 *   npm run trends:context -- --titles-file titles.txt
 *   npm run trends:context -- --title "..." --show            print the prompt blocks from the cache, no fetching
 *
 * The generators only read the cache; a title with no cached context is generated without it, never blocked.
 * Needs the one-time `npm run trends:login` (dedicated Google account).
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { collectSearchContext } from '../../../src/signals/context-collector.js';
import { readSearchContext, renderSearchContextBlock } from '../../../src/signals/search-context.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

interface Job { title: string; url: string | null }

async function jobs(): Promise<Job[]> {
  const title = arg('title');
  if (title) return [{ title, url: arg('url') ?? null }];
  const file = arg('titles-file');
  if (file) return readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((t) => ({ title: t, url: null }));
  if (has('from-sheet')) {
    const { getContentPoolRowsNeedingGeneration } = await import('../sheets/sheets.js');
    // Same pick as blog generation (runBlogGenBatch): New Logic tab, Target URL set and Blog Content empty,
    // title falling back to the URL. Read-only: rows are not claimed or changed.
    const sheet = arg('sheet') === 'pool' ? 'pool' : 'newLogic';
    const rows = await getContentPoolRowsNeedingGeneration(Number(arg('limit') ?? 5), sheet);
    return rows.map((r) => ({ title: r.title || r.targetUrl, url: r.targetUrl || null }));
  }
  throw new Error('Pass --title "<report title>", --titles-file <file> or --from-sheet [--sheet pool|newLogic] [--limit N]');
}

async function main(): Promise<void> {
  const list = await jobs();
  if (has('show')) {
    for (const j of list) {
      const ctx = readSearchContext(j.title);
      console.log(`\n=== ${j.title} ===`);
      console.log(ctx ? `--- blog block ---\n${renderSearchContextBlock(ctx, 'blog')}\n\n--- image block ---\n${renderSearchContextBlock(ctx, 'image')}` : 'no fresh cached context');
    }
    return;
  }
  const summary: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const j = list[i]!;
    console.log(`\n[${i + 1}/${list.length}] ${j.title}`);
    if (i > 0) await new Promise((r) => setTimeout(r, 10_000));
    const out = await collectSearchContext(j.title, { url: j.url, force: has('force'), headless: has('headless') });
    summary.push(`${out.status.padEnd(9)} ${j.title}${out.note ? ` (${out.note})` : ''}`);
    if (out.status === 'FAILED' && /expired|throttled/i.test(out.note)) { console.log('Stopping: fix the Google session before continuing.'); break; }
  }
  console.log(`\nSummary\n${summary.join('\n')}`);
}

main().catch((e: unknown) => { console.error(`trends:context: ${(e as Error).message}`); process.exitCode = 1; });
