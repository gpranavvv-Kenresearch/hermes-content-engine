import { TimeoutError } from '../errors.js';
import type { PageLike } from './page-like.js';
import { hasEndMarker } from './response-schema.js';
import { realSleep, type SleepFn } from './runtime.js';
import { isPresent } from './selectors.js';

// --- Scraping-artifact cleaning (ported from the legacy sanitize code) ---------

const TOOLBAR_LABELS = ['Edit', 'Copy', 'Copy code', 'Regenerate', 'Regenerate response', 'Share', 'Good response', 'Bad response', 'Read aloud'];
const TOOLBAR_SET = new Set(TOOLBAR_LABELS.map((l) => l.toLowerCase()));

/** Shape of the file-attachment pill ChatGPT prints for an attached prompt file (legacy FILE_PILL_RE + our own prefix). */
const FILE_PILL_RE = /[ \t]*(?:chatgpt-prompt|ce-prompt)-\d{6,}[^\s<>"']*…?/gi;
/**
 * ChatGPT's internal tool/citation markup, matched by SHAPE not by name (the
 * spelling keeps changing): optional colon, hyphenated identifier, optional
 * [..] part, and a {..} group containing "index". Ported from sanitizeHtml().
 */
const TOOL_MARKUP_RE = /[ \t]*:?[\w-]+(?:\[[^\]]*\])?\{[^}]*index[^}]*\}/gi;
/** A citation pill that is a domain followed by a count, e.g. "kenresearch.com +1". */
const DOMAIN_CHIP_LINE_RE = /^[ \t]*(?:[a-z0-9-]+\.)+[a-z]{2,}[ \t]*\+\d+[ \t]*$/i;
const COUNT_ONLY_LINE_RE = /^[ \t]*\+\d+[ \t]*$/;
/** "Source Name" line immediately followed by a bare "+N" line. */
const NAME_THEN_COUNT_RE = /\n[ \t]*[A-Z][\w&.,'-]*(?: [A-Z][\w&.,'-]*){0,4}\n[ \t]*\+\d+(?=\n|$)/g;

function stripToolbarEdges(text: string): string {
  const lines = text.split('\n');
  const isToolbar = (l: string) => TOOLBAR_SET.has(l.trim().toLowerCase());
  while (lines.length > 0 && (lines[0]!.trim() === '' || isToolbar(lines[0]!))) lines.shift();
  while (lines.length > 0 && (lines[lines.length - 1]!.trim() === '' || isToolbar(lines[lines.length - 1]!))) lines.pop();
  return lines.join('\n');
}

/**
 * Removes UI chrome and tool markup from a scraped assistant message:
 * citation chips ("domain +N", "+N", "Name\n+N"), toolbar labels at the start
 * or end, chatgpt-content-reference / oaicite markup, the prompt-file pill,
 * utm_source=chatgpt.com, and the %22 attribute-quote glitch. It never touches
 * the CE output markers.
 *
 * Deviation from the legacy code: bare domain lines are NOT removed (only
 * "domain +N"), and toolbar labels are removed only at the very start/end of
 * the message, so legitimate content lines are not eaten.
 */
export function cleanReplyText(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n');
  text = text.replace(NAME_THEN_COUNT_RE, '');
  text = text
    .split('\n')
    .filter((l) => !DOMAIN_CHIP_LINE_RE.test(l) && !COUNT_ONLY_LINE_RE.test(l))
    .join('\n');
  text = text.replace(TOOL_MARKUP_RE, '').replace(FILE_PILL_RE, '');
  text = text.replace(/\?utm_source=chatgpt\.com&/gi, '?').replace(/[?&]utm_source=chatgpt\.com/gi, '');
  text = text.replace(/%22(?=[\s>])/g, '"').replace(/%22$/g, '"');
  text = stripToolbarEdges(text);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// --- Reading the page -------------------------------------------------------------

export interface AssistantSnapshot {
  count: number;
  /** Raw innerText of the LAST assistant message ('' when none). */
  text: string;
}

export async function readAssistant(page: PageLike): Promise<AssistantSnapshot> {
  const found = await isPresent(page, 'assistantMessage', { state: 'attached', timeoutMs: 150 });
  if (!found) return { count: 0, text: '' };
  const loc = page.locator(found.css);
  const count = await loc.count();
  if (count === 0) return { count: 0, text: '' };
  const text = await loc.last().innerText({ timeout: 5_000 }).catch((e: unknown) => {
    if (page.isClosed()) throw e;
    return '';
  });
  return { count, text };
}

export type GenerationState = 'generating' | 'finished' | 'none';

export interface GenerationInspection {
  state: GenerationState;
  assistantCount: number;
  textLength: number;
}

/**
 * Looks at the page without touching it: is a reply being generated, already
 * finished, or absent? This is the duplicate-generation guard's eyes.
 */
export async function inspectGeneration(page: PageLike, baselineAssistantCount: number): Promise<GenerationInspection> {
  const stop = await isPresent(page, 'stopButton');
  const snap = await readAssistant(page);
  const hasReply = snap.count > baselineAssistantCount;
  if (stop) return { state: 'generating', assistantCount: snap.count, textLength: snap.text.length };
  if (hasReply && snap.text.trim().length > 0) return { state: 'finished', assistantCount: snap.count, textLength: snap.text.length };
  return { state: 'none', assistantCount: snap.count, textLength: snap.text.length };
}

// --- Waiting for the reply ------------------------------------------------------------

export interface WaitForReplyOptions {
  /** When the prompt demanded the CE format, pass OUTPUT_END; absence after the reply settles means truncation. */
  expectedEndMarker?: string;
  timeoutMs: number;
  pollMs: number;
  /** Consecutive polls with unchanged text length (and no stop button) required to call the reply settled. */
  stablePolls: number;
  /** Replies only count when there are MORE assistant messages than this (messages present before submit). */
  baselineAssistantCount?: number;
  sleep?: SleepFn;
  now?: () => number;
  signal?: AbortSignal;
  /** Called on polls where no new assistant message exists yet; throw to abort (e.g. rate-limit notice). */
  blockerCheck?: () => Promise<void>;
}

export type ReplyEndReason = 'done' | 'missing_end_marker';

export interface ReplyCapture {
  /** Cleaned text. */
  text: string;
  complete: boolean;
  reason: ReplyEndReason;
  polls: number;
  stopSeen: boolean;
  rawLength: number;
}

/**
 * Waits until: the stop button is gone AND the assistant text length has been
 * stable for `stablePolls` polls AND (if requested) the end marker is present.
 * A settled reply WITHOUT its end marker is returned complete:false
 * (truncated), never as if complete. If the deadline passes while still
 * generating (or nothing ever appeared) a retryable TimeoutError is thrown so
 * recovery can resume instead of resubmitting. Never uses networkidle.
 */
export async function waitForReply(page: PageLike, options: WaitForReplyOptions): Promise<ReplyCapture> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const baseline = options.baselineAssistantCount ?? 0;
  const deadline = now() + options.timeoutMs;

  let prevLen = -1;
  let stable = 0;
  let polls = 0;
  let stopSeen = false;

  for (;;) {
    options.signal?.throwIfAborted();
    polls++;

    const stop = await isPresent(page, 'stopButton');
    if (stop) stopSeen = true;
    const snap = await readAssistant(page);
    const hasReply = snap.count > baseline;

    if (!hasReply && !stop) await options.blockerCheck?.();

    const len = snap.text.length;
    const settledNow = hasReply && !stop && snap.text.trim().length > 0 && len === prevLen;
    stable = settledNow ? stable + 1 : 0;
    prevLen = hasReply ? len : -1;

    if (stable >= options.stablePolls) {
      const text = cleanReplyText(snap.text);
      const marker = options.expectedEndMarker;
      const markerOk = marker === undefined ? true : hasEndMarker(snap.text, marker);
      return {
        text,
        complete: markerOk && text.length > 0,
        reason: markerOk ? 'done' : 'missing_end_marker',
        polls,
        stopSeen,
        rawLength: snap.text.length,
      };
    }

    if (now() >= deadline) {
      throw new TimeoutError('chatgpt reply', options.timeoutMs);
    }
    await sleep(options.pollMs);
  }
}
