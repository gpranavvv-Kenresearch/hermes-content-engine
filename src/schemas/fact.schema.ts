import { z } from 'zod';
import { IsoDateStringSchema } from './common.js';

/**
 * Where a piece of supplementary evidence came from. Evidence read from the report page itself carries no tier.
 *  - ken_research: another kenresearch.com report: its figures are Ken Research's own and are attributed to it.
 *  - government: a government/regulatory page: its figures are attributed to that body by name, never to Ken Research.
 *  - other: any other non-competitor page: ONLY neutral, number-free background, never attributed to anyone.
 */
export const SourceTierSchema = z.enum(['ken_research', 'government', 'other']);
export type SourceTier = z.infer<typeof SourceTierSchema>;

export const VerificationStatusSchema = z.enum(['verified', 'conflicting', 'unverified']);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/**
 * A claim-level fact with provenance. A number is only "the same fact" when
 * metric, period, geography and market definition also match, not just value.
 */
export const FactSchema = z
  .object({
    id: z.string().min(1),
    metric: z.string().min(1), // e.g. "market_size", "cagr"
    value: z.number().finite(),
    unit: z.string().min(1), // e.g. "USD billion", "percent"
    currency: z.string().optional(),
    period: z.string().optional(), // "2025" or "2025-2030"
    geography: z.string().optional(),
    marketDefinition: z.string().optional(),
    factType: z.enum(['observed', 'derived']).default('observed'),
    derivation: z
      .object({
        formula: z.string().min(1),
        inputFactIds: z.array(z.string().min(1)).min(1),
      })
      .optional(),
    precision: z.number().int().min(0).max(6).optional(), // decimals the source printed
    sourceUrl: z.string().url(),
    sourceTitle: z.string(),
    /** Set only for facts that did not come from the report page itself (see SourceTierSchema). */
    sourceTier: SourceTierSchema.optional(),
    /** Display name of the source: a report title for ken_research, the body's name for government. */
    sourceName: z.string().optional(),
    sourcePublishedAt: IsoDateStringSchema.optional(),
    sourceRetrievedAt: IsoDateStringSchema,
    sourceQuote: z.string().optional(),
    verificationStatus: VerificationStatusSchema,
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine((f) => f.factType !== 'derived' || f.derivation !== undefined, {
    message: 'derived facts must record their derivation (formula + input fact ids)',
    path: ['derivation'],
  });
export type Fact = z.infer<typeof FactSchema>;
export type FactInput = z.input<typeof FactSchema>;

/**
 * A qualitative statement taken from the report page (a driver, a challenge, a note on the
 * competitive landscape). The model may restate it and attribute it to Ken Research. Notes
 * never contain figures: numbers only enter a post as verified Facts.
 */
export const SourceNoteSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  sourceUrl: z.string().url(),
  /** Set only for notes that did not come from the report page itself (see SourceTierSchema). */
  tier: SourceTierSchema.optional(),
  sourceName: z.string().optional(),
});
export type SourceNote = z.infer<typeof SourceNoteSchema>;

export const FactSetSchema = z.object({
  itemId: z.string().min(1),
  reportUrl: z.string().url(),
  facts: z.array(FactSchema),
  /** Qualitative statements from the same page. Optional in files written before notes existed. */
  notes: z.array(SourceNoteSchema).default([]),
  createdAt: IsoDateStringSchema,
});
export type FactSet = z.infer<typeof FactSetSchema>;
