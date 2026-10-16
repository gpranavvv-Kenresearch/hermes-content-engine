import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { PlatformId } from '../schemas/index.js';

/**
 * Techniques: short writing rules taken (in our own words, or verbatim from a permissive license) from a
 * repo someone gave us, stored in `config/techniques/<owner>__<repo>.json` and shown to the model as a
 * "WRITING TECHNIQUES" section. They steer structure and wording only: the prompt states that a technique
 * never lets the model add a figure, quote, source or claim that is not in the facts.
 */

export const TechniqueSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(10).max(260),
  /** Platform ids, or "all". */
  appliesTo: z.array(z.string().min(1)).min(1),
});
export type Technique = z.infer<typeof TechniqueSchema>;

export const TechniqueFileSchema = z.object({
  repo: z.string().min(1),
  url: z.string().min(1),
  license: z.string().nullable(),
  adoptedAt: z.string(),
  techniques: z.array(TechniqueSchema),
});
export type TechniqueFile = z.infer<typeof TechniqueFileSchema>;

export const DEFAULT_TECHNIQUES_DIR = 'config/techniques';

export const fileNameFor = (repoId: string): string => `${repoId.replace('/', '__')}.json`;

export function saveTechniqueFile(file: TechniqueFile, dir: string = DEFAULT_TECHNIQUES_DIR): string {
  const resolved = path.resolve(dir);
  mkdirSync(resolved, { recursive: true });
  const target = path.join(resolved, fileNameFor(file.repo));
  writeFileSync(target, `${JSON.stringify(TechniqueFileSchema.parse(file), null, 2)}\n`, 'utf8');
  return target;
}

/** The technique file already saved for a repo, if any. */
export function readTechniqueFile(repoId: string, dir: string = DEFAULT_TECHNIQUES_DIR): TechniqueFile | undefined {
  const target = path.join(path.resolve(dir), fileNameFor(repoId));
  if (!existsSync(target)) return undefined;
  const parsed = TechniqueFileSchema.safeParse(JSON.parse(readFileSync(target, 'utf8')));
  return parsed.success ? parsed.data : undefined;
}

export interface LoadedTechniques {
  dir: string;
  /** Techniques that apply to the platform, with the repo they came from. */
  items: Array<{ text: string; repo: string }>;
  files: string[];
}

/** Techniques for one platform (max `max`, in file order). A missing folder gives none. */
export function loadTechniques(platform: PlatformId, dir: string = DEFAULT_TECHNIQUES_DIR, max = 8): LoadedTechniques {
  const resolved = path.resolve(dir);
  if (!existsSync(resolved)) return { dir: resolved, items: [], files: [] };
  const items: LoadedTechniques['items'] = [];
  const files: string[] = [];
  for (const name of readdirSync(resolved).filter((f) => f.endsWith('.json')).sort()) {
    const parsed = TechniqueFileSchema.safeParse(JSON.parse(readFileSync(path.join(resolved, name), 'utf8')));
    if (!parsed.success) continue;
    let used = false;
    for (const t of parsed.data.techniques) {
      if (items.length >= max) break;
      if (t.appliesTo.includes('all') || t.appliesTo.includes(platform)) {
        items.push({ text: t.text, repo: parsed.data.repo });
        used = true;
      }
    }
    if (used) files.push(name);
  }
  return { dir: resolved, items, files };
}
