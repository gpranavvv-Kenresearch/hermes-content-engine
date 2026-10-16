import { z } from 'zod';
import { IsoDateStringSchema, PlatformIdSchema } from './common.js';

export const PersonaSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  seniority: z.enum(['c_suite', 'investor', 'senior_manager']),
  description: z.string().min(1),
  tone: z.string().min(1),
  depth: z.enum(['headline', 'balanced', 'deep']),
  priorities: z.array(z.string().min(1)).min(1),
  avoid: z.array(z.string().min(1)),
});
export type Persona = z.infer<typeof PersonaSchema>;

export const SearchIntentSchema = z.enum([
  'informational',
  'commercial',
  'navigational',
  'transactional',
]);
export type SearchIntent = z.infer<typeof SearchIntentSchema>;

export const CampaignSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  goal: z.string().min(1),
  platforms: z.array(PlatformIdSchema).min(1),
  keywordCluster: z.array(z.string().min(1)),
  searchIntent: SearchIntentSchema,
  evergreen: z.boolean(),
  seoStrategy: z.string().min(1),
  personaIds: z.array(z.string().min(1)).min(1),
  active: z.boolean(),
});
export type Campaign = z.infer<typeof CampaignSchema>;

/** A trend/SERP/leader signal. Planning only: never a fact, never cited. */
export const PlanningSignalSchema = z.object({
  title: z.string().min(1),
  sourceUrl: z.string().url(),
  signalKind: z.enum(['trend', 'serp_heading', 'leader_angle', 'govt_update']),
  purpose: z.literal('planning'),
});
export type PlanningSignal = z.infer<typeof PlanningSignalSchema>;

export const BriefSchema = z.object({
  itemId: z.string().min(1),
  campaignId: z.string().min(1),
  personaId: z.string().min(1),
  personaReason: z.string().min(1),
  angle: z.string().min(1),
  keywords: z.array(z.string().min(1)),
  beatPoints: z.array(z.string().min(1)),
  planningSignals: z.array(PlanningSignalSchema),
  factIds: z.array(z.string().min(1)),
  createdAt: IsoDateStringSchema,
});
export type Brief = z.infer<typeof BriefSchema>;
