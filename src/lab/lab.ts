import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LoadedConfig } from '../config/index.js';
import type { ClaimChecker } from '../contracts.js';
import { EngineError } from '../errors.js';
import { parseRepoUrl } from '../repos/github.js';
import type { Fact, PlatformId, SourceNote } from '../schemas/index.js';
import { selectBriefFacts } from '../strategy/brief-builder.js';
import { sanityReport, type SanityRow } from '../validation/checks/content-sanity.js';
import { REMEDIATION, validateText } from '../validation/validate-draft.js';
/**
 * The lab (`github-seo/`): a sandbox where a repo someone gives us runs AS IT IS, outside the engine's own
 * pipeline, and its output is then judged by the engine's own checks.
 *
 *   github-seo/repos/<owner>__<repo>/   the clone (git-ignored)
 *   github-seo/results/<owner>__<repo>/ run logs and checked outputs (git-ignored)
 *   github-seo/lab.json                 which repos are in the lab and how to run them
 *
 * Nothing here installs or runs a repo by itself: every run is a command you type. A run gets a SCRUBBED
 * environment: none of our API keys reach a third-party repo unless you name them with --env.
 */

export const LAB_DIR = 'github-seo';

export interface LabEntry {
  id: string;
  url: string;
  dir: string;
  clonedAt: string;
  /** What the repo itself says about running it (read from package.json / requirements / README). */
  hints: string[];
}

export interface LabIndex {
  repos: LabEntry[];
}

const indexPath = (lab: string): string => path.join(path.resolve(lab), 'lab.json');
/** Folder name for a repo. Capped at 40 characters: this project sits deep inside OneDrive and Windows paths stop working near 260 characters. */
export const repoDirName = (repoId: string): string => repoId.replace('/', '__').slice(0, 40);

export function loadLab(lab: string = LAB_DIR): LabIndex {
  const file = indexPath(lab);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as LabIndex) : { repos: [] };
}

function saveLab(index: LabIndex, lab: string): void {
  mkdirSync(path.resolve(lab), { recursive: true });
  writeFileSync(indexPath(lab), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
}

export function findLabRepo(index: LabIndex, id: string): LabEntry | undefined {
  return index.repos.find((r) => r.id.toLowerCase() === id.toLowerCase());
}

// --- run hints ---------------------------------------------------------------------------------

/** How the repo says it is run: npm scripts, python requirements, docker compose, README quick-start lines. */
export function detectRunHints(dir: string): string[] {
  const hints: string[] = [];
  const pkg = path.join(dir, 'package.json');
  if (existsSync(pkg)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
      hints.push('Node project: `npm install` first');
      for (const name of ['dev', 'start', 'build']) if (scripts[name]) hints.push(`npm script "${name}": ${scripts[name]}`);
    } catch {
      hints.push('package.json present but unreadable');
    }
  }
  if (existsSync(path.join(dir, 'requirements.txt')) || existsSync(path.join(dir, 'pyproject.toml'))) hints.push('Python project: create a venv and install requirements first');
  if (['docker-compose.yml', 'docker-compose.yaml', 'compose.yml'].some((f) => existsSync(path.join(dir, f)))) hints.push('Has a docker compose file (needs Docker)');
  if (existsSync(path.join(dir, '.env.example'))) hints.push('Has .env.example: it needs keys you must supply with --env');
  for (const readme of ['README.md', 'readme.md']) {
    const file = path.join(dir, readme);
    if (!existsSync(file)) continue;
    const quick = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => /^\s*(npm|npx|pnpm|yarn|pip|python3?|docker|node)\s+\S+/.test(l.trim()))
      .slice(0, 5)
      .map((l) => l.trim());
    for (const q of quick) hints.push(`README: ${q}`);
    break;
  }
  return hints;
}

// --- environment scrubbing -----------------------------------------------------------------------------

const SAFE_ENV = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramData', 'LANG', 'TERM'];

/** The only environment a third-party repo sees: the OS basics, plus the variables you name (copied from ours). */
export function scrubbedEnv(base: Record<string, string | undefined>, allow: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [...SAFE_ENV, ...allow]) {
    const value = base[key];
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

// --- add / run --------------------------------------------------------------------------------------------

export type ExecFn = (command: string, args: string[], options: { cwd?: string; env?: Record<string, string>; shell?: boolean; timeoutMs?: number; logFile?: string }) => Promise<{ code: number | null; output: string }>;

/** Default executor: spawn, tee output to the log file, kill after the timeout. */
export const defaultExec: ExecFn = (command, args, { cwd, env, shell, timeoutMs = 600_000, logFile }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: env ?? (process.env as Record<string, string>), shell: shell ?? false, windowsHide: true });
    const log = logFile ? createWriteStream(logFile, { flags: 'a' }) : undefined;
    let output = '';
    const take = (d: Buffer): void => {
      const s = d.toString();
      output += s;
      log?.write(s);
      process.stdout.write(s);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      child.kill();
      take(Buffer.from(`\n[lab] killed after ${Math.round(timeoutMs / 1000)}s\n`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      log?.end();
      resolve({ code, output });
    });
  });

export interface LabDeps {
  lab?: string;
  exec?: ExecFn;
  now?: () => Date;
}

/** Shallow-clones a GitHub repo into the lab. Does not install, build or run anything. */
export async function addRepo(url: string, deps: LabDeps = {}): Promise<LabEntry> {
  const lab = deps.lab ?? LAB_DIR;
  const exec = deps.exec ?? defaultExec;
  const ref = parseRepoUrl(url);
  const dir = path.join(path.resolve(lab), 'repos', repoDirName(ref.id));
  if (existsSync(dir)) throw new EngineError(`${ref.id} is already in the lab (${dir}). Delete that folder to clone it again.`, 'fatal', 'LAB_EXISTS');
  mkdirSync(path.dirname(dir), { recursive: true });
  const result = await exec('git', ['-c', 'core.longpaths=true', 'clone', '--depth', '1', '--', `${ref.url}.git`, dir], { timeoutMs: 300_000 });
  if (result.code !== 0) throw new EngineError(`git clone failed for ${ref.id} (exit ${result.code}).`, 'fatal', 'LAB_CLONE', { detail: { output: result.output.slice(-400) } });
  const entry: LabEntry = { id: ref.id, url: ref.url, dir, clonedAt: (deps.now?.() ?? new Date()).toISOString(), hints: detectRunHints(dir) };
  const index = loadLab(lab);
  saveLab({ repos: [...index.repos.filter((r) => r.id.toLowerCase() !== ref.id.toLowerCase()), entry] }, lab);
  return entry;
}

/** Runs ONE command you typed inside a lab repo, with a scrubbed environment, logging to github-seo/results/. */
export async function runInRepo(repoId: string, command: string, options: { allowEnv?: string[]; timeoutMs?: number; baseEnv?: Record<string, string | undefined> } = {}, deps: LabDeps = {}): Promise<{ code: number | null; log: string }> {
  const lab = deps.lab ?? LAB_DIR;
  const entry = findLabRepo(loadLab(lab), repoId);
  if (!entry) throw new EngineError(`${repoId} is not in the lab. Add it with: npm run lab:add -- --url https://github.com/${repoId}`, 'fatal', 'LAB_UNKNOWN');
  const resultsDir = path.join(path.resolve(lab), 'results', repoDirName(entry.id));
  mkdirSync(resultsDir, { recursive: true });
  const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(resultsDir, `run-${stamp}.log`);
  writeFileSync(logFile, `$ ${command}\n(env passed through: ${(options.allowEnv ?? []).join(', ') || 'none beyond OS basics'})\n\n`, 'utf8');
  const exec = deps.exec ?? defaultExec;
  const result = await exec(command, [], { cwd: entry.dir, env: scrubbedEnv(options.baseEnv ?? process.env, options.allowEnv ?? []), shell: true, timeoutMs: options.timeoutMs ?? 600_000, logFile });
  return { code: result.code, log: logFile };
}

// --- judging an output with the engine's own checks ------------------------------------------------------------

export interface LabCheckInput {
  repoId: string;
  platform: PlatformId;
  text: string;
  facts: readonly Fact[];
  notes?: readonly SourceNote[];
  layout?: string;
}

export interface LabCheckResult {
  repo: string;
  platform: PlatformId;
  chars: number;
  /** True when no hard-fail issue was found: the engine could have shipped this text. */
  wouldPass: boolean;
  hard: Array<{ code: string; message: string; fixable: boolean }>;
  review: Array<{ code: string; message: string }>;
  sanity: SanityRow[];
  usableFacts: number;
}

/** Runs a text from any source through the engine's validation (no fixers, so you see the raw compliance). */
export function checkLabOutput(input: LabCheckInput, config: LoadedConfig, claimChecker: ClaimChecker): LabCheckResult {
  const usable = selectBriefFacts(input.facts);
  const noteTexts = (input.notes ?? []).map((n) => n.text);
  const report = validateText(
    { draftId: `lab_${input.repoId}`, platform: input.platform, text: input.text, facts: usable, notes: noteTexts, recentTexts: [], claimChecker, ...(input.layout ? { layout: input.layout } : {}) },
    config,
  );
  const hard = report.issues.filter((i) => i.severity === 'hard_fail').map((i) => ({ code: i.code, message: i.message, fixable: REMEDIATION[i.code] === 'auto_fix' }));
  const review = report.issues.filter((i) => i.severity === 'review').map((i) => ({ code: i.code, message: i.message }));
  return {
    repo: input.repoId,
    platform: input.platform,
    chars: input.text.length,
    wouldPass: hard.length === 0,
    hard,
    review,
    sanity: sanityReport(input.text, usable, noteTexts),
    usableFacts: usable.length,
  };
}

/** Saves the checked text and its verdict under github-seo/results/<repo>/. */
export function saveLabCheck(result: LabCheckResult, text: string, deps: LabDeps = {}): string {
  const dir = path.join(path.resolve(deps.lab ?? LAB_DIR), 'results', repoDirName(result.repo));
  mkdirSync(dir, { recursive: true });
  const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
  writeFileSync(path.join(dir, `check-${stamp}.txt`), text, 'utf8');
  const file = path.join(dir, `check-${stamp}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
  return file;
}

export function formatLabCheck(r: LabCheckResult): string {
  const lines = [`${r.repo} -> ${r.platform}: ${r.chars} chars, ${r.usableFacts} verified fact(s) available`, `VERDICT: ${r.wouldPass ? 'the engine would accept this text' : 'the engine would REJECT this text'}`];
  for (const h of r.hard) lines.push(`  FAIL  ${h.code}${h.fixable ? ' (auto-fixable)' : ''}: ${h.message}`);
  for (const w of r.review) lines.push(`  WARN  ${w.code}: ${w.message}`);
  if (r.hard.length === 0 && r.review.length === 0) lines.push('  no issues found');
  lines.push('  content sanity: ' + r.sanity.map((s) => `${s.status === 'pass' ? 'ok' : s.status.toUpperCase()} ${s.code}`).join(', '));
  return lines.join('\n');
}

