/**
 * Builds one standalone blog prompt per architecture from the V1.3 master prompt.
 * Run: npm run browser:blog-structures
 * Re-run after editing V1.3 or src/agents/blogStructures.ts. The generated files are the prompts that get pasted into ChatGPT.
 */
import fs from 'node:fs';
import { BLOG_FORMATS, buildFormatPrompt } from '../agents/blogFormats.js';
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

fs.mkdirSync(STRUCTURES_DIR, { recursive: true });
for (const arch of ARCHITECTURES) {
  const middle =
    `Use the ARTICLE ARCHITECTURE below for this article. Do NOT create alternative structures and do NOT output this description.\n\n` +
    `${arch.block}\n\n` +
    `The architecture sets the order and purpose of the H2s. Every other rule in this prompt (H2 formula, word limits, paragraph rules, patterns, bolding, links, sourcing) still applies in full.\n`;
  let out = master.slice(0, startAt) + middle + master.slice(endAt + END.length);
  out = out.replace(FINAL_OLD, 'Follow the ARTICLE ARCHITECTURE given above.\n');
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
