import type { LoadedConfig } from '../config/index.js';
import type { ClaimChecker } from '../contracts.js';
import type { PlatformId } from '../schemas/index.js';
import { validateText } from '../validation/index.js';

/**
 * Legacy audit: runs the NEW validators over posts the OLD pipeline already
 * produced, so the quality gap is measured on real data before any cutover.
 * It is read-only and never posts anything.
 *
 * Claims are NOT audited here (the facts behind legacy posts are unknown), so
 * numeric-claim problems are out of scope for this report and it says so.
 */

export interface LegacyPost {
  id: string;
  platform: PlatformId;
  text: string;
  reportUrl?: string;
}

export interface AuditedPost {
  id: string;
  platform: PlatformId;
  length: number;
  hardCodes: string[];
  reviewCodes: string[];
}

export interface CodeStat {
  severity: 'hard_fail' | 'review';
  count: number;
  platforms: Partial<Record<PlatformId, number>>;
  exampleIds: string[];
}

export interface AuditReport {
  generatedAt: string;
  configVersion: string;
  claimsAudited: false;
  total: number;
  passedHardChecks: number;
  hardFailPosts: number;
  byPlatform: Partial<Record<PlatformId, { total: number; hardFailPosts: number }>>;
  byCode: Record<string, CodeStat>;
  posts: AuditedPost[];
}

const NO_CLAIM_AUDIT: ClaimChecker = () => ({ issues: [], mappings: [] });
const MAX_EXAMPLES = 5;
const RECENT_WINDOW = 200;

export function auditLegacyPosts(
  posts: readonly LegacyPost[],
  config: LoadedConfig,
  options: { now?: () => Date } = {},
): AuditReport {
  const now = options.now ?? (() => new Date());
  const byCode: Record<string, CodeStat> = {};
  const byPlatform: AuditReport['byPlatform'] = {};
  const audited: AuditedPost[] = [];
  const seen: string[] = [];

  for (const post of posts) {
    const report = validateText(
      {
        draftId: `legacy_${audited.length}`,
        platform: post.platform,
        text: post.text,
        facts: [],
        recentTexts: seen.slice(-RECENT_WINDOW),
        claimChecker: NO_CLAIM_AUDIT,
        now,
      },
      config,
    );
    seen.push(post.text);

    const hardCodes = [...new Set(report.issues.filter((i) => i.severity === 'hard_fail').map((i) => i.code))];
    const reviewCodes = [...new Set(report.issues.filter((i) => i.severity === 'review').map((i) => i.code))];
    audited.push({ id: post.id, platform: post.platform, length: post.text.length, hardCodes, reviewCodes });

    const plat = (byPlatform[post.platform] ??= { total: 0, hardFailPosts: 0 });
    plat.total++;
    if (hardCodes.length > 0) plat.hardFailPosts++;

    for (const issue of report.issues) {
      const stat = (byCode[issue.code] ??= { severity: issue.severity, count: 0, platforms: {}, exampleIds: [] });
      stat.count++;
      stat.platforms[post.platform] = (stat.platforms[post.platform] ?? 0) + 1;
      if (stat.exampleIds.length < MAX_EXAMPLES && !stat.exampleIds.includes(post.id)) stat.exampleIds.push(post.id);
    }
  }

  const hardFailPosts = audited.filter((p) => p.hardCodes.length > 0).length;
  return {
    generatedAt: now().toISOString(),
    configVersion: config.version,
    claimsAudited: false,
    total: audited.length,
    passedHardChecks: audited.length - hardFailPosts,
    hardFailPosts,
    byPlatform,
    byCode,
    posts: audited,
  };
}

export function formatAuditMarkdown(report: AuditReport): string {
  const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);
  const lines: string[] = [
    '# Legacy audit',
    '',
    `Posts audited: ${report.total} (config ${report.configVersion})`,
    `Passed all hard checks: ${report.passedHardChecks} (${pct(report.passedHardChecks, report.total)})`,
    `With at least one hard failure: ${report.hardFailPosts} (${pct(report.hardFailPosts, report.total)})`,
    '',
    '_Numeric claims were NOT audited (the facts behind legacy posts are unknown)._',
    '',
    '## By platform',
    '| platform | posts | with hard failure |',
    '|---|---|---|',
    ...Object.entries(report.byPlatform).map(([p, s]) => `| ${p} | ${s!.total} | ${s!.hardFailPosts} (${pct(s!.hardFailPosts, s!.total)}) |`),
    '',
    '## By issue code',
    '| code | severity | count | example ids |',
    '|---|---|---|---|',
    ...Object.entries(report.byCode)
      .sort(([, a], [, b]) => (a.severity === b.severity ? b.count - a.count : a.severity === 'hard_fail' ? -1 : 1))
      .map(([code, s]) => `| ${code} | ${s.severity} | ${s.count} | ${s.exampleIds.join(', ')} |`),
  ];
  return lines.join('\n');
}

// --- Sheet export -> LegacyPost[] ---------------------------------------------------

export interface ColumnMap {
  x?: string;
  facebook?: string;
  linkedin?: string;
  url?: string;
  id?: string;
}

const COLUMN_ALIASES: Record<keyof ColumnMap, string[]> = {
  x: ['x post', 'tweet', 'x tweet', 'twitter post', 'x'],
  facebook: ['fb post', 'facebook post', 'facebook', 'fb'],
  linkedin: ['linkedin post', 'li post', 'linkedin', 'li'],
  url: ['url', 'report url', 'link', 'report link', 'ken research url'],
  id: ['id', 'row', 'no', '#'],
};

function findColumn(headers: string[], wanted: string | undefined, aliases: string[]): string | undefined {
  const lower = new Map(headers.map((h) => [h.trim().toLowerCase(), h] as const));
  if (wanted) return lower.get(wanted.trim().toLowerCase());
  for (const alias of aliases) {
    const hit = lower.get(alias);
    if (hit) return hit;
  }
  return undefined;
}

export interface MappedSheet {
  posts: LegacyPost[];
  matchedColumns: Partial<Record<keyof ColumnMap, string>>;
  warnings: string[];
}

/** Maps Sheet rows to LegacyPosts. Pass `columns` to name the exact headers; otherwise common names are guessed. */
export function mapSheetRows(rows: Array<Record<string, string>>, columns: ColumnMap = {}): MappedSheet {
  const headers = rows.length > 0 ? Object.keys(rows[0]!) : [];
  const matched: MappedSheet['matchedColumns'] = {};
  const warnings: string[] = [];
  for (const key of Object.keys(COLUMN_ALIASES) as Array<keyof ColumnMap>) {
    const found = findColumn(headers, columns[key], COLUMN_ALIASES[key]);
    if (found) matched[key] = found;
    else if (columns[key]) warnings.push(`column "${columns[key]}" for ${key} was not found in the export`);
  }

  const posts: LegacyPost[] = [];
  rows.forEach((row, index) => {
    const id = (matched.id ? row[matched.id] : undefined)?.trim() || `row-${index + 2}`;
    const reportUrl = matched.url ? row[matched.url]?.trim() : undefined;
    for (const platform of ['x', 'facebook', 'linkedin'] as const) {
      const col = matched[platform];
      const text = col ? row[col] : undefined;
      if (text && text.trim() !== '') {
        posts.push({ id: `${id}:${platform}`, platform, text, ...(reportUrl ? { reportUrl } : {}) });
      }
    }
  });
  if (!matched.x && !matched.facebook && !matched.linkedin) {
    warnings.push(`no post columns matched; headers seen: ${headers.join(' | ') || '(none)'}. Pass --col-x/--col-fb/--col-li.`);
  }
  return { posts, matchedColumns: matched, warnings };
}
