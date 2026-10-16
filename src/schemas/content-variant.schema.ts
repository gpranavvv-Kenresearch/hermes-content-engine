import { z } from 'zod';
import { IsoDateStringSchema, PlatformIdSchema, SeveritySchema } from './common.js';

export const ContentVariantSchema = z.object({
  campaignId: z.string().min(1),
  itemId: z.string().min(1),
  personaId: z.string().min(1),
  tone: z.string().min(1),
  opener: z.string().min(1),
  structure: z.string().min(1),
  lengthClass: z.string().min(1),
  ctaVariant: z.string().min(1),
  promptVersion: z.string().min(1),
  /** What the post argues (see strategy/angles.ts). Absent for variants made before angles existed. */
  angle: z.string().min(1).optional(),
  /** Shape of the opening question (see strategy/hooks.ts). */
  hookStyle: z.string().min(1).optional(),
  /** Post layout (see strategy/layouts.ts). Absent for variants made before layouts existed. */
  layout: z.string().min(1).optional(),
  similarityScore: z.number().min(0).max(1).optional(),
});
export type ContentVariant = z.infer<typeof ContentVariantSchema>;

export const DraftStatusSchema = z.enum([
  'generated',
  'validated',
  'rewrite_needed',
  'needs_human',
  'approved',
]);
export type DraftStatus = z.infer<typeof DraftStatusSchema>;

/** One generated draft, always stamped with the config + prompt version that produced it. */
export const DraftSchema = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  platform: PlatformIdSchema,
  /** Final text, ready to post (Unicode bold already applied on bold platforms). */
  text: z.string(),
  /** The same text with **markdown bold** as the model wrote it. Present when the platform uses bold. */
  markdown: z.string().optional(),
  variant: ContentVariantSchema,
  factIds: z.array(z.string().min(1)),
  configVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  attempt: z.number().int().min(1),
  status: DraftStatusSchema,
  createdAt: IsoDateStringSchema,
});
export type Draft = z.infer<typeof DraftSchema>;

export const ValidationIssueSchema = z.object({
  code: z.string().min(1),
  severity: SeveritySchema,
  message: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ValidationReportSchema = z.object({
  draftId: z.string().min(1),
  passed: z.boolean(), // true only when there are no hard_fail issues
  issues: z.array(ValidationIssueSchema),
  checkedAt: IsoDateStringSchema,
});
export type ValidationReport = z.infer<typeof ValidationReportSchema>;
