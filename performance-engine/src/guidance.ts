import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LearningAdvice, PromptGuidance, stableId, type Platform } from './contracts.js';
import { atomicWrite } from './store.js';

export const guidanceRoot = (): string => path.resolve(process.env.PE_GUIDANCE_ROOT ?? 'output/performance-engine');
export const guidanceFile = (root: string, platform: Platform): string => path.join(root, 'active-guidance', `${platform}.json`);

const cleanRule = (value: string): string => value
  .replace(/^For review only:\s*/i, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 900);

/** Build a bounded replacement set from the latest Hermes response. Previous rules are not appended. */
export function buildPromptGuidance(advice: LearningAdvice, at = new Date(), days = 30): PromptGuidance {
  if (advice.modelStatus !== 'hermes') throw new Error('Automatic prompt guidance requires a completed Hermes advisory; deterministic fallback was not applied.');
  const rules: PromptGuidance['rules'] = { strategy: [], writer: [], supervisor: [], validator: [], research: [] };
  const limits: Record<keyof PromptGuidance['rules'], number> = { strategy: 4, writer: 6, supervisor: 4, validator: 4, research: 3 };
  const ordered = [...advice.promptRecommendations].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority]));
  for (const recommendation of ordered) {
    if (Object.values(rules).reduce((total, group) => total + group.length, 0) >= 10) break;
    if (!recommendation.evidencePostIds.length) continue;
    const rule = cleanRule(recommendation.proposedInstruction);
    if (!rule || rules[recommendation.target].includes(rule) || rules[recommendation.target].length >= limits[recommendation.target]) continue;
    rules[recommendation.target].push(rule);
  }
  if (!Object.values(rules).some(group => group.length)) throw new Error('Hermes advisory contained no evidence-linked prompt guidance to apply.');
  const createdAt = at.toISOString();
  const version = stableId('prompt-guidance', advice.platform, advice.id, createdAt, JSON.stringify(rules));
  return PromptGuidance.parse({ version, platform: advice.platform, createdAt, expiresAt: new Date(at.getTime() + days * 86400000).toISOString(), adviceId: advice.id, findingIds: advice.findingIds, rules, mode: 'replace', applied: true });
}

export async function replacePromptGuidance(root: string, guidance: PromptGuidance): Promise<void> {
  // Version first, then atomically replace the one active platform file. This is replacement, never an append.
  await atomicWrite(path.join(root, 'guidance-versions', guidance.platform, `${guidance.version}.json`), guidance);
  await atomicWrite(guidanceFile(root, guidance.platform), guidance);
}

export async function loadPromptGuidance(root: string, platform: Platform, at = new Date()): Promise<PromptGuidance | null> {
  try {
    const guidance = PromptGuidance.parse(JSON.parse(await readFile(guidanceFile(root, platform), 'utf8')));
    if (guidance.platform !== platform || Date.parse(guidance.createdAt) > at.getTime() || Date.parse(guidance.expiresAt) <= at.getTime()) return null;
    return guidance;
  } catch {
    return null;
  }
}

/** A fixed prompt slot. Each new loop replaces the backing rules instead of growing the prompt. */
export function guidanceTechniques(guidance: PromptGuidance): string[] {
  return (Object.entries(guidance.rules) as Array<[keyof PromptGuidance['rules'], string[]]>).flatMap(([target, rules]) =>
    rules.map(rule => `Latest measured ${target} correction (${guidance.version}): ${rule}`),
  );
}
