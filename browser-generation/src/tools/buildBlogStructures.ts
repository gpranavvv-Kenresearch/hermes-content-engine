/**
 * Builds one standalone blog prompt per architecture from the V1.3 master prompt.
 * Run: npm run browser:blog-structures
 * Re-run after editing V1.3 or src/agents/blogStructures.ts. The generated files are the prompts that get pasted into ChatGPT.
 */
import fs from 'node:fs';
import { BLOG_FORMATS, buildFormatPrompt, SHARE_DATA_RULE } from '../agents/blogFormats.js';
import { ARCHITECTURES, FORMATS_DIR, MASTER_V13_FILE, STRUCTURES_DIR, structureFile } from '../agents/blogStructures.js';

const raw = fs.readFileSync(MASTER_V13_FILE, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const master = raw.replace(/\r\n/g, '\n');

const START = 'Before writing, silently create THREE possible editorial structures.';
const END = 'Select ONE.\n';
const startAt = master.indexOf(START);
const endAt = master.indexOf(END, startAt);
if (startAt < 0 || endAt < 0) throw new Error('V1.3 no longer contains the "silently create THREE structures ... Select ONE." step; update buildBlogStructures.ts');

const FINAL_OLD = 'Silently create three possible market-specific structures.\n\nChoose the strongest structure.\n';
if (!master.includes(FINAL_OLD)) throw new Error('V1.3 no longer contains the closing "Silently create three ... Choose the strongest structure." lines; update buildBlogStructures.ts');

const IMAGE_DATA_EDITS: [string, string][] = [
  ['Choose approximately 5–7 supported metrics for the base set below,', `${SHARE_DATA_RULE}Choose 8 to 11 supported metrics (never fewer than 7 unless the report really has less) for the base set below,`],
  ['\n5–7 supported metrics, using the exact', '\n8 to 11 supported metrics, using the exact'],
];

fs.mkdirSync(STRUCTURES_DIR, { recursive: true });
for (const arch of ARCHITECTURES) {
  const middle =
    `Use the ARTICLE ARCHITECTURE below for this article. Do NOT create alternative structures and do NOT output this description.\n\n` +
    `${arch.block}\n\n` +
    `The architecture sets the order and purpose of the H2s. Every other rule in this prompt (H2 formula, word limits, paragraph rules, patterns, bolding, links, sourcing) still applies in full.\n`;
  let out = master.slice(0, startAt) + middle + master.slice(endAt + END.length);
  out = out.replace(FINAL_OLD, 'Follow the ARTICLE ARCHITECTURE given above.\n');
  // The live V1.3 file stays untouched; only these generated prompts ask for a fuller image data block.
  for (const [from, to] of IMAGE_DATA_EDITS) {
    if (!out.includes(from)) throw new Error(`V1.3 no longer contains "${from.slice(0, 50)}"; update IMAGE_DATA_EDITS in buildBlogStructures.ts`);
    out = out.replace(from, to);
  }
  fs.writeFileSync(structureFile(arch.id), out.replace(/\n/g, eol), 'utf8');
  console.log(`wrote ${structureFile(arch.id)} (${out.length} chars)`);
}

// Standalone formats: no V1.3 base, just fixed rules + the format's own shape + the output contract.
fs.mkdirSync(FORMATS_DIR, { recursive: true });
for (const format of BLOG_FORMATS) {
  const text = buildFormatPrompt(format);
  fs.writeFileSync(structureFile(format.id), text.replace(/\n/g, eol), 'utf8');
  console.log(`wrote ${structureFile(format.id)} (${text.length} chars)`);
}
