/**
 * run.ts — orchestrator: generateStoryline.ts then generateImages.ts for one
 * report, in sequence.
 *
 * Usage:
 *   npx tsx li-carousel-storyline/scripts/run.ts \
 *     --title="Report Title Here" --url="https://www.kenresearch.com/..." [--account=storyline]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/s);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
) as Record<string, string>;

const reportTitle = args.title;
const reportUrl = args.url;
const accountName = args.account || 'storyline';

if (!reportTitle || !reportUrl) {
  console.error('Usage: npx tsx run.ts --title="..." --url="..." [--account=storyline]');
  process.exit(1);
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const slug = slugify(reportTitle);

// shell: true on Windows joins the args array with spaces and re-parses it
// through cmd.exe, so any arg containing a space (the title, or this
// OneDrive path itself) gets silently split into multiple arguments unless
// each one is quoted here first — execFileSync does NOT do this for us.
const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

console.log('=== Step 1: generate storyline + extract 6 prompts ===');
execFileSync('npx', ['tsx', quote(path.join(__dirname, 'generateStoryline.ts')),
  quote(`--title=${reportTitle}`), quote(`--url=${reportUrl}`), quote(`--account=${accountName}`)],
  { stdio: 'inherit', shell: true });

console.log('\n=== Step 2: generate 6 images ===');
execFileSync('npx', ['tsx', quote(path.join(__dirname, 'generateImages.ts')),
  quote(`--slug=${slug}`), quote(`--account=${accountName}`)],
  { stdio: 'inherit', shell: true });

console.log('\n=== Done ===');
