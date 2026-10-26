import { z } from 'zod';

export const GATES = ['evidence', 'strategy', 'draft', 'final'] as const;
export type Gate = (typeof GATES)[number];

export const ACTIONS = ['proceed', 'retry', 'regenerate', 'stop'] as const;
export type Action = (typeof ACTIONS)[number];

// The model sometimes writes a slightly over-long explanation. That is not a
// reason to fail the gate closed and skip a post, so over-long free text is
// trimmed to the limit; the action and gate stay strictly validated.
const clip = (max: number) => z.string().transform((v) => (v.length > max ? v.slice(0, max - 1) + '…' : v));

export const DecisionSchema = z.object({
  gate: z.enum(GATES),
  action: z.enum(ACTIONS),
  reason: clip(600).pipe(z.string().min(1)),
  instructions: clip(1500).optional(),
  concerns: z.array(clip(300)).transform((a) => a.slice(0, 8)).default([]),
});
export type Decision = z.infer<typeof DecisionSchema>;

export type AgentName = 'sheet' | 'evidence' | 'strategy' | 'writer' | 'validator' | 'learning';

export interface AgentReport<T> {
  agent: AgentName;
  output: T;
  /** A few sentences: what the agent did and found. */
  summary: string;
  /** Anything the agent doubts. */
  concerns: string[];
}

export type SocialPlatform = 'x' | 'facebook' | 'linkedin' | 'tumblr';
export type RowStatus = 'approved' | 'needs_human';

export interface RowResult {
  rowIndex: number;
  url: string;
  title: string;
  keyword: string;
  platform: SocialPlatform;
  status: RowStatus;
  reason: string;
  text: string | null;
  score: number | null;
  regenerations: number;
  retries: number;
  decisions: Decision[];
  written: { cell: string; verified: boolean } | null;
  /** The report page did not load or there is no usable evidence: a skippable row, not a failure of the pipeline. */
  noEvidence: boolean;
}
