import type { SourcePolicy, SourcePurpose, SourceRecord, SourceType } from '../schemas/index.js';
import { normalizeHost } from '../utils/normalize.js';

/**
 * Source policy enforcement. Pure functions, no I/O. Every URL that is fetched,
 * redirected to, or declared canonical must pass through here. Search-provider
 * `includeDomains` is only a hint, never a security boundary.
 */

export interface UrlClassification {
  allowed: boolean;
  sourceType: SourceType;
  /** Normalized host (lowercase, no www, no trailing dot); '' when unparseable. */
  host: string;
  reason: string;
}

const ALLOWED_PORTS = new Set(['', '80', '443']);
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
// eslint-disable-next-line no-control-regex
const BAD_CHARS_RE = /[\\\s\u0000-\u001f]/;

const govRegexCache = new WeakMap<SourcePolicy, RegExp[]>();

function governmentRegexes(policy: SourcePolicy): RegExp[] {
  let compiled = govRegexCache.get(policy);
  if (!compiled) {
    compiled = policy.governmentHostPatterns.map((p) => new RegExp(p));
    govRegexCache.set(policy, compiled);
  }
  return compiled;
}

/** True when `host` equals `domain` or is a subdomain of it (dot boundary). */
export function hostMatchesDomain(host: string, domain: string): boolean {
  const d = normalizeHost(domain);
  return d.length > 0 && (host === d || host.endsWith(`.${d}`));
}

function isIpLiteral(host: string): boolean {
  return host.startsWith('[') || host.includes(':') || IPV4_RE.test(host);
}

/**
 * Market-research publishers republish and resell the same kind of numbers Ken Research sells, so they are competitors
 * even when they are not on the named list, and press-release wires carry their releases. The host name is the only
 * signal available before a page is fetched; a false positive only means a page is not used.
 */
const RESEARCH_PUBLISHER_RE =
  /market|research|insight|intelligence|consult|analytic|forecast|reportlinker|reportsanddata|statista|prnewswire|businesswire|globenewswire|einnews|einpresswire|openpr|accesswire|newswire|marketwatch|benzinga|digitaljournal|24-?7|syndicate|ibisworld|frost|gartner|forrester|idc\.com|mckinsey|deloitte|pwc|kpmg|bcg\.com|bain\./i;

export function looksLikeResearchPublisher(host: string): boolean {
  return RESEARCH_PUBLISHER_RE.test(host);
}

function deny(sourceType: SourceType, host: string, reason: string): UrlClassification {
  return { allowed: false, sourceType, host, reason };
}

export function classifyUrl(url: string, purpose: SourcePurpose, policy: SourcePolicy): UrlClassification {
  if (typeof url !== 'string' || url.trim() === '') return deny('disallowed', '', 'empty url');
  if (BAD_CHARS_RE.test(url.trim())) return deny('disallowed', '', 'url contains whitespace, control or backslash characters');

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return deny('disallowed', '', 'unparseable url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return deny('disallowed', '', `scheme ${parsed.protocol} not allowed (http/https only)`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return deny('disallowed', '', 'userinfo in url is not allowed');
  }
  const host = normalizeHost(parsed.hostname);
  if (host === '') return deny('disallowed', '', 'empty host');
  if (!ALLOWED_PORTS.has(parsed.port)) return deny('disallowed', host, `port ${parsed.port} not allowed`);
  if (isIpLiteral(host)) return deny('disallowed', host, 'IP-literal hosts are not allowed');
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')) {
    return deny('disallowed', host, 'local or single-label host is not allowed');
  }

  // Blocked competitor hosts are checked FIRST and apply to every purpose.
  for (const blocked of policy.blockedHosts) {
    if (hostMatchesDomain(host, blocked)) {
      return deny('competitor_blocked', host, `host ${host} is blocked (${normalizeHost(blocked)})`);
    }
  }

  for (const ken of policy.kenResearchHosts) {
    if (hostMatchesDomain(host, ken)) return { allowed: true, sourceType: 'ken_research', host, reason: 'Ken Research host' };
  }
  if (governmentRegexes(policy).some((re) => re.test(host))) {
    return { allowed: true, sourceType: 'government', host, reason: 'government/regulatory host pattern' };
  }
  for (const extra of policy.extraAllowedHosts) {
    if (hostMatchesDomain(host, extra)) return { allowed: true, sourceType: 'extra_allowed', host, reason: 'explicitly allowed host' };
  }

  if (purpose === 'supplementary') {
    if (looksLikeResearchPublisher(host)) {
      return deny('disallowed', host, `host ${host} looks like a market-research publisher or press-release wire (competitor-like)`);
    }
    return { allowed: true, sourceType: 'other_named', host, reason: 'other named source (supplementary evidence, always attributed to itself, never to Ken Research)' };
  }

  if (purpose === 'planning') {
    return { allowed: true, sourceType: 'planning_other', host, reason: 'planning-only source (never a fact or citation)' };
  }
  return deny('disallowed', host, `host ${host} is not Ken Research, government or explicitly allowed (purpose: ${purpose})`);
}

export interface FetchedUrls {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl?: string | undefined;
}

export interface SourceValidation {
  allowed: boolean;
  record: SourceRecord;
}

/** Worst classification wins: competitor_blocked > disallowed > the final URL's type. */
export function validateFetchedSource(
  urls: FetchedUrls,
  purpose: SourcePurpose,
  policy: SourcePolicy,
  options: { now?: Date } = {},
): SourceValidation {
  const canonical = urls.canonicalUrl && urls.canonicalUrl.trim() !== '' ? urls.canonicalUrl : urls.finalUrl;
  const checks: Array<[string, string]> = [
    ['requested', urls.requestedUrl],
    ['final', urls.finalUrl],
    ['canonical', canonical],
  ];
  const results = checks.map(([label, u]) => ({ label, c: classifyUrl(u, purpose, policy) }));
  const failures = results.filter((r) => !r.c.allowed);

  let sourceType: SourceType;
  let reason: string;
  if (failures.length === 0) {
    const final = results[1]!.c;
    sourceType = final.sourceType;
    reason = `requested, final and canonical urls all pass: ${final.reason}`;
  } else {
    const worst = failures.find((f) => f.c.sourceType === 'competitor_blocked') ?? failures[0]!;
    sourceType = worst.c.sourceType;
    reason = failures.map((f) => `${f.label}: ${f.c.reason}`).join('; ');
  }

  return {
    allowed: failures.length === 0,
    record: {
      requestedUrl: urls.requestedUrl,
      finalUrl: urls.finalUrl,
      canonicalUrl: canonical,
      purpose,
      sourceType,
      allowlistStatus: failures.length === 0 ? 'allowed' : 'blocked',
      reason,
      fetchedAt: (options.now ?? new Date()).toISOString(),
    },
  };
}
