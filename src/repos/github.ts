import { EngineError } from '../errors.js';

/**
 * Reads a public GitHub repo for intake: metadata, README and the prompt-like files. Read-only and free
 * (the unauthenticated GitHub API allows 60 requests an hour; a GITHUB_TOKEN raises that). Only github.com
 * hosts are contacted, and nothing from here is ever treated as a fact for a post: it is reading material
 * for writing techniques.
 */

export interface RepoRef {
  owner: string;
  name: string;
  /** owner/name */
  id: string;
  url: string;
}

export function parseRepoUrl(input: string): RepoRef {
  const m = input.trim().match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (!m) throw new EngineError(`Not a GitHub repo URL: "${input}". Expected https://github.com/<owner>/<repo>.`, 'fatal', 'BAD_REPO_URL');
  const owner = m[1]!;
  const name = m[2]!;
  return { owner, name, id: `${owner}/${name}`, url: `https://github.com/${owner}/${name}` };
}

export interface RepoMeta {
  description: string;
  license: string | null;
  stars: number;
  language: string | null;
  archived: boolean;
  pushedAt: string;
  defaultBranch: string;
  topics: string[];
}

export interface RepoFacts {
  ref: RepoRef;
  meta: RepoMeta;
  readme: string;
  /** Prompt-like files that were read (path + text). */
  files: Array<{ path: string; text: string }>;
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const PROMPT_FILE_RE = /(^|\/)(prompts?|skills?|templates?|rules?|guidelines?)\/[^/]+\.(md|txt|ya?ml)$|(^|\/)SKILL\.md$|(^|\/)[^/]*(prompt|guideline|style)[^/]*\.(md|txt)$/i;
const MAX_FILES = 6;
const MAX_FILE_CHARS = 40_000;

export async function fetchRepoFacts(ref: RepoRef, fetchImpl: FetchLike = fetch as unknown as FetchLike, env: Record<string, string | undefined> = process.env): Promise<RepoFacts> {
  const headers: Record<string, string> = { 'User-Agent': 'content-engine-repo-intake', Accept: 'application/vnd.github+json' };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const api = async <T>(pathPart: string, accept?: string): Promise<T> => {
    const res = await fetchImpl(`https://api.github.com/repos/${ref.owner}/${ref.name}${pathPart}`, { headers: accept ? { ...headers, Accept: accept } : headers });
    if (!res.ok) {
      const rate = res.status === 403 || res.status === 429;
      throw new EngineError(
        `GitHub returned ${res.status} for ${ref.id}${pathPart}${rate ? ' (rate limit: set GITHUB_TOKEN or wait an hour)' : res.status === 404 ? ' (repo not found or private)' : ''}`,
        rate ? 'rate_limited' : 'fatal',
        'GITHUB_HTTP',
        { detail: { status: res.status } },
      );
    }
    return (accept ? ((await res.text()) as unknown) : await res.json()) as T;
  };

  const raw = await api<{
    description: string | null;
    license: { spdx_id: string | null } | null;
    stargazers_count: number;
    language: string | null;
    archived: boolean;
    pushed_at: string;
    default_branch: string;
    topics?: string[];
  }>('');
  const meta: RepoMeta = {
    description: raw.description ?? '',
    license: raw.license?.spdx_id ?? null,
    stars: raw.stargazers_count,
    language: raw.language,
    archived: raw.archived,
    pushedAt: raw.pushed_at,
    defaultBranch: raw.default_branch,
    topics: raw.topics ?? [],
  };

  const readme = await api<string>('/readme', 'application/vnd.github.raw').catch(() => '');

  const files: Array<{ path: string; text: string }> = [];
  try {
    const tree = await api<{ tree: Array<{ path: string; type: string; size?: number }> }>(`/git/trees/${encodeURIComponent(meta.defaultBranch)}?recursive=1`);
    const wanted = tree.tree.filter((t) => t.type === 'blob' && PROMPT_FILE_RE.test(t.path) && (t.size ?? 0) < 200_000).slice(0, MAX_FILES);
    for (const f of wanted) {
      const res = await fetchImpl(`https://raw.githubusercontent.com/${ref.owner}/${ref.name}/${encodeURIComponent(meta.defaultBranch)}/${f.path}`, { headers: { 'User-Agent': headers['User-Agent']! } });
      if (res.ok) files.push({ path: f.path, text: (await res.text()).slice(0, MAX_FILE_CHARS) });
    }
  } catch {
    // a missing tree or a rate limit on it only means fewer files; the README is still reviewed
  }
  return { ref, meta, readme: readme.slice(0, MAX_FILE_CHARS), files };
}
