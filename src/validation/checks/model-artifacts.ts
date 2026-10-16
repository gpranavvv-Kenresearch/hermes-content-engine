import { FACT_IDS_PREFIX, OUTPUT_BEGIN, OUTPUT_END, TEXT_MARKER } from '../../contracts.js';
import { issue, type Check } from './context.js';

/**
 * Ported (ideas, not code) from the legacy utils/textChecks.ts. Differences:
 *  - the legacy "length < 100 means refusal" rule is NOT ported (see SUSPICIOUSLY_SHORT in review.ts);
 *  - legacy "first,? (step|let's)?" matched any text starting with "First"; fixed;
 *  - "please provide/share" only counts at the START of the text, not as a CTA mid-post;
 *  - prompt-echo markers are derived generically instead of from the old prompt strings.
 */

const norm = (t: string): string => t.trim().toLowerCase().replace(/[‘’]/g, "'");

const REFUSAL_START: RegExp[] = [
  /^(i'm|i am) (sorry|unable)\b/,
  /^i (cannot|can't|can not|won't|will not)\b/,
  /^unfortunately,? (i|we) (cannot|can't|am unable|are unable|do not|don't)\b/,
  /^(sorry|apologies),? (but )?(i|we)\b/,
  /^as an ai\b/,
  /^to (generate|write|produce) this accurately\b/,
  /^to accurately (generate|write|produce)\b/,
  /^please (provide|share|upload|paste|send) (me )?(the|a|an|your|more)\b/,
];

const REFUSAL_ANYWHERE: RegExp[] = [
  /\b(cannot|can't|can not) (complete|fulfil|fulfill) this request\b/,
  /\bdoes not contain any concrete\b/,
  /\bno concrete numbers\b/,
  /\bi need the (ken research|report|source|data)\b/,
  /\bi (don't|do not) have access to\b/,
  /\bwould require me to (guess|invent|fabricate|make up)\b/,
  /\bas an ai (language )?model\b/,
];

export const checkRefusal: Check = (text) => {
  const t = norm(text);
  const hit = REFUSAL_START.find((re) => re.test(t)) ?? REFUSAL_ANYWHERE.find((re) => re.test(t));
  return hit
    ? [issue('REFUSAL', 'hard_fail', 'The text reads as a model refusal or request for more input, not content.', { pattern: hit.source })]
    : [];
};

// Special tokens that leak out of a decoding glitch.
const SPECIAL_TOKEN_SOURCE = '<pad>|<\\/?s>|<unk>|<\\/?eos>|<\\/?bos>|\\[PAD\\]|<\\|[a-z_]+\\|>';

export function stripModelArtifacts(text: string): string {
  return text.replace(new RegExp(SPECIAL_TOKEN_SOURCE, 'gi'), '').replace(/[ \t]{2,}/g, ' ').trim();
}

export const checkDegenerate: Check = (text) => {
  const raw = text.trim();
  const reasons: string[] = [];
  const cleaned = stripModelArtifacts(raw);
  if (new RegExp(SPECIAL_TOKEN_SOURCE, 'i').test(raw)) reasons.push('special_tokens');
  if (cleaned.length < 10) reasons.push('almost_empty');
  else if (cleaned.length < raw.length * 0.5) reasons.push('mostly_junk_tokens');
  // The same word repeated in a long run is a looping decoder, not prose.
  if (/\b([\p{L}\p{N}']{2,})(?:\s+\1\b){7,}/iu.test(raw)) reasons.push('repeated_word_loop');
  // One line repeated many times.
  const lines = raw.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 6) {
    const counts = new Map<string, number>();
    for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
    if (Math.max(...counts.values()) >= Math.ceil(lines.length * 0.6)) reasons.push('repeated_lines');
  }
  return reasons.length > 0
    ? [issue('DEGENERATE_OUTPUT', 'hard_fail', 'The text is degenerate (junk tokens, empty, or looping).', { reasons })]
    : [];
};

const LEAK_START_RE =
  /^(we need to|let'?s (think|analy[sz]e|produce|write|draft|craft|see)|first,? (step|let'?s)\b|okay,? (so|the user|let'?s)|(the )?user (asks|wants|is asking|says|wrote|provided|has (asked|said))|analy[sz]ing the (request|prompt)|here'?s (a |my )?thinking|thinking process)/i;
const THINK_TAG_RE = /<\/?think(ing)?>/i;
const MONOLOGUE_RE =
  /\b(?:so we (?:should|must|need to|will)|must (?:output|ensure)|let'?s see|however,? maybe|possibly|probably|let'?s follow)\b|\bnote:|\bactually,/gi;

export const checkReasoningLeak: Check = (text) => {
  const t = norm(text);
  if (THINK_TAG_RE.test(t)) return [issue('REASONING_LEAK', 'hard_fail', 'Chain-of-thought tags found in the text.', { via: 'think_tag' })];
  if (LEAK_START_RE.test(t)) return [issue('REASONING_LEAK', 'hard_fail', 'The text opens like model reasoning, not content.', { via: 'opening' })];
  const markers = (t.match(MONOLOGUE_RE) ?? []).length;
  if (markers >= 2) return [issue('REASONING_LEAK', 'hard_fail', 'The text contains internal-monologue markers.', { via: 'monologue', markers })];
  return [];
};

/**
 * Generic prompt-echo detection. Instead of listing our own prompt strings, it
 * looks for the SHAPE of instructions: contract markers, role statements,
 * all-caps instruction headings, and imperative output directives. A genuine
 * post essentially never contains these.
 */
const ECHO_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'role_statement', re: /(^|\n)\s*you are (a|an|the) [^\n.]{0,80}\b(writer|assistant|analyst|copywriter|editor|expert|strategist|model)\b/i },
  { id: 'output_directive', re: /\b(output only|respond only|reply only|return only|do not (output|include|add) (any )?(explanations?|preamble|commentary))\b/i },
  // Not any all-caps heading (a real post may say "KEY TAKEAWAYS:"); only instruction-flavoured labels.
  { id: 'caps_rules_label', re: /\b[A-Z]{2,}( [A-Z]{2,})* (RULES?|INSTRUCTIONS?|CONSTRAINTS?)\b|\bHARD LIMIT\b/ },
  { id: 'step_label', re: /(^|\n)\s*STEP \d+\s*[:\-.]/ },
];

export const checkPromptEcho: Check = (text) => {
  const found: string[] = [];
  for (const marker of [OUTPUT_BEGIN, OUTPUT_END, TEXT_MARKER]) if (text.includes(marker)) found.push(`contract_marker:${marker}`);
  if (new RegExp(`(^|\\n)\\s*${FACT_IDS_PREFIX}`, 'i').test(text)) found.push('contract_marker:FACT_IDS');
  for (const p of ECHO_PATTERNS) if (p.re.test(text)) found.push(p.id);
  return found.length > 0
    ? [issue('PROMPT_ECHO', 'hard_fail', 'The text echoes prompt instructions or the output-format markers.', { markers: found })]
    : [];
};

const SAFETY_LABEL_RE = /\b(user|bot|assistant|response)?\s*safety\s*:\s*(safe|unsafe)\b/i;
const SAFETY_ONLY_RE = /^\s*(safe|unsafe)\.?\s*$/i;
const SAFETY_CATEGORY_RE = /\bS(1[0-4]|[1-9])\b[\s,.:-]{0,20}(safe|unsafe)\b|\b(safe|unsafe)\b[\s,.:-]{0,20}\bS(1[0-4]|[1-9])\b/;

export const checkSafetyClassifierLeak: Check = (text) => {
  const t = text.trim();
  const hit =
    SAFETY_LABEL_RE.test(t) ||
    SAFETY_ONLY_RE.test(t) ||
    SAFETY_CATEGORY_RE.test(t) ||
    /content\s*polic(y|ies)\s*violation/i.test(t) ||
    /^\s*(category|classification)\s*:/i.test(t);
  return hit ? [issue('SAFETY_CLASSIFIER_LEAK', 'hard_fail', 'The text is a safety-classifier verdict, not content.')] : [];
};

export const modelArtifactChecks: Check[] = [
  checkSafetyClassifierLeak,
  checkRefusal,
  checkDegenerate,
  checkReasoningLeak,
  checkPromptEcho,
];
