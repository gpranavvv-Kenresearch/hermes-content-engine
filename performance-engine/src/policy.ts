import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Policy, stableId, type Finding, type Platform, type Thresholds } from './contracts.js';
import { atomicWrite } from './store.js';
import { APPROVED_SOCIAL_LAYOUTS } from '../../src/strategy/layouts.js';

export function buildPolicy(findings: Finding[], platform: Platform, accountId: string, at: Date, days = 30): Policy {
  const weights: Policy['weights'] = { layout: {}, angle: {}, hook: {}, opener: {} };
  const latest = new Map<string, Finding>();
  for (const f of findings.filter(f => f.platform === platform && f.accountId === accountId && Date.parse(f.at) <= at.getTime())) {
    const key = `${f.axis}:${f.pattern}:${f.metric}`; const old = latest.get(key); if (!old || f.at > old.at) latest.set(key, f);
  }
  const usable = [...latest.values()].filter(f => ['reduce', 'paused'].includes(f.status) && f.axis in weights && f.patternCount >= 10 && f.baselineCount >= 30 && f.ratio !== null && f.ratio <= 0.8 && f.intervalHigh !== null && f.intervalHigh < 1 && at.getTime() - Date.parse(f.at) < days * 86400000 && ![...latest.values()].some(other => other.axis === f.axis && other.pattern === f.pattern && other.metric !== f.metric && other.patternCount >= 10 && other.baselineCount >= 30 && other.ratio !== null && other.ratio > 0.8 && at.getTime() - Date.parse(other.at) < days * 86400000));
  if (!usable.length) throw new Error('No current evidence-qualified reduce/paused findings; policy was not applied.');
  for (const f of usable) {
    if (f.axis === 'layout' && ['linkedin', 'facebook'].includes(platform) && !APPROVED_SOCIAL_LAYOUTS.includes(f.pattern)) throw new Error('Policy cannot add or change an approved LI/FB format');
    weights[f.axis as keyof typeof weights][f.pattern] = f.proposedWeight;
  }
  const findingIds = usable.map(f => f.id).sort();
  return Policy.parse({ version: stableId(platform, accountId, at.toISOString(), ...findingIds), createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + days * 86400000).toISOString(), platform, accountId, weights, findingIds, experimentShare: 0.2 });
}
export const policyFile = (root: string, platform: Platform, accountId: string): string => path.join(root, 'policies', `${stableId(platform, accountId)}.json`);
export async function savePolicy(root: string, policy: Policy): Promise<void> {
  await atomicWrite(path.join(root, 'policy-versions', `${policy.version}.json`), policy);
  await atomicWrite(policyFile(root, policy.platform, policy.accountId), policy);
}
export async function loadPolicy(root: string, platform: Platform, accountId: string | undefined, at = new Date()): Promise<Policy | null> {
  if (!accountId) return null;
  try {
    const p = Policy.parse(JSON.parse(await readFile(policyFile(root, platform, accountId), 'utf8')));
    if (p.platform !== platform || p.accountId !== accountId || Date.parse(p.expiresAt) <= at.getTime() || Date.parse(p.createdAt) > at.getTime() || Date.parse(p.expiresAt) - Date.parse(p.createdAt) > 90 * 86400000) return null;
    if (['linkedin', 'facebook'].includes(platform) && Object.keys(p.weights.layout).some(id => !APPROVED_SOCIAL_LAYOUTS.includes(id))) return null;
    return p;
  } catch { return null; }
}
