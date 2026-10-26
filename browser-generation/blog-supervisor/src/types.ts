import { z } from 'zod';

export const BLOG_GATES = ['evidence', 'structure', 'draft', 'final'] as const;
export type BlogGate = (typeof BLOG_GATES)[number];

/**
 * retry      = send a targeted fix request in the SAME ChatGPT chat (draft gate only)
 * regenerate = throw the draft away and start a fresh chat (optionally with a different structure)
 * stop       = give up on this row
 */
export const BLOG_ACTIONS = ['proceed', 'retry', 'regenerate', 'stop'] as const;
export type BlogAction = (typeof BLOG_ACTIONS)[number];

// The model sometimes writes a slightly over-long explanation. That is not a reason to fail a gate closed and skip
// a 15-minute article, so over-long free text is trimmed; the gate and action stay strictly validated.
const clip = (max: number) => z.string().transform((v) => (v.length > max ? v.slice(0, max - 1) + '…' : v));

export const BlogDecisionSchema = z.object({
  gate: z.enum(BLOG_GATES),
  action: z.enum(BLOG_ACTIONS),
  reason: clip(800).pipe(z.string().min(1)),
  /** Numbered corrections for the fix request (retry) or the fresh attempt (regenerate). */
  instructions: clip(3500).optional(),
  concerns: z.array(clip(400)).transform((a) => a.slice(0, 12)).default([]),
  /** Structure gate only: switch to this architecture id. */
  structure: z.string().max(60).optional(),
});
export type BlogDecision = z.infer<typeof BlogDecisionSchema>;

export class HermesUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HermesUnavailableError';
  }
}

export interface BlogRowResult {
  rowIndex: number;
  title: string;
  status: 'written' | 'skipped' | 'needs_human';
  reason: string;
  structure?: string;
  gates: { gate: BlogGate; action: BlogAction; reason: string }[];
}
