import { ConfigError } from '../errors.js';
import {
  BrandConfigSchema,
  CampaignSchema,
  CompetitorListSchema,
  PersonaSchema,
  PlatformIdSchema,
  PlatformLimitsSchema,
  PromptVersionsSchema,
  SourcePolicySchema,
  UtmTableSchema,
  type BrandConfig,
  type Campaign,
  type CompetitorEntry,
  type Persona,
  type PlatformLimits,
  type PromptVersions,
  type SourcePolicy,
  type UtmEntry,
} from '../schemas/index.js';
import { shortHash } from '../utils/hash.js';
import { normalizeForMatch } from '../utils/normalize.js';
import { brandConfig } from './brand.config.js';
import { campaigns } from './campaign.config.js';
import { competitors } from './competitors.config.js';
import { personas } from './persona.config.js';
import { platformLimits } from './platform-limits.config.js';
import { promptVersions } from './prompt-versions.config.js';
import { sourcePolicy } from './source-policy.config.js';
import { utmTable } from './utm.config.js';

export interface RawConfig {
  brand: unknown;
  competitors: unknown;
  sourcePolicy: unknown;
  platformLimits: unknown;
  campaigns: unknown;
  personas: unknown;
  prompts: unknown;
  utm: unknown;
}

export interface LoadedConfig {
  brand: BrandConfig;
  competitors: CompetitorEntry[];
  sourcePolicy: SourcePolicy;
  platformLimits: PlatformLimits;
  campaigns: Campaign[];
  personas: Persona[];
  prompts: PromptVersions;
  utm: Record<string, UtmEntry>;
  /** Short content hash of the whole validated config; stamped on every draft. */
  version: string;
}

export const defaultRawConfig: RawConfig = {
  brand: brandConfig,
  competitors,
  sourcePolicy,
  platformLimits,
  campaigns,
  personas,
  prompts: promptVersions,
  utm: utmTable,
};

const PLAIN_HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

function zodIssues(label: string, error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] {
  return error.issues.map((i) => `${label}${i.path.length ? `.${i.path.map(String).join('.')}` : ''}: ${i.message}`);
}

/**
 * Validates every config block with Zod, then runs cross-checks that no single
 * schema can express. Collects ALL problems and throws one ConfigError, so a
 * bad config fails startup with a complete, useful message.
 */
export function loadConfigFrom(raw: RawConfig): LoadedConfig {
  const issues: string[] = [];

  const parsed = {
    brand: BrandConfigSchema.safeParse(raw.brand),
    competitors: CompetitorListSchema.safeParse(raw.competitors),
    sourcePolicy: SourcePolicySchema.safeParse(raw.sourcePolicy),
    platformLimits: PlatformLimitsSchema.safeParse(raw.platformLimits),
    campaigns: CampaignSchema.array().min(1).safeParse(raw.campaigns),
    personas: PersonaSchema.array().min(1).safeParse(raw.personas),
    prompts: PromptVersionsSchema.safeParse(raw.prompts),
    utm: UtmTableSchema.safeParse(raw.utm),
  };

  for (const [label, result] of Object.entries(parsed)) {
    if (!result.success) issues.push(...zodIssues(label, result.error));
  }
  if (issues.length > 0) throw new ConfigError(issues);

  // All blocks parsed; narrow the types.
  const cfg = {
    brand: parsed.brand.data!,
    competitors: parsed.competitors.data!,
    sourcePolicy: parsed.sourcePolicy.data!,
    platformLimits: parsed.platformLimits.data as PlatformLimits,
    campaigns: parsed.campaigns.data!,
    personas: parsed.personas.data!,
    prompts: parsed.prompts.data!,
    utm: parsed.utm.data!,
  };

  // --- cross-checks ---------------------------------------------------------

  // Competitors: aliases normalized and unique, domains plain and unique.
  const seenAlias = new Map<string, string>();
  const seenDomain = new Map<string, string>();
  for (const entry of cfg.competitors) {
    for (const alias of entry.aliases) {
      if (alias !== normalizeForMatch(alias)) {
        issues.push(`competitors.${entry.name}: alias "${alias}" must be written in normalized form ("${normalizeForMatch(alias)}")`);
      }
      const prior = seenAlias.get(alias);
      if (prior && prior !== entry.name) issues.push(`competitors: alias "${alias}" used by both "${prior}" and "${entry.name}"`);
      seenAlias.set(alias, entry.name);
    }
    for (const domain of entry.domains) {
      if (!PLAIN_HOST_RE.test(domain) || domain.startsWith('www.')) {
        issues.push(`competitors.${entry.name}: domain "${domain}" must be a plain lowercase hostname (no scheme, path or www)`);
      }
      const prior = seenDomain.get(domain);
      if (prior && prior !== entry.name) issues.push(`competitors: domain "${domain}" used by both "${prior}" and "${entry.name}"`);
      seenDomain.set(domain, entry.name);
    }
  }

  // Source policy: patterns compile, hosts are plain, blocked covers competitors, no overlap with allowed.
  for (const pattern of cfg.sourcePolicy.governmentHostPatterns) {
    try {
      new RegExp(pattern);
    } catch (e) {
      issues.push(`sourcePolicy.governmentHostPatterns: "${pattern}" is not a valid regex (${(e as Error).message})`);
    }
  }
  for (const host of [...cfg.sourcePolicy.kenResearchHosts, ...cfg.sourcePolicy.extraAllowedHosts, ...cfg.sourcePolicy.blockedHosts]) {
    if (!PLAIN_HOST_RE.test(host) || host.startsWith('www.')) {
      issues.push(`sourcePolicy: host "${host}" must be a plain lowercase hostname (no scheme, path or www)`);
    }
  }
  const blocked = new Set(cfg.sourcePolicy.blockedHosts);
  for (const entry of cfg.competitors) {
    for (const domain of entry.domains) {
      if (!blocked.has(domain)) issues.push(`sourcePolicy.blockedHosts is missing competitor domain "${domain}"`);
    }
  }
  for (const host of [...cfg.sourcePolicy.kenResearchHosts, ...cfg.sourcePolicy.extraAllowedHosts]) {
    if (blocked.has(host)) issues.push(`sourcePolicy: host "${host}" is both allowed and blocked`);
  }

  // Platforms: every PlatformId has a UTM entry.
  for (const platform of PlatformIdSchema.options) {
    if (!cfg.utm[platform]) issues.push(`utm: no entry for platform "${platform}"`);
  }

  // Campaigns reference existing personas and platforms; ids unique.
  const personaIds = new Set(cfg.personas.map((p) => p.id));
  if (personaIds.size !== cfg.personas.length) issues.push('personas: duplicate persona ids');
  const campaignIds = new Set<string>();
  for (const c of cfg.campaigns) {
    if (campaignIds.has(c.id)) issues.push(`campaigns: duplicate campaign id "${c.id}"`);
    campaignIds.add(c.id);
    for (const pid of c.personaIds) {
      if (!personaIds.has(pid)) issues.push(`campaigns.${c.id}: unknown persona "${pid}"`);
    }
  }

  // Brand: attribution phrases must not violate the brand's own bans.
  for (const phrase of cfg.brand.attributionPhrases) {
    for (const ch of cfg.brand.bannedCharacters) {
      if (phrase.includes(ch)) issues.push(`brand.attributionPhrases: "${phrase}" contains banned character`);
    }
    for (const word of cfg.brand.bannedPromoWords) {
      if (phrase.toLowerCase().includes(word.toLowerCase())) issues.push(`brand.attributionPhrases: "${phrase}" contains banned promo word "${word}"`);
    }
  }

  if (issues.length > 0) throw new ConfigError(issues);

  return { ...cfg, version: shortHash(cfg) };
}

/** Loads and validates the shipped configuration. Throws ConfigError if invalid. */
export function loadConfig(): LoadedConfig {
  return loadConfigFrom(defaultRawConfig);
}
