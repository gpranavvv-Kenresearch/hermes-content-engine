import type { LoadedConfig } from '../../config/index.js';
import type { PlatformId, PlatformLimit, ValidationIssue } from '../../schemas/index.js';
import { buildCompetitorDetector, type CompetitorDetector } from '../competitors.js';

/** Everything a pure check needs. Built once per validation run. */
export interface CheckContext {
  platform: PlatformId;
  config: LoadedConfig;
  limit: PlatformLimit;
  detector: CompetitorDetector;
  /**
   * The FINAL text as it would be posted (markdown bold converted to Unicode bold).
   * Checks read `text` (plain) for meaning; only the length check reads this,
   * because bold characters take two UTF-16 units each.
   */
  finalText?: string;
  /** Post layout id of the draft (see strategy/layouts.ts). Default: numbered-points. */
  layout?: string;
}

export type Check = (text: string, ctx: CheckContext) => ValidationIssue[];

const detectorCache = new WeakMap<object, CompetitorDetector>();

export function buildCheckContext(platform: PlatformId, config: LoadedConfig): CheckContext {
  let detector = detectorCache.get(config.competitors);
  if (!detector) {
    detector = buildCompetitorDetector(config.competitors);
    detectorCache.set(config.competitors, detector);
  }
  return { platform, config, limit: config.platformLimits[platform], detector };
}

export function issue(
  code: string,
  severity: ValidationIssue['severity'],
  message: string,
  detail?: Record<string, unknown>,
): ValidationIssue {
  return detail === undefined ? { code, severity, message } : { code, severity, message, detail };
}
