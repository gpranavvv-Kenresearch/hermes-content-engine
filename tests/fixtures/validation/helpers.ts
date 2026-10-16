import type { ClaimChecker, LlmProvider, LlmRequest, LlmResult } from '../../../src/contracts.js';
import { loadConfig } from '../../../src/config/index.js';
import { OUTPUT_BEGIN, OUTPUT_END, FACT_IDS_PREFIX, TEXT_MARKER } from '../../../src/contracts.js';
import type { Draft, Fact, PlatformId } from '../../../src/schemas/index.js';
import { buildCheckContext, type Check } from '../../../src/validation/checks/context.js';
import { validateText } from '../../../src/validation/validate-draft.js';

export const config = loadConfig();

/** Trivial claim checker: finds nothing. */
export const noClaimIssues: ClaimChecker = () => ({ issues: [], mappings: [] });

export const BASE_URL = 'https://www.kenresearch.com/industry-reports/examplestan-widget-market';
export const utmLink = (platform: PlatformId): string => {
  const u = config.utm[platform]!;
  return `${BASE_URL}?utm_source=${u.source}&utm_medium=${u.medium}&utm_campaign=${u.campaign}`;
};

export function codesOf(check: Check, text: string, platform: PlatformId = 'x'): string[] {
  return check(text, buildCheckContext(platform, config)).map((i) => i.code);
}

export function validate(text: string, platform: PlatformId = 'x', recentTexts: string[] = [], claimChecker: ClaimChecker = noClaimIssues) {
  return validateText({ draftId: 'd1', platform, text, facts: [], recentTexts, claimChecker }, config);
}

export function hardCodes(report: { issues: Array<{ code: string; severity: string }> }): string[] {
  return report.issues.filter((i) => i.severity === 'hard_fail').map((i) => i.code);
}

export function makeDraft(text: string, platform: PlatformId = 'x'): Draft {
  return {
    id: 'd1',
    itemId: 'item1',
    platform,
    text,
    variant: {
      campaignId: 'c',
      itemId: 'item1',
      personaId: 'p',
      tone: 't',
      opener: 'o',
      structure: 's',
      lengthClass: 'l',
      ctaVariant: 'v',
      promptVersion: '1',
    },
    factIds: [],
    configVersion: config.version,
    promptVersion: '1',
    attempt: 1,
    status: 'generated',
    createdAt: new Date().toISOString(),
  };
}

export const sampleFact: Fact = {
  id: 'F1',
  metric: 'market_size',
  value: 4.2,
  unit: 'USD billion',
  period: '2025',
  geography: 'Examplestan',
  factType: 'observed',
  sourceUrl: BASE_URL,
  sourceTitle: 'Examplestan Widget Market',
  sourceRetrievedAt: '2026-01-01T00:00:00Z',
  verificationStatus: 'verified',
};

export function wrapReply(text: string, factIds: string[] = []): string {
  return [OUTPUT_BEGIN, `${FACT_IDS_PREFIX} ${factIds.length ? factIds.join(', ') : 'none'}`, TEXT_MARKER, text, OUTPUT_END].join('\n');
}

export class FakeLlmProvider implements LlmProvider {
  readonly id = 'fake';
  readonly requests: LlmRequest[] = [];
  constructor(private readonly replies: Array<LlmResult | Error | ((r: LlmRequest) => LlmResult | Error)>) {}

  async generate(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    const next = this.replies[this.requests.length - 1] ?? this.replies[this.replies.length - 1];
    if (next === undefined) throw new Error('FakeLlmProvider: no replies configured');
    const value = typeof next === 'function' ? next(request) : next;
    if (value instanceof Error) throw value;
    return value;
  }
}

export const reply = (text: string, complete = true): LlmResult => ({ text, complete, provider: 'fake', elapsedMs: 1 });
