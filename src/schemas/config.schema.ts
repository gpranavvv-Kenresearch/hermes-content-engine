import { z } from 'zod';
import { PlatformIdSchema } from './common.js';

export const BrandConfigSchema = z.object({
  name: z.string().min(1),
  tone: z.string().min(1),
  stance: z.string().min(1),
  audience: z.array(z.string().min(1)).min(1),
  /** Hype words that undercut an authoritative voice. */
  bannedPromoWords: z.array(z.string().min(1)),
  /** Phrases the old prompts already forbade, plus curated AI-tell phrases (seed list). */
  bannedPhrases: z.array(z.string().min(1)),
  /** Characters that must never appear (em/en dash are stripped by the old pipeline). */
  bannedCharacters: z.array(z.string().min(1)),
  /** Attribution wording allowed for the brand inside generated text. */
  attributionPhrases: z.array(z.string().min(1)).min(1),
});
export type BrandConfig = z.infer<typeof BrandConfigSchema>;

export const CompetitorEntrySchema = z.object({
  name: z.string().min(1),
  /** Normalized-text aliases (matched on word boundaries after normalization). */
  aliases: z.array(z.string().min(1)),
  /** Raw case-insensitive literals for tokens that normalization would mangle (e.g. "market.us"). */
  literals: z.array(z.string().min(1)).default([]),
  domains: z.array(z.string().min(1)).min(1),
});
export type CompetitorEntry = z.infer<typeof CompetitorEntrySchema>;
export const CompetitorListSchema = z.array(CompetitorEntrySchema).min(1);

export const SourcePolicySchema = z.object({
  kenResearchHosts: z.array(z.string().min(1)).min(1),
  /** Regex sources (anchored to the hostname) that identify government/regulatory hosts. */
  governmentHostPatterns: z.array(z.string().min(1)).min(1),
  /** Extra explicitly approved hosts (e.g. supranational government bodies). */
  extraAllowedHosts: z.array(z.string().min(1)),
  /** Hosts that must never be fetched. Always a superset of competitor domains. */
  blockedHosts: z.array(z.string().min(1)),
});
export type SourcePolicy = z.infer<typeof SourcePolicySchema>;

export const PlatformLimitSchema = z
  .object({
    /** Absolute cap on the final serialized payload. Exceeding it is a hard fail. */
    hardMaxChars: z.number().int().positive().nullable(),
    /** Soft target band the generator is steered to. */
    targetMinChars: z.number().int().nonnegative().nullable(),
    targetMaxChars: z.number().int().positive().nullable(),
    /** Characters every URL counts as on this platform (X = 23), or null for literal length. */
    urlCountsAs: z.number().int().positive().nullable(),
    hashtags: z.object({ min: z.number().int().min(0), max: z.number().int().min(0) }),
    requireSourceLink: z.boolean(),
    requireTitle: z.boolean(),
    /**
     * Bold rules. On platforms that do not render markdown (Facebook, LinkedIn) the model
     * writes **double asterisks** and they are converted to Unicode bold at the end.
     * boldBrand: every mention of the brand name is bold. boldFigures: every currency
     * amount and percentage/CAGR figure is bold. Both false means plain text only.
     */
    formatting: z.object({
      boldBrand: z.boolean(),
      /** Bold currency amounts, percentages/CAGR AND years (the reference LinkedIn post bolds all three). */
      boldFigures: z.boolean(),
      /** Permit one optional short emphasis span in addition to any required brand emphasis. */
      selectiveBold: z.boolean().optional(),
      /**
       * 'numbered_points': hook question, then numbered points (1. 2. 3.) each in its own paragraph,
       * a closing question, a "read the full report:" line, the link on its own line, an
       * engagement question, then hashtags starting with the brand hashtag. 'free': no fixed layout.
       */
      layout: z.enum(['free', 'numbered_points']),
      /**
       * Character put on every blank line of the final text (U+2800 BRAILLE PATTERN BLANK on
       * LinkedIn/Facebook), because those editors collapse empty lines. null = leave blank lines.
       */
      blankLineChar: z.string().nullable(),
    }),
  })
  .refine((p) => p.hashtags.min <= p.hashtags.max, { message: 'hashtags.min must be <= max' })
  .refine(
    (p) =>
      p.targetMaxChars === null ||
      p.hardMaxChars === null ||
      p.targetMaxChars <= p.hardMaxChars,
    { message: 'targetMaxChars must not exceed hardMaxChars' },
  )
  .refine(
    (p) =>
      p.targetMinChars === null || p.targetMaxChars === null || p.targetMinChars <= p.targetMaxChars,
    { message: 'targetMinChars must be <= targetMaxChars' },
  );
export type PlatformLimit = z.infer<typeof PlatformLimitSchema>;
export const PlatformLimitsSchema = z.record(PlatformIdSchema, PlatformLimitSchema);
export type PlatformLimits = Record<z.infer<typeof PlatformIdSchema>, PlatformLimit>;

export const UtmEntrySchema = z.object({
  source: z.string().min(1),
  medium: z.string().min(1),
  campaign: z.string().min(1),
});
export type UtmEntry = z.infer<typeof UtmEntrySchema>;
export const UtmTableSchema = z.record(z.string().min(1), UtmEntrySchema);

export const PromptVersionsSchema = z.object({
  version: z.string().min(1),
  prompts: z.record(z.string().min(1), z.string().min(1)),
});
export type PromptVersions = z.infer<typeof PromptVersionsSchema>;
