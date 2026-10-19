/**
 * runRow.ts — full storyline-carousel pipeline for Social Media row(s):
 *   pick row -> storyline prompts -> 6 images -> PDF -> write PDF path into
 *   the "7Slide" column of that row.
 *
 * Usage:
 *   npx tsx li-carousel-storyline/scripts/runRow.ts                  # next row with empty 7Slide
 *   npx tsx li-carousel-storyline/scripts/runRow.ts --row=5          # specific row
 *   npx tsx li-carousel-storyline/scripts/runRow.ts --row=5 --force  # overwrite a filled 7Slide cell
 *   npx tsx li-carousel-storyline/scripts/runRow.ts --count=100      # keep going, up to 100 rows
 *   add --account=<name> to use a different ChatGPT profile (default storyline)
 *
 * --count and --row are mutually exclusive — --row always means exactly one
 * specific row; --count re-picks the next pending row fresh after each one
 * finishes (so it naturally skips whatever the previous iteration just
 * wrote), stopping early the moment no pending rows are left.
 *
 * The sheet is only written for a row after all 6 of its slides exist and
 * the PDF was built. Any failure earlier leaves that row's sheet cell
 * untouched. In --count mode, one row failing is logged and skipped —
 * it does NOT stop the rest of the batch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import 'dotenv/config';
import { getRow, getNextPendingRow, writeSevenSlide, type SheetRowInfo } from './sheetIO.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/s);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
) as Record<string, string | boolean>;

const accountName = (args.account as string) || 'storyline';
const force = args.force === true;
const count = args.count ? parseInt(args.count as string, 10) : 1;

if (args.row && args.count) {
  console.error('--row and --count cannot be used together — --row processes exactly one specific row.');
  process.exit(1);
}

const slugify = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
// shell:true on Windows re-parses args through cmd.exe, so quote every arg.
const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
const runScript = (file: string, scriptArgs: string[]) =>
  execFileSync('npx', ['tsx', quote(path.join(__dirname, file)), ...scriptArgs.map(quote)], { stdio: 'inherit', shell: true });

async function processOneRow(target: SheetRowInfo): Promise<void> {
  if (!target.targetUrl || !target.title) throw new Error(`Row ${target.row} has no targetUrl/title.`);
  if (target.sevenSlide && !force) {
    throw new Error(`Row ${target.row} already has a 7Slide value (${target.sevenSlide}). Re-run with --force to overwrite.`);
  }

  const slug = slugify(target.title);
  console.log(`\nRow ${target.row}: ${target.title}\n   ${target.targetUrl}\n   slug: ${slug}\n`);

  console.log('=== 1/3 storyline prompts ===');
  runScript('generateStoryline.ts', [`--title=${target.title}`, `--url=${target.targetUrl}`, `--account=${accountName}`]);

  console.log('\n=== 2/3 images ===');
  runScript('generateImages.ts', [`--slug=${slug}`, `--account=${accountName}`]);

  console.log('\n=== 3/3 PDF ===');
  runScript('combinePdf.ts', [`--slug=${slug}`]); // exits non-zero unless exactly 6 slides exist

  const pdfPath = path.join(ROOT, 'images', `${slug}.pdf`);
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found after build: ${pdfPath}`);

  const cell = await writeSevenSlide(target.row, pdfPath);
  console.log(`\n✅ Done. Wrote PDF path to 7Slide (${cell}) of row ${target.row}:\n   ${pdfPath}`);
}

(async () => {
  if (args.row) {
    const target = await getRow(parseInt(args.row as string, 10));
    await processOneRow(target);
    return;
  }

  let succeeded = 0;
  let failed = 0;
  for (let i = 0; i < count; i++) {
    console.log(`\n========== Row ${i + 1}/${count} of this run ==========`);
    const target = await getNextPendingRow();
    if (!target) {
      console.log('No pending rows left: every row with a targetUrl + title already has a 7Slide value.');
      break;
    }
    try {
      await processOneRow(target);
      succeeded++;
    } catch (err: any) {
      console.error(`\n❌ Row ${target.row} failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n========== Batch complete: ${succeeded} succeeded, ${failed} failed ==========`);
})().catch((err) => {
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
