import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EngineError } from '../errors.js';
import type { CompetitorDetector } from '../validation/competitors.js';
import { fetchRepoFacts, parseRepoUrl, type FetchLike, type RepoFacts, type RepoRef } from './github.js';
import {
  assessLicense,
  classifyUse,
  extractCandidates,
  scanRisks,
  type Candidate,
  type LicenseVerdict,
  type Risk,
  type UseKind,
} from './policy.js';
import { DEFAULT_REGISTRY_PATH, findRepo, loadRegistry, saveRegistry, upsertRepo } from './registry.js';
import { DEFAULT_TECHNIQUES_DIR, readTechniqueFile, saveTechniqueFile, type Technique } from './techniques.js';

export const DEFAULT_INTAKE_DIR = 'output/repo-intake';

export interface IntakeReport {
  repo: string;
  url: string;
  description: string;
  stars: number;
  language: string | null;
  pushedAt: string;
  license: LicenseVerdict;
  risks: Risk[];
  usefulFor: Array<{ use: UseKind; hits: number }>;
  warnings: string[];
  candidates: Candidate[];
  recommendation: string;
  filesRead: string[];
  createdAt: string;
}

export interface IntakeDeps {
  fetchImpl?: FetchLike;
  detector?: CompetitorDetector;
  registryPath?: string;
  outDir?: string;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

const TWO_YEARS_MS = 2 * 365 * 24 * 3600 * 1000;

/** Pure part of intake: turns what was read from a repo into a verdict. */
export function buildReport(facts: RepoFacts, detector: CompetitorDetector | undefined, now: Date): IntakeReport {
  const texts = [facts.readme, ...facts.files.map((f) => f.text)];
  const all = texts.join('\n');
  const license = assessLicense(facts.meta.license);
  const risks = scanRisks(all, detector);
  const warnings: string[] = [];
  if (facts.meta.archived) warnings.push('The repo is archived: no further updates.');
  const pushed = new Date(facts.meta.pushedAt).getTime();
  if (Number.isFinite(pushed) && now.getTime() - pushed > TWO_YEARS_MS) warnings.push(`Last push ${facts.meta.pushedAt.slice(0, 10)}: more than two years ago.`);
  if (facts.files.length === 0) warnings.push('No prompt or guideline files found: candidates come from the README only.');
  if (facts.readme.trim().length === 0) warnings.push('No README could be read.');

  const candidates = extractCandidates(texts, detector);
  const usable = candidates.filter((c) => !c.blocked).length;

  const parts: string[] = [];
  if (risks.some((r) => r.code === 'PAID_SERVICE')) parts.push('the tool itself needs a paid service, so only its ideas are usable');
  if (risks.some((r) => r.code === 'FABRICATION')) parts.push('techniques that add figures, quotes or sources must be adapted to real, verified ones (the blocked ones cannot be adopted as written)');
  if (!license.verbatimOk) parts.push('put every adopted technique in your own words (--text), do not copy its text');
  const recommendation =
    usable === 0
      ? 'Nothing adoptable was found automatically. Read the repo by hand and add techniques in your own words with --text, or mark it reviewed/rejected.'
      : `${usable} candidate technique(s) can be adopted${parts.length ? '; note: ' + parts.join('; ') : ''}.`;

  return {
    repo: facts.ref.id,
    url: facts.ref.url,
    description: facts.meta.description,
    stars: facts.meta.stars,
    language: facts.meta.language,
    pushedAt: facts.meta.pushedAt,
    license,
    risks,
    usefulFor: classifyUse(all),
    warnings,
    candidates,
    recommendation,
    filesRead: facts.files.map((f) => f.path),
    createdAt: now.toISOString(),
  };
}

export function formatReport(r: IntakeReport): string {
  const lines: string[] = [];
  lines.push(`# Repo intake: ${r.repo}`, '', `${r.url}`, r.description ? `\n${r.description}` : '', '');
  lines.push(`- License: ${r.license.spdx ?? 'none'} (${r.license.level}). ${r.license.note}`);
  lines.push(`- Language: ${r.language ?? 'n/a'}; stars: ${r.stars}; last push: ${r.pushedAt.slice(0, 10)}`);
  lines.push(`- Useful for: ${r.usefulFor.map((u) => `${u.use} (${u.hits})`).join(', ') || 'unclear'}`);
  lines.push(`- Files read: ${r.filesRead.length > 0 ? r.filesRead.join(', ') : 'README only'}`, '');
  for (const w of r.warnings) lines.push(`WARNING: ${w}`);
  for (const k of r.risks) lines.push(`RISK ${k.code}: ${k.message}${k.examples.length ? ` e.g. "${k.examples[0]}"` : ''}`);
  lines.push('', `Recommendation: ${r.recommendation}`, '', '## Candidate techniques', '');
  for (const c of r.candidates) lines.push(`${String(c.n).padStart(2)}. ${c.blocked ? `[BLOCKED: ${c.blocked}] ` : ''}${c.text}`);
  lines.push('', 'Adopt with:  npm run repo:adopt -- --repo ' + r.repo + ' --pick 1,3 --for linkedin,facebook,x,blog');
  return lines.join('\n');
}

const reportPaths = (outDir: string, repoId: string): { json: string; md: string } => {
  const base = path.join(path.resolve(outDir), repoId.replace('/', '__'));
  return { json: `${base}.json`, md: `${base}.md` };
};

/** Fetches a repo, writes the report, and records it in the registry as pending (an existing decision is kept). */
export async function runIntake(url: string, deps: IntakeDeps = {}): Promise<IntakeReport> {
  const ref = parseRepoUrl(url);
  const now = deps.now?.() ?? new Date();
  const facts = await fetchRepoFacts(ref, deps.fetchImpl, deps.env);
  const report = buildReport(facts, deps.detector, now);

  const out = reportPaths(deps.outDir ?? DEFAULT_INTAKE_DIR, ref.id);
  mkdirSync(path.dirname(out.json), { recursive: true });
  writeFileSync(out.json, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(out.md, formatReport(report), 'utf8');

  const registryPath = deps.registryPath ?? DEFAULT_REGISTRY_PATH;
  const registry = loadRegistry(registryPath);
  const existing = findRepo(registry, ref.id);
  saveRegistry(
    upsertRepo(registry, {
      id: ref.id,
      url: ref.url,
      license: report.license.spdx,
      status: existing?.status ?? 'pending',
      usefulFor: report.usefulFor.slice(0, 3).map((u) => u.use),
      adopted: existing?.adopted ?? [],
      notes: existing?.notes || report.recommendation,
      reviewedAt: now.toISOString().slice(0, 10),
    }),
    registryPath,
  );
  return report;
}

export interface AdoptInput {
  repoId: string;
  /** Candidate numbers from the intake report. */
  picks: number[];
  /** Platform ids or "all". */
  appliesTo: string[];
  /** Own wording for a single pick (required unless the license allows verbatim). */
  text?: string;
}

export interface AdoptDeps {
  registryPath?: string;
  outDir?: string;
  techniquesDir?: string;
  now?: () => Date;
}

/** Turns picked candidates of an intake report into technique entries that prompts will use. */
export function adoptCandidates(input: AdoptInput, deps: AdoptDeps = {}): { file: string; adopted: string[] } {
  const reportFile = reportPaths(deps.outDir ?? DEFAULT_INTAKE_DIR, input.repoId).json;
  let report: IntakeReport;
  try {
    report = JSON.parse(readFileSync(reportFile, 'utf8')) as IntakeReport;
  } catch {
    throw new EngineError(`No intake report for ${input.repoId}. Run: npm run repo:intake -- --url https://github.com/${input.repoId}`, 'fatal', 'NO_INTAKE_REPORT');
  }
  if (input.picks.length === 0 && input.text === undefined) throw new EngineError('Pick at least one candidate number (--pick 1,3), or give your own wording with --text.', 'fatal', 'NO_PICK');
  if (input.text !== undefined && input.picks.length > 1) throw new EngineError('--text is ONE technique in your own wording; pass at most one --pick with it.', 'fatal', 'TEXT_NEEDS_ONE_PICK');

  const techniques: Technique[] = [];
  if (input.picks.length === 0 && input.text !== undefined) {
    // No candidate to start from (for example a README with no rule lines): the technique is your own wording.
    techniques.push({ id: `${input.repoId.replace('/', '__')}-own-${Date.now().toString(36)}`, text: input.text.trim(), appliesTo: input.appliesTo });
  }
  for (const n of input.picks) {
    const c = report.candidates.find((x) => x.n === n);
    if (!c) throw new EngineError(`No candidate #${n} in the report for ${input.repoId}.`, 'fatal', 'BAD_PICK');
    if (c.blocked && input.text === undefined) throw new EngineError(`Candidate #${n} is blocked (${c.blocked}). Adapt it with --text in wording that uses only verified facts, or leave it out.`, 'fatal', 'BLOCKED_PICK');
    if (!report.license.verbatimOk && input.text === undefined) {
      throw new EngineError(`${input.repoId} is ${report.license.spdx ?? 'unlicensed'}: its wording cannot be copied. Re-run with a single --pick and --text "<your own wording>".`, 'fatal', 'VERBATIM_NOT_ALLOWED');
    }
    techniques.push({ id: `${input.repoId.replace('/', '__')}-${n}`, text: (input.text ?? c.text).trim(), appliesTo: input.appliesTo });
  }

  const now = deps.now?.() ?? new Date();
  // Adopting more from the same repo adds to what is already there; an identical technique is not duplicated.
  const techniquesDir = deps.techniquesDir ?? DEFAULT_TECHNIQUES_DIR;
  const before = readTechniqueFile(input.repoId, techniquesDir)?.techniques ?? [];
  const known = new Set(before.map((t) => t.text.toLowerCase()));
  const merged = [...before, ...techniques.filter((t) => !known.has(t.text.toLowerCase()))];
  const file = saveTechniqueFile(
    { repo: input.repoId, url: report.url, license: report.license.spdx, adoptedAt: now.toISOString().slice(0, 10), techniques: merged },
    techniquesDir,
  );

  const registryPath = deps.registryPath ?? DEFAULT_REGISTRY_PATH;
  const registry = loadRegistry(registryPath);
  const existing = findRepo(registry, input.repoId);
  const adopted = techniques.map((t) => t.text);
  saveRegistry(
    upsertRepo(registry, {
      id: input.repoId,
      url: report.url,
      license: report.license.spdx,
      status: 'ideas-adopted',
      usefulFor: existing?.usefulFor ?? report.usefulFor.slice(0, 3).map((u) => u.use),
      adopted: [...new Set([...(existing?.adopted ?? []), ...adopted])],
      notes: existing?.notes && existing.status === 'ideas-adopted' ? existing.notes : `${techniques.length} technique(s) adopted for ${input.appliesTo.join(', ')}.`,
      reviewedAt: now.toISOString().slice(0, 10),
    }),
    registryPath,
  );
  return { file, adopted };
}

export { parseRepoUrl, type RepoRef };
