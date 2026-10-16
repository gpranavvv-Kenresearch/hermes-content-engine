import { z } from 'zod';
import { createHash } from 'node:crypto';

export const platforms = ['x', 'facebook', 'linkedin', 'tumblr'] as const;
export const Platform = z.enum(platforms);
export type Platform = z.infer<typeof Platform>;
export const timestamp = z.iso.datetime({ offset: true });
export const metricNames = ['impressions', 'reach', 'views', 'likes', 'reactions', 'comments', 'shares', 'quotes', 'clicks', 'saves', 'notes'] as const;
export const Metrics = z.object(Object.fromEntries(metricNames.map(k => [k, z.number().int().nonnegative().nullable().default(null)])) as Record<typeof metricNames[number], z.ZodDefault<z.ZodNullable<z.ZodNumber>>>);
export type Metrics = z.infer<typeof Metrics>;
export const emptyMetrics = (): Metrics => Metrics.parse({});
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const stableId = (...parts: string[]): string => hash(JSON.stringify(parts)).slice(0, 24);
export const Strategy = z.object({ layout: z.string().optional(), angle: z.string().optional(), hook: z.string().optional(), opener: z.string().optional(), tone: z.string().optional(), persona: z.string().optional(), topic: z.string().optional(), closing: z.string().optional(), policyVersion: z.string().optional(), experimentId: z.string().optional() });
export const Post = z.object({
  id: z.string().min(1), platform: Platform, accountId: z.string().nullable(), postId: z.string().min(1),
  url: z.url(), reportUrl: z.string(), text: z.string(), textHash: z.string(),
  publishedAt: timestamp.nullable(), publishedAtSource: z.string(), discoveredAt: timestamp,
  sourceRow: z.number().int().min(2), runId: z.string().optional(), strategy: Strategy.default({}),
  nativeUrn: z.string().optional(),
  nativePostId: z.string().optional(),
  contentType: z.enum(['text', 'image', 'video', 'unknown']).default('unknown'),
  distribution: z.enum(['organic', 'paid', 'unknown']).default('unknown'),
});
export type Post = z.infer<typeof Post>;
export const Snapshot = z.object({
  id: z.string(), postId: z.string(), platform: Platform, accountId: z.string().nullable(),
  window: z.union([z.literal(7), z.literal(14), z.literal('late')]), dueAt: timestamp, observedAt: timestamp,
  ageHours: z.number().nonnegative(), status: z.enum(['ok', 'partial', 'blocked', 'retry', 'unavailable', 'missed']),
  source: z.string(), metrics: Metrics, definitions: z.record(z.string(), z.string()).default({}),
  scope: z.enum(['organic', 'all', 'unknown']), reason: z.string().nullable(), rawRef: z.string().nullable(),
  attempts: z.number().int().nonnegative(), nextAttemptAt: timestamp.nullable(),
});
export type Snapshot = z.infer<typeof Snapshot>;
export const Account = z.object({
  id: z.string().min(1), platform: Platform, handles: z.array(z.string()).default([]),
  kind: z.enum(['member', 'organization', 'page', 'blog', 'user']), tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  apiVersion: z.string().optional(), nativeId: z.string().optional(),
  matchUnknown: z.boolean().default(false),
  facebookInsights: z.partialRecord(z.enum(['impressions', 'reach', 'views', 'clicks']), z.string()).default({}),
});
export type Account = z.infer<typeof Account>;
export const Accounts = z.object({ version: z.literal(1), accounts: z.array(Account) });

export const thresholds = z.object({ minPatternPosts: z.number().int().min(3).default(10), minBaselinePosts: z.number().int().min(5).default(30), minImpressions: z.number().int().min(1).default(100), weakRatio: z.number().positive().max(0.95).default(0.8), graceHours: z.number().positive().max(72).default(24), policyDays: z.number().int().min(1).max(90).default(30) });
export type Thresholds = z.infer<typeof thresholds>;
export const Finding = z.object({
  id: z.string(), at: timestamp, platform: Platform, accountId: z.string(), axis: z.enum(['layout', 'angle', 'hook', 'opener', 'tone', 'topic', 'closing']), pattern: z.string(),
  status: z.enum(['insufficient_data', 'observe', 'watch', 'reduce', 'paused', 'retest']),
  metric: z.string(), patternCount: z.number().int(), baselineCount: z.number().int(),
  patternRate: z.number().nullable(), baselineRate: z.number().nullable(), ratio: z.number().nullable(),
  intervalHigh: z.number().nullable(), snapshotIds: z.array(z.string()), reason: z.string(),
  previousId: z.string().nullable(), proposedWeight: z.number().min(0).max(1), applied: z.boolean().default(false),
  policyVersion: z.string().optional(),
});
export type Finding = z.infer<typeof Finding>;
export const Source = z.object({ url: z.url(), title: z.string().min(1), author: z.string().min(1), accessedAt: timestamp, revision: z.string().nullable(), license: z.string().nullable(), technique: z.string().min(10).max(500), platform: z.union([Platform, z.literal('all')]), confidence: z.literal('hypothesis'), newFormat: z.boolean().default(false), purpose: z.enum(['content_idea', 'analytics_reference']).default('content_idea') });
export type Source = z.infer<typeof Source>;
export const Experiment = z.object({ id: z.string(), at: timestamp, sourceId: z.string(), platform: z.union([Platform, z.literal('all')]), accountId: z.string().nullable().default(null), hypothesis: z.string(), control: z.string(), outcome: z.string(), status: z.enum(['proposed', 'needs_format_approval', 'testing', 'paused', 'complete']), allocation: z.number().min(0).max(0.2), startsAt: timestamp.nullable(), endsAt: timestamp.nullable(), findingIds: z.array(z.string()).default([]) });
export type Experiment = z.infer<typeof Experiment>;
export const AdvicePostInsight = z.object({
  postId: z.string(), postUrl: z.url(), opening: z.string(), visibleMetrics: z.record(z.string(), z.number()),
  patterns: z.record(z.string(), z.string()), weakSignals: z.array(z.string()), seoAssessment: z.string(),
  b2bAssessment: z.string(), contentProblem: z.string(), recommendedTest: z.string(),
});
export const PromptRecommendation = z.object({
  id: z.string(), target: z.enum(['strategy', 'writer', 'supervisor', 'validator', 'research']),
  priority: z.enum(['high', 'medium', 'low']), problem: z.string(), evidencePostIds: z.array(z.string()),
  proposedInstruction: z.string(), expectedEffect: z.string(), guardrail: z.string(),
});
export const LearningAdvice = z.object({
  id: z.string(), at: timestamp, platform: Platform, mode: z.literal('suggestions_only'),
  modelStatus: z.enum(['hermes', 'deterministic_fallback']), researchMode: z.enum(['live_and_curated', 'curated_only']),
  executiveSummary: z.string(), platformLearning: z.array(z.object({ signal: z.string(), evidencePostIds: z.array(z.string()), interpretation: z.string(), nextTest: z.string() })),
  postInsights: z.array(AdvicePostInsight), promptRecommendations: z.array(PromptRecommendation),
  findingIds: z.array(z.string()), sourceIds: z.array(z.string()), modelError: z.string().nullable(),
});
export type LearningAdvice = z.infer<typeof LearningAdvice>;
export const PromptGuidance = z.object({
  version: z.string(), platform: Platform, createdAt: timestamp, expiresAt: timestamp,
  adviceId: z.string(), findingIds: z.array(z.string()),
  rules: z.object({
    strategy: z.array(z.string()).max(4).default([]),
    writer: z.array(z.string()).max(6).default([]),
    supervisor: z.array(z.string()).max(4).default([]),
    validator: z.array(z.string()).max(4).default([]),
    research: z.array(z.string()).max(3).default([]),
  }),
  mode: z.literal('replace'), applied: z.literal(true),
});
export type PromptGuidance = z.infer<typeof PromptGuidance>;
export const Policy = z.object({ version: z.string(), createdAt: timestamp, expiresAt: timestamp, accountId: z.string(), platform: Platform, findingIds: z.array(z.string()).min(1), weights: z.object({ layout: z.record(z.string(), z.number().min(0).max(1)).default({}), angle: z.record(z.string(), z.number().min(0).max(1)).default({}), hook: z.record(z.string(), z.number().min(0).max(1)).default({}), opener: z.record(z.string(), z.number().min(0).max(1)).default({}) }), experimentShare: z.number().min(0).max(0.2).default(0.2) });
export type Policy = z.infer<typeof Policy>;
export interface Collection { metrics: Metrics; definitions: Record<string, string>; scope: Snapshot['scope']; source: string; raw: unknown; publishedAt?: string; text?: string; accountId?: string; }
export type FetchJson = (url: string, init?: RequestInit) => Promise<any>;
export interface Adapter { collect(post: Post, account?: Account): Promise<Collection>; }
export class CollectionError extends Error {
  constructor(readonly kind: 'blocked' | 'retry' | 'unavailable', message: string, readonly retryAfterSeconds?: number) { super(message); }
}
