import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Registry of every repo we looked at and what became of it. One line per repo in `config/repos/registry.json`,
 * kept in git so "which repos do we use, and for what" always has an answer.
 *
 *   pending        intake ran, nobody decided yet
 *   reviewed       read, nothing taken (reason in `notes`)
 *   ideas-adopted  techniques or checks written in our own words (see `adopted`)
 *   rejected       will not be used (reason in `notes`)
 */
export const RepoStatusSchema = z.enum(['pending', 'reviewed', 'ideas-adopted', 'rejected']);
export type RepoStatus = z.infer<typeof RepoStatusSchema>;

export const RepoEntrySchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  license: z.string().nullable(),
  status: RepoStatusSchema,
  /** post, blog, seo, geo, keywords */
  usefulFor: z.array(z.string()),
  /** What we actually took (our own words). */
  adopted: z.array(z.string()),
  notes: z.string(),
  reviewedAt: z.string(),
});
export type RepoEntry = z.infer<typeof RepoEntrySchema>;

export const RegistrySchema = z.object({ repos: z.array(RepoEntrySchema) });
export type Registry = z.infer<typeof RegistrySchema>;

export const DEFAULT_REGISTRY_PATH = 'config/repos/registry.json';

export function loadRegistry(file: string = DEFAULT_REGISTRY_PATH): Registry {
  const resolved = path.resolve(file);
  if (!existsSync(resolved)) return { repos: [] };
  return RegistrySchema.parse(JSON.parse(readFileSync(resolved, 'utf8')));
}

export function saveRegistry(registry: Registry, file: string = DEFAULT_REGISTRY_PATH): void {
  const resolved = path.resolve(file);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(RegistrySchema.parse(registry), null, 2)}\n`, 'utf8');
}

/** Insert or replace by id (case-insensitive). */
export function upsertRepo(registry: Registry, entry: RepoEntry): Registry {
  const key = entry.id.toLowerCase();
  const others = registry.repos.filter((r) => r.id.toLowerCase() !== key);
  return { repos: [...others, entry].sort((a, b) => a.id.localeCompare(b.id)) };
}

/** Records a decision on a repo (status and a note). The repo must already have been through intake or be in the registry. */
export function markRepo(registry: Registry, id: string, status: RepoStatus, note: string, now: Date = new Date()): Registry {
  const existing = findRepo(registry, id);
  if (!existing) throw new Error(`"${id}" is not in the registry. Run repo:intake for it first.`);
  return upsertRepo(registry, { ...existing, status, notes: note.trim() || existing.notes, reviewedAt: now.toISOString().slice(0, 10) });
}

export function findRepo(registry: Registry, id: string): RepoEntry | undefined {
  return registry.repos.find((r) => r.id.toLowerCase() === id.toLowerCase());
}

export function formatRegistry(registry: Registry): string {
  if (registry.repos.length === 0) return 'No repos registered yet. Add one with: npm run repo:intake -- --url <github url>';
  return registry.repos
    .map((r) => `${r.status.padEnd(13)} ${r.id}  [${r.license ?? 'no license'}]  useful for: ${r.usefulFor.join(', ') || 'n/a'}\n${' '.repeat(14)}${r.notes}`)
    .join('\n');
}
