import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LearningAdvice } from '../src/contracts.js';
import { buildPromptGuidance, guidanceTechniques, loadPromptGuidance, replacePromptGuidance } from '../src/guidance.js';

let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'hermes-guidance-test-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function advice(id: string, instruction: string, status: 'hermes' | 'deterministic_fallback' = 'hermes') {
  return LearningAdvice.parse({
    id, at: '2026-10-16T12:00:00.000Z', platform: 'linkedin', mode: 'suggestions_only', modelStatus: status,
    researchMode: 'curated_only', executiveSummary: 'Measured diagnostic.', platformLearning: [], postInsights: [],
    promptRecommendations: [{ id: `${id}-r1`, target: 'writer', priority: 'high', problem: 'Opening lacks decision value.', evidencePostIds: ['p1'], proposedInstruction: instruction, expectedEffect: 'Clearer opening.', guardrail: 'Use supplied evidence only.' }],
    findingIds: ['f1'], sourceIds: [], modelError: status === 'hermes' ? null : 'offline',
  });
}

describe('automatic prompt guidance', () => {
  it('atomically replaces the active platform rules while retaining version history', async () => {
    const first = buildPromptGuidance(advice('a1', 'For review only: use one decision-led opening.'), new Date('2026-10-16T12:00:00Z'));
    await replacePromptGuidance(root, first);
    const second = buildPromptGuidance(advice('a2', 'Use the complete report topic in the first sentence.'), new Date('2026-10-17T12:00:00Z'));
    await replacePromptGuidance(root, second);
    const active = await loadPromptGuidance(root, 'linkedin', new Date('2026-10-18T12:00:00Z'));
    expect(active?.version).toBe(second.version);
    expect(active?.rules.writer).toEqual(['Use the complete report topic in the first sentence.']);
    expect(JSON.stringify(active)).not.toContain('decision-led');
    expect(await readdir(path.join(root, 'guidance-versions', 'linkedin'))).toHaveLength(2);
    expect(guidanceTechniques(active!)[0]).toContain(second.version);
  });

  it('does not auto-apply a deterministic fallback response', () => {
    expect(() => buildPromptGuidance(advice('a1', 'Use one opening.', 'deterministic_fallback'))).toThrow('completed Hermes advisory');
  });
});
