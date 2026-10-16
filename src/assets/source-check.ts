import { sourcePolicy as defaultPolicy } from '../config/source-policy.config.js';
import type { SourcePolicy } from '../schemas/index.js';
import { isHostOrSubdomain, urlHost } from '../utils/utm.js';

/**
 * True when a URL may back a rendered fact: Ken Research or government /
 * regulatory hosts per the locked source policy. Competitor (blocked) hosts
 * always lose, and only http(s) URLs qualify.
 */
export function isAllowedFactSource(url: string, policy: SourcePolicy = defaultPolicy): boolean {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  if (protocol !== 'https:' && protocol !== 'http:') return false;
  const host = urlHost(url);
  if (host === null) return false;
  if (policy.blockedHosts.some((b) => isHostOrSubdomain(host, b))) return false;
  if (policy.kenResearchHosts.some((h) => isHostOrSubdomain(host, h))) return true;
  if (policy.extraAllowedHosts.some((h) => isHostOrSubdomain(host, h))) return true;
  return policy.governmentHostPatterns.some((p) => new RegExp(p).test(host));
}

/** Reasons a fact may not be rendered/charted; empty array means it may. */
export function factRenderProblems(
  fact: { id: string; verificationStatus: string; sourceUrl: string },
  policy: SourcePolicy = defaultPolicy,
): string[] {
  const out: string[] = [];
  if (fact.verificationStatus !== 'verified') out.push(`fact ${fact.id}: verificationStatus is "${fact.verificationStatus}", only "verified" facts may be rendered`);
  if (!isAllowedFactSource(fact.sourceUrl, policy)) out.push(`fact ${fact.id}: sourceUrl ${fact.sourceUrl} is not a Ken Research or government source`);
  return out;
}
