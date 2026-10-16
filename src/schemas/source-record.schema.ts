import { z } from 'zod';
import {
  AllowlistStatusSchema,
  IsoDateStringSchema,
  SourcePurposeSchema,
  SourceTypeSchema,
} from './common.js';

/**
 * Audit record kept for every fetched item: why it was fetched, what kind of
 * source it is, its canonical URL and whether the allowlist let it through.
 */
export const SourceRecordSchema = z.object({
  requestedUrl: z.string(),
  finalUrl: z.string(),
  canonicalUrl: z.string(),
  purpose: SourcePurposeSchema,
  sourceType: SourceTypeSchema,
  allowlistStatus: AllowlistStatusSchema,
  reason: z.string(),
  fetchedAt: IsoDateStringSchema,
});
export type SourceRecord = z.infer<typeof SourceRecordSchema>;
