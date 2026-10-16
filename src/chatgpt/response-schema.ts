import { OUTPUT_BEGIN, OUTPUT_END, parseModelOutput } from '../contracts.js';

export {
  FACT_IDS_PREFIX,
  OUTPUT_BEGIN,
  OUTPUT_END,
  TEXT_MARKER,
  outputFormatInstruction,
  parseModelOutput,
} from '../contracts.js';
export type { ModelOutput, ParseOutcome } from '../contracts.js';

export type CompletenessReason = 'ok' | 'empty' | 'missing_begin' | 'missing_end' | 'missing_text' | 'empty_text';

export interface Completeness {
  complete: boolean;
  reason: CompletenessReason;
}

/**
 * Is this reply a COMPLETE reply in the CE output format? A missing end marker
 * means truncated or still streaming and is never complete.
 */
export function assessCompleteness(text: string): Completeness {
  if (text.trim().length === 0) return { complete: false, reason: 'empty' };
  const parsed = parseModelOutput(text);
  return parsed.ok ? { complete: true, reason: 'ok' } : { complete: false, reason: parsed.reason };
}

/** True when the prompt asked for the CE output format (so an end marker must be present). */
export function promptDemandsOutputFormat(prompt: string): boolean {
  return prompt.includes(OUTPUT_BEGIN) && prompt.includes(OUTPUT_END);
}

/**
 * Is `marker` present in a way that proves the reply finished? For OUTPUT_END
 * it must come AFTER the last OUTPUT_BEGIN, because the model may echo the
 * instruction template (which contains both markers) before the real reply.
 */
export function hasEndMarker(text: string, marker: string): boolean {
  if (marker === OUTPUT_END) {
    const begin = text.lastIndexOf(OUTPUT_BEGIN);
    return text.indexOf(OUTPUT_END, begin < 0 ? 0 : begin + OUTPUT_BEGIN.length) >= 0;
  }
  return text.includes(marker);
}
