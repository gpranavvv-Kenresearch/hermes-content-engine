import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { toPlain } from '../utils/bold.js';

/**
 * Style library: posts the team has curated (industry leaders' posts, the house reference post) used
 * ONLY for style: rhythm, hook shape, paragraph length, clarity. Nothing is scraped; the files are put
 * in the folder by a person. The prompt tells the model never to copy wording, names, facts or figures.
 */

export interface StyleLibrary {
  dir: string;
  examples: string[];
  files: string[];
}

export const DEFAULT_STYLE_DIR = 'config/style-examples';

function truncateAtParagraph(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n\n');
  return (lastBreak > maxChars * 0.5 ? cut.slice(0, lastBreak) : cut).trim();
}

/**
 * Reads up to `max` *.txt files (alphabetical) from `dir`. Each is flattened to plain text (bold
 * and spacer characters removed), links are replaced with "[source link]", and long posts are cut at
 * a paragraph boundary. A missing or empty folder yields no examples (the plan then records the
 * style-library step as skipped, with the reason).
 */
export function loadStyleExamples(dir: string = DEFAULT_STYLE_DIR, options: { max?: number; maxChars?: number } = {}): StyleLibrary {
  const resolved = path.resolve(dir);
  const max = options.max ?? 3;
  const maxChars = options.maxChars ?? 1600;
  if (!existsSync(resolved)) return { dir: resolved, examples: [], files: [] };

  const files = readdirSync(resolved)
    .filter((f) => f.toLowerCase().endsWith('.txt'))
    .sort();
  const examples: string[] = [];
  const used: string[] = [];
  for (const file of files) {
    if (examples.length >= max) break; // `max` counts usable examples, not files
    const raw = readFileSync(path.join(resolved, file), 'utf8');
    const text = truncateAtParagraph(
      toPlain(raw)
        .replace(/https?:\/\/\S+/g, '[source link]')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
      maxChars,
    );
    if (text.length >= 80) {
      examples.push(text);
      used.push(file);
    }
  }
  return { dir: resolved, examples, files: used };
}
