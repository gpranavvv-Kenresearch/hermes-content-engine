import { z } from 'zod';
import { ConfigError } from '../errors.js';
import { PlatformIdSchema, type PlatformId } from '../schemas/index.js';

/**
 * Safety switches. Fail closed: dry_run and shadow_mode default to ON, a
 * garbage value is a startup error (never silently treated as "off"), and a
 * platform is disabled unless named in CE_PLATFORMS_ENABLED.
 */
export interface Flags {
  dryRun: boolean;
  shadowMode: boolean;
  enabledPlatforms: ReadonlySet<PlatformId>;
  maxChatGptCalls: number;
  maxRewriteRounds: number;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
}

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

function parseBool(name: string, value: string | undefined, fallback: boolean, issues: string[]): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  issues.push(`${name}: "${value}" is not a boolean (use true/false)`);
  return fallback;
}

function parseIntInRange(name: string, value: string | undefined, fallback: number, min: number, max: number, issues: string[]): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    issues.push(`${name}: "${value}" must be an integer between ${min} and ${max}`);
    return fallback;
  }
  return n;
}

const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

export function loadFlags(env: Record<string, string | undefined> = process.env): Flags {
  const issues: string[] = [];

  const dryRun = parseBool('CE_DRY_RUN', env.CE_DRY_RUN, true, issues);
  const shadowMode = parseBool('CE_SHADOW_MODE', env.CE_SHADOW_MODE, true, issues);
  const maxChatGptCalls = parseIntInRange('CE_MAX_CHATGPT_CALLS', env.CE_MAX_CHATGPT_CALLS, 50, 1, 10_000, issues);
  const maxRewriteRounds = parseIntInRange('CE_REWRITE_MAX_ROUNDS', env.CE_REWRITE_MAX_ROUNDS, 3, 0, 10, issues);

  const enabled = new Set<PlatformId>();
  for (const raw of (env.CE_PLATFORMS_ENABLED ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    const parsed = PlatformIdSchema.safeParse(raw);
    if (parsed.success) enabled.add(parsed.data);
    else issues.push(`CE_PLATFORMS_ENABLED: unknown platform "${raw}"`);
  }

  const level = LogLevelSchema.safeParse((env.CE_LOG_LEVEL ?? 'info').trim().toLowerCase());
  if (!level.success) issues.push(`CE_LOG_LEVEL: "${env.CE_LOG_LEVEL}" is not a valid level`);

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    dryRun,
    shadowMode,
    enabledPlatforms: enabled,
    maxChatGptCalls,
    maxRewriteRounds,
    logLevel: level.success ? level.data : 'info',
  };
}

/**
 * The only gate that may ever allow a real publish. False whenever dry_run or
 * shadow_mode is on, or the platform is not explicitly enabled. The engine
 * itself has no publishing code; this guard exists for any future adapter.
 */
export function canPublish(flags: Flags, platform: PlatformId): boolean {
  return !flags.dryRun && !flags.shadowMode && flags.enabledPlatforms.has(platform);
}

export function assertCanPublish(flags: Flags, platform: PlatformId): void {
  if (!canPublish(flags, platform)) {
    throw new ConfigError([
      `publishing to "${platform}" is blocked (dryRun=${flags.dryRun}, shadowMode=${flags.shadowMode}, enabled=${flags.enabledPlatforms.has(platform)})`,
    ]);
  }
}
