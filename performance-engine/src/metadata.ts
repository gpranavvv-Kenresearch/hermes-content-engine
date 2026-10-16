import { z } from 'zod';
import { Strategy, Post, hash, type Platform } from './contracts.js';
import type { Store } from '../../src/store/store.js';
import type { ContentVariant } from '../../src/schemas/index.js';

export const HANDOFFS = 'performance-generation-handoffs';
export const Handoff = z.object({ runId: z.string(), platform: z.enum(['x', 'facebook', 'linkedin', 'tumblr']), reportUrl: z.string(), textHash: z.string(), at: z.iso.datetime(), strategy: Strategy });
export async function saveGenerationHandoff(store: Store, input: { runId: string; platform: Platform; reportUrl: string; text: string; variant: ContentVariant; at: Date; policyVersion?: string; experimentId?: string }): Promise<void> {
  const v = input.variant;
  const record = Handoff.parse({ runId: input.runId, platform: input.platform, reportUrl: input.reportUrl, textHash: hash(input.text), at: input.at.toISOString(), strategy: { layout: v.layout, angle: v.angle, hook: v.hookStyle, opener: v.opener, tone: v.tone, persona: v.personaId, ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}), ...(input.experimentId ? { experimentId: input.experimentId } : {}) } });
  await store.put(HANDOFFS, input.runId, record);
}
export async function attachHandoffs(posts: Post[], store: Store): Promise<Post[]> {
  const records = (await store.list(HANDOFFS)).map(r => Handoff.safeParse(r.value)).filter(r => r.success).map(r => r.data!);
  return posts.map(p => {
    const matches = records.filter(r => r.platform === p.platform && r.reportUrl.replace(/\/+$/, '') === p.reportUrl.replace(/\/+$/, '') && r.textHash === p.textHash);
    // Multiple matching generations may have different strategies: do not invent attribution.
    if (matches.length !== 1) return p;
    const m = matches[0]!; return Post.parse({ ...p, runId: m.runId, strategy: m.strategy });
  });
}
