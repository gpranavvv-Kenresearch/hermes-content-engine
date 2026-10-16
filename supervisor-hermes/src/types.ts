import { z } from 'zod';

export const GATES = ['evidence', 'strategy', 'draft', 'final'] as const;
export type Gate = (typeof GATES)[number];

export const ACTIONS = ['proceed', 'retry', 'regenerate', 'stop'] as const;
export type Action = (typeof ACTIONS)[number];

export const DecisionSchema = z.object({
  gate: z.enum(GATES),
  action: z.enum(ACTIONS),
  reason: z.string().min(1).max(600),
  instructions: z.string().max(1500).optional(),
  concerns: z.array(z.string().max(300)).max(8).default([]),
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
