import { z } from 'zod';

export const PlatformIdSchema = z.enum([
  'x',
  'facebook',
  'linkedin',
  'tumblr',
  'instagram',
  'mastodon',
  'blog',
]);
export type PlatformId = z.infer<typeof PlatformIdSchema>;

/**
 * Why a source is being fetched. Facts and citations may only come from the
 * strict allowlist (Ken Research + government). Planning signals (trends, SERP
 * headings, industry-leader angles) are a separate data flow and are never
 * facts or citations.
 */
export const SourcePurposeSchema = z.enum(['fact', 'citation', 'planning', 'supplementary']);
export type SourcePurpose = z.infer<typeof SourcePurposeSchema>;

export const SourceTypeSchema = z.enum([
  'ken_research',
  'government',
  'extra_allowed',
  'planning_other',
  /** Any other host that is not a competitor research firm or a press-release wire. Usable only for the 'supplementary' purpose, always attributed to its own name. */
  'other_named',
  'competitor_blocked',
  'disallowed',
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const AllowlistStatusSchema = z.enum(['allowed', 'blocked']);
export type AllowlistStatus = z.infer<typeof AllowlistStatusSchema>;

export const IsoDateStringSchema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), { message: 'must be a parseable date string' });

export const SeveritySchema = z.enum(['hard_fail', 'review']);
export type Severity = z.infer<typeof SeveritySchema>;
