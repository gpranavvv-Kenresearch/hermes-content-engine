import type { LoadedConfig } from '../config/index.js';
import type { ClaimChecker } from '../contracts.js';
import {
  ValidationReportSchema,
  type Draft,
  type Fact,
  type PlatformId,
  type SourceNote,
  type ValidationIssue,
  type ValidationReport,
} from '../schemas/index.js';
import { applyBold, applySpacers, boldFlags, toPlain } from '../utils/bold.js';
import { buildCheckContext } from './checks/context.js';
import { checkBrandAndBold } from './checks/formatting.js';
import { checkLayout } from './checks/layout.js';
import { checkOpeningQuote } from './checks/source-quote.js';
import { checkContentSanity } from './checks/content-sanity.js';
import { checkSourceAttribution } from './checks/source-attribution.js';
import { checkYears } from './checks/years.js';
import { hardFailChecks } from './checks/hard-fail.js';
import { reviewChecks } from './checks/review.js';
import { checkDuplicates, DEFAULT_DEDUP_THRESHOLDS, type DedupThresholds } from './dedup.js';
import { checkNarrativeClaims } from './narrative-claims.js';

export interface ValidateTextInput {
  draftId: string;
  platform: PlatformId;
  text: string;
  facts: readonly Fact[];
  /** Source-note texts from the report page; statements the narrative check treats as known. */
  notes?: readonly string[];
  /** Recent published/approved texts on any platform, for duplicate detection. */
  recentTexts: readonly string[];
  /** Injected; implemented by the evidence layer. */
  claimChecker: ClaimChecker;
  dedupThresholds?: DedupThresholds;
  /** Notes from the evidence pack with their tier, so background from other sources is never attributed to Ken Research. */
  evidenceNotes?: readonly SourceNote[];
  /** Post layout id of the draft; checkLayout holds the text to it. */
  layout?: string;
  /** Clock override for tests. */
  now?: () => Date;
  /** Social profile gates; omitted for legacy callers and other platforms. */
  requiredKeyword?: string;
  minUsefulWords?: number;
}

/** Normalize spacing and case while retaining phrase order. Links and hashtags do not satisfy body coverage. */
export function socialBody(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, ' ').replace(/#[\p{L}\p{N}_]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

export interface ValidateDraftInput extends Omit<ValidateTextInput, 'draftId' | 'platform' | 'text'> {
  draft: Pick<Draft, 'id' | 'platform' | 'text'>;
}

/**
 * Runs every check. Order is fixed so reports are reproducible:
 * hard-fail checks, duplicate check, claim checker, then review checks; the
 * final list is stably sorted hard_fail first. `passed` is true iff there is
 * no hard_fail issue.
 */
export function validateText(input: ValidateTextInput, config: LoadedConfig): ValidationReport {
  const base = buildCheckContext(input.platform, config);
  // The text may carry **markdown bold** (what the model writes) or Unicode bold (what is posted).
  // Meaning checks (names, numbers, claims, banned words) read PLAIN text, because bold digits and
  // letters are different code points and would slip past every regex. Only the length check reads
  // the FINAL text, since bold characters take two UTF-16 units each.
  const bolded = applyBold(input.text, base.limit.formatting, config.brand.name);
  const finalText = applySpacers(bolded, base.limit.formatting);
  const view = boldFlags(bolded);
  const plain = view.plain;
  const ctx = { ...base, finalText, ...(input.layout !== undefined ? { layout: input.layout } : {}) };
  const issues: ValidationIssue[] = [];

  for (const check of hardFailChecks) issues.push(...check(plain, ctx));
  issues.push(...checkBrandAndBold(view, ctx));
  issues.push(...checkLayout(plain, ctx));
  if (input.layout === 'source-quote-analysis') {
    const primaryNotes = input.evidenceNotes !== undefined
      ? input.evidenceNotes.filter((note) => !note.tier || note.tier === 'ken_research').map((note) => note.text)
      : input.notes ?? [];
    issues.push(...checkOpeningQuote(plain, primaryNotes));
  }
  issues.push(...checkDuplicates(plain, input.recentTexts.map(toPlain), input.dedupThresholds ?? DEFAULT_DEDUP_THRESHOLDS));
  issues.push(...input.claimChecker(plain, input.facts).issues);
  issues.push(...checkNarrativeClaims(plain, input.facts, input.notes ?? []));
  issues.push(...checkYears(plain, input.facts, input.notes ?? []));
  issues.push(...checkContentSanity(plain, input.facts, input.notes ?? []));
  issues.push(...checkSourceAttribution(plain, input.facts, input.evidenceNotes ?? []));
  const body = socialBody(plain);
  const keyword = input.requiredKeyword?.trim().replace(/\s+/g, ' ');
  if (keyword && !body.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())) {
    issues.push({ code: 'REQUIRED_KEYWORD_MISSING', severity: 'hard_fail', message: `Use the primary keyword "${keyword}" naturally in the post body.` });
  }
  if (input.minUsefulWords !== undefined) {
    const count = body.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
    if (count < input.minUsefulWords) {
      issues.push({ code: 'THIN_CONTENT', severity: 'hard_fail', message: `Develop the supported insight: ${count} useful words; require at least ${input.minUsefulWords}.`, detail: { count, minimum: input.minUsefulWords } });
    }
  }
  for (const check of reviewChecks) issues.push(...check(plain, ctx));

  const ordered = [
    ...issues.filter((i) => i.severity === 'hard_fail'),
    ...issues.filter((i) => i.severity === 'review'),
  ];
  const report = {
    draftId: input.draftId,
    passed: !ordered.some((i) => i.severity === 'hard_fail'),
    issues: ordered,
    checkedAt: (input.now?.() ?? new Date()).toISOString(),
  };
  return ValidationReportSchema.parse(report);
}

export function validateDraft(input: ValidateDraftInput, config: LoadedConfig): ValidationReport {
  const { draft, ...rest } = input;
  return validateText({ ...rest, draftId: draft.id, platform: draft.platform, text: draft.text }, config);
}

// --- outcome classification ------------------------------------------------------

export type Outcome = 'pass' | 'rewrite' | 'needs_human';
export type Remediation = 'auto_fix' | 'llm_rewrite' | 'human';

/**
 * Which known code is handled how. Codes not listed here (for example from the
 * claim checker) default to 'llm_rewrite' when hard-fail, unless the caller
 * passes them in `humanCodes`. docs/validation.md mirrors this table and a
 * test keeps the two in sync.
 */
export const REMEDIATION: Readonly<Record<string, Remediation>> = {
  // hard_fail
  BANNED_CHARACTER: 'auto_fix',
  BANNED_EMOJI: 'auto_fix',
  MISSING_UTM: 'auto_fix',
  DUPLICATE_UTM: 'auto_fix',
  WRONG_UTM: 'auto_fix',
  COMPETITOR_MENTION: 'llm_rewrite',
  OVER_HARD_LIMIT: 'llm_rewrite',
  MISSING_SOURCE_LINK: 'llm_rewrite',
  PLACEHOLDER: 'llm_rewrite',
  MISSING_TITLE: 'llm_rewrite',
  REFUSAL: 'llm_rewrite',
  DEGENERATE_OUTPUT: 'llm_rewrite',
  REASONING_LEAK: 'llm_rewrite',
  PROMPT_ECHO: 'llm_rewrite',
  SAFETY_CLASSIFIER_LEAK: 'llm_rewrite',
  EXACT_DUPLICATE: 'llm_rewrite',
  UNSUPPORTED_NARRATIVE_CLAIM: 'llm_rewrite',
  STALE_YEAR: 'llm_rewrite',
  DUPLICATE_POINT: 'llm_rewrite',
  SOURCE_NOT_NAMED: 'llm_rewrite',
  SOURCE_SCOPE_MISSING: 'llm_rewrite',
  MISATTRIBUTED_NOTE: 'llm_rewrite',
  LIST_COUNT_MISMATCH: 'llm_rewrite',
  REPEATED_PHRASE: 'llm_rewrite',
  NO_VERIFIED_FIGURE: 'llm_rewrite',
  UNSUPPORTED_YEAR: 'llm_rewrite',
  UNSUPPORTED_MULTIPLIER_CLAIM: 'llm_rewrite',
  UNSUPPORTED_ATTRIBUTION: 'llm_rewrite',
  MISSING_BRAND_MENTION: 'llm_rewrite',
  BRAND_NOT_BOLD: 'auto_fix',
  FIGURE_NOT_BOLD: 'auto_fix',
  MISSING_LIST_STRUCTURE: 'llm_rewrite',
  // review
  UNEXPECTED_BOLD: 'llm_rewrite',
  LIST_TOO_LONG: 'llm_rewrite',
  HOOK_NOT_QUESTION: 'llm_rewrite',
  NO_ATTRIBUTION: 'llm_rewrite',
  FIGURE_PRECISION: 'llm_rewrite',
  UNGROUNDED_SENTENCE: 'llm_rewrite',
  LONG_SENTENCE: 'llm_rewrite',
  CHOPPY_SENTENCES: 'llm_rewrite',
  REPETITIVE_OPENERS: 'llm_rewrite',
  MISSING_CLOSING_QUESTION: 'llm_rewrite',
  MISSING_BRAND_HASHTAG: 'auto_fix',
  BELOW_TARGET_BAND: 'llm_rewrite',
  ABOVE_TARGET_BAND: 'llm_rewrite',
  SUSPICIOUSLY_SHORT: 'human',
  HASHTAG_COUNT: 'llm_rewrite',
  BANNED_PHRASE: 'llm_rewrite',
  BANNED_PROMO_WORD: 'llm_rewrite',
  AI_TELL: 'llm_rewrite',
  REPETITIVE_PHRASING: 'llm_rewrite',
  WEAK_EVIDENCE_WORDING: 'llm_rewrite',
  GENERIC_PROMOTIONAL: 'llm_rewrite',
  READABILITY: 'llm_rewrite',
  LOW_SENTENCE_VARIANCE: 'llm_rewrite',
  TONE: 'llm_rewrite',
  NEAR_DUPLICATE: 'human',
};

/**
 * Hard-fail codes that rewriting cannot fix because the problem is upstream of
 * the text (the facts themselves). The claim checker's codes for these cases
 * should be added here once its code names are final.
 */
export const DEFAULT_HUMAN_CODES: ReadonlySet<string> = new Set(['CONFLICTING_FACT', 'NO_VERIFIED_FACTS']);

export interface ClassifyOptions {
  humanCodes?: ReadonlySet<string>;
}

/**
 * pass: no hard failure (review issues may remain and are reported, not blocking).
 * needs_human: a hard failure that a rewrite cannot fix.
 * rewrite: hard failures an LLM rewrite (after deterministic fixers) may fix.
 */
export function classifyOutcome(report: ValidationReport, options: ClassifyOptions = {}): Outcome {
  if (report.passed) return 'pass';
  const human = options.humanCodes ?? DEFAULT_HUMAN_CODES;
  const hard = report.issues.filter((i) => i.severity === 'hard_fail');
  if (hard.some((i) => human.has(i.code))) return 'needs_human';
  return 'rewrite';
}
