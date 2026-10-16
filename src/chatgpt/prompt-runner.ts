import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OUTPUT_END, type LlmProvider, type LlmRequest, type LlmResult } from '../contracts.js';
import { EngineError } from '../errors.js';
import type { Budget } from '../safety/budget.js';
import type { ShutdownController } from '../safety/shutdown.js';
import { timeoutPolicy, withTimeout } from '../safety/timeouts.js';
import type { BrowserSessionLike, PageLike } from './page-like.js';
import {
  RecoveryPolicy,
  classifyBrowserError,
  createRecoveryPolicy,
  needsRelaunch,
} from './recovery-policy.js';
import {
  inspectGeneration,
  readAssistant,
  waitForReply,
  type ReplyCapture,
} from './response-capture.js';
import { assessCompleteness, promptDemandsOutputFormat } from './response-schema.js';
import { realHumanDelay, realSleep, noopLogger, safeUrl, type HumanDelayFn, type LoggerLike, type SleepFn } from './runtime.js';
import { isPresent, waitForFirst } from './selectors.js';
import {
  checkHealth,
  detectRateLimitText,
  healthToError,
  type DiagnosticWriter,
} from './session-health.js';

export const CHATGPT_PROVIDER_ID = 'chatgpt-browser';

const CONVERSATION_URL_RE = /\/c\/[\w-]+/;
const ATTACH_INSTRUCTION =
  'Execute the attached instructions immediately. Follow the attached file exactly, including its required reply format, and reply with nothing else.';

export interface PromptFile {
  path: string;
  filename: string;
  cleanup(): Promise<void>;
}

export type PromptFileWriter = (text: string) => Promise<PromptFile>;

/** Default: writes the prompt to a unique .txt file in a private temp dir. */
export const defaultPromptFileWriter: PromptFileWriter = async (text) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ce-chatgpt-'));
  const filename = `ce-prompt-${Date.now()}.txt`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, text, 'utf8');
  return { path: filePath, filename, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
};

export interface ChatGptProviderOptions {
  session: BrowserSessionLike;
  budget?: Budget;
  shutdown?: ShutdownController;
  logger?: LoggerLike;
  recovery?: RecoveryPolicy;
  diagnosticWriter?: DiagnosticWriter;
  /** Prompts longer than this are attached as a .txt file instead of typed. Default 6000 chars. */
  longPromptThreshold?: number;
  pollMs?: number;
  stablePolls?: number;
  /** Fraction of the prompt that must be visible in the composer after typing. Default 0.5. */
  composerMinFillRatio?: number;
  baseUrl?: string;
  timeouts?: Partial<typeof timeoutPolicy>;
  sleep?: SleepFn;
  humanDelay?: HumanDelayFn;
  now?: () => number;
  writePromptFile?: PromptFileWriter;
  /** Max polls (x pollMs) waiting for the /c/<id> URL to appear after submit. Default 20. */
  conversationUrlPolls?: number;
}

/** State that survives across the retry attempts of ONE generate() call. */
interface CallState {
  /** True once the send click may have happened. After this the prompt is never typed/sent again. */
  submitted: boolean;
  baselineAssistantCount: number;
  conversationUrl: string | undefined;
  pendingRelaunch: boolean;
  /** True once the browser was relaunched, i.e. the page we had is gone. */
  relaunched: boolean;
}

export class ChatGptProvider implements LlmProvider {
  readonly id = CHATGPT_PROVIDER_ID;

  private readonly session: BrowserSessionLike;
  private readonly budget: Budget | undefined;
  private readonly shutdown: ShutdownController | undefined;
  private readonly log: LoggerLike;
  private readonly recovery: RecoveryPolicy;
  private readonly writer: DiagnosticWriter | undefined;
  private readonly longThreshold: number;
  private readonly pollMs: number;
  private readonly stablePolls: number;
  private readonly minFill: number;
  private readonly baseUrl: string;
  private readonly timeouts: typeof timeoutPolicy;
  private readonly sleep: SleepFn;
  private readonly humanDelay: HumanDelayFn;
  private readonly now: () => number;
  private readonly writePromptFile: PromptFileWriter;
  private readonly conversationUrlPolls: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ChatGptProviderOptions) {
    this.session = options.session;
    this.budget = options.budget;
    this.shutdown = options.shutdown;
    this.log = options.logger ?? noopLogger;
    this.recovery = options.recovery ?? createRecoveryPolicy();
    this.writer = options.diagnosticWriter;
    this.longThreshold = options.longPromptThreshold ?? 6_000;
    this.pollMs = options.pollMs ?? 2_000;
    this.stablePolls = options.stablePolls ?? 3;
    this.minFill = options.composerMinFillRatio ?? 0.5;
    this.baseUrl = (options.baseUrl ?? 'https://chatgpt.com').replace(/\/+$/, '');
    this.timeouts = { ...timeoutPolicy, ...options.timeouts };
    this.sleep = options.sleep ?? realSleep;
    this.humanDelay = options.humanDelay ?? realHumanDelay;
    this.now = options.now ?? Date.now;
    this.writePromptFile = options.writePromptFile ?? defaultPromptFileWriter;
    this.conversationUrlPolls = options.conversationUrlPolls ?? 20;
  }

  /** Circuit-breaker view for dashboards / callers deciding whether to route elsewhere. */
  get accountPaused(): boolean {
    return this.recovery.isPaused;
  }

  get breakerState() {
    return this.recovery.breakerState;
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    this.shutdown?.assertRunning();
    this.budget?.consume();

    // One browser page: generations are strictly serialised.
    const run = this.queue.then(() => this.generateSerialised(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async generateSerialised(request: LlmRequest): Promise<LlmResult> {
    this.shutdown?.assertRunning();
    const started = this.now();
    const work = async (): Promise<LlmResult> => {
      const expectFormat = promptDemandsOutputFormat(request.prompt);
      const state: CallState = {
        submitted: false,
        baselineAssistantCount: 0,
        conversationUrl: undefined,
        pendingRelaunch: false,
        relaunched: false,
      };
      const replyTimeout = request.expectLong ? this.timeouts.chatGptLongReply : this.timeouts.chatGptShortReply;

      const reply = await this.recovery.execute(async ({ attempt }) => {
        try {
          return await withTimeout(
            `chatgpt.generate[${request.purpose}]#${attempt}`,
            replyTimeout + 3 * this.timeouts.navigation,
            (signal) => this.attempt(request, state, replyTimeout, expectFormat, signal),
          );
        } catch (e) {
          const classified = classifyBrowserError(e);
          if (needsRelaunch(classified)) state.pendingRelaunch = true;
          this.log.warn({ purpose: request.purpose, attempt, code: classified.code, category: classified.category }, 'chatgpt attempt failed');
          throw classified;
        }
      });

      const complete = reply.complete && (!expectFormat || assessCompleteness(reply.text).complete);
      return { text: reply.text, complete, provider: CHATGPT_PROVIDER_ID, elapsedMs: this.now() - started };
    };
    return this.shutdown ? this.shutdown.track(work) : work();
  }

  // --- one attempt ---------------------------------------------------------------------

  private checkAbort(signal: AbortSignal, request: LlmRequest): void {
    signal.throwIfAborted();
    request.signal?.throwIfAborted();
  }

  private async attempt(
    request: LlmRequest,
    state: CallState,
    replyTimeout: number,
    expectFormat: boolean,
    signal: AbortSignal,
  ): Promise<ReplyCapture> {
    if (state.pendingRelaunch) {
      this.log.warn({ purpose: request.purpose }, 'relaunching browser session');
      await this.session.relaunch();
      state.pendingRelaunch = false;
      state.relaunched = true;
    }
    this.checkAbort(signal, request);
    const page = await this.session.getPage();

    const waitOptions = {
      ...(expectFormat ? { expectedEndMarker: OUTPUT_END } : {}),
      timeoutMs: replyTimeout,
      pollMs: this.pollMs,
      stablePolls: this.stablePolls,
      sleep: this.sleep,
      now: this.now,
      signal,
    };

    // DUPLICATE-GENERATION GUARD: if the send may already have happened, never resend; inspect and resume.
    if (state.submitted) {
      const resumed = await this.resume(page, state, waitOptions, signal);
      if (resumed) return resumed;
      this.log.warn({ purpose: request.purpose }, 'previous submit never took effect; starting fresh');
    }

    await this.ensureOnChatGpt(page);
    await this.requireHealthy(page);
    await this.dismissNotices(page);
    await this.openNewChat(page);
    this.checkAbort(signal, request);

    if (request.prompt.length > this.longThreshold) await this.deliverAsFile(page, request.prompt);
    else await this.deliverTyped(page, request.prompt);
    this.checkAbort(signal, request);

    state.baselineAssistantCount = (await readAssistant(page)).count;
    await this.submit(page, state, signal);
    await this.captureConversationUrl(page, state);

    return waitForReply(page, {
      ...waitOptions,
      baselineAssistantCount: state.baselineAssistantCount,
      blockerCheck: () => this.throwIfRateLimited(page),
    });
  }

  private async resume(
    page: PageLike,
    state: CallState,
    waitOptions: Omit<Parameters<typeof waitForReply>[1], 'baselineAssistantCount' | 'blockerCheck'>,
    signal: AbortSignal,
  ): Promise<ReplyCapture | undefined> {
    const target = state.conversationUrl ? safeUrl(state.conversationUrl) : undefined;
    if (target) {
      if (!page.url().startsWith(target)) {
        await page.goto(state.conversationUrl!, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigation });
      }
    } else if (state.relaunched) {
      throw this.duplicateRisk('browser was relaunched after the send and the conversation URL was never captured');
    }

    let inspection = await inspectGeneration(page, state.baselineAssistantCount);
    if (inspection.state === 'none') {
      const onConversation = target !== undefined || CONVERSATION_URL_RE.test(page.url());
      if (!onConversation) {
        // Observed directly on a live page that is still on the new-chat URL: the send never happened.
        state.submitted = false;
        return undefined;
      }
      // Conversation exists but no reply is visible yet: give the UI a few polls before concluding anything.
      for (let i = 0; i < 5 && inspection.state === 'none'; i++) {
        signal.throwIfAborted();
        await this.sleep(this.pollMs);
        inspection = await inspectGeneration(page, state.baselineAssistantCount);
      }
      if (inspection.state === 'none') {
        throw this.duplicateRisk('a conversation exists but shows no reply and no generation; refusing to resubmit');
      }
    }
    this.log.info({ state: inspection.state }, 'resuming capture of existing generation');
    return waitForReply(page, {
      ...waitOptions,
      baselineAssistantCount: state.baselineAssistantCount,
      blockerCheck: () => this.throwIfRateLimited(page),
    });
  }

  private duplicateRisk(why: string): EngineError {
    return new EngineError(
      `Prompt may already have been submitted; ${why}. Check the ChatGPT history manually before re-running.`,
      'needs_human',
      'DUPLICATE_RISK',
    );
  }

  // --- steps ---------------------------------------------------------------------------

  private async ensureOnChatGpt(page: PageLike): Promise<void> {
    if (!page.url().startsWith(this.baseUrl)) {
      await page.goto(`${this.baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigation });
    }
  }

  private async requireHealthy(page: PageLike): Promise<void> {
    const options = this.writer ? { writer: this.writer } : {};
    let report = await checkHealth(page, options);
    if (report.state === 'unknown_ui') {
      // A stuck SPA render is fixed far more reliably by a reload than by waiting longer (legacy finding).
      await page.reload({ waitUntil: 'domcontentloaded', timeout: this.timeouts.navigation });
      await this.humanDelay(2_000, 4_000);
      report = await checkHealth(page, options);
    }
    const err = healthToError(report);
    if (err) throw err;
  }

  /** Best-effort: dismiss "Got it"-style notices. Absence is the normal case. */
  private async dismissNotices(page: PageLike): Promise<void> {
    const btn = await isPresent(page, 'dismissButton', { timeoutMs: 300 });
    if (btn) {
      await page.click(btn.css, { timeout: this.timeouts.pageAction }).catch(() => undefined);
      await this.humanDelay(300, 700);
    }
  }

  private async openNewChat(page: PageLike): Promise<void> {
    // /new (not /) forces a brand-new conversation instead of landing on the last one.
    await page.goto(`${this.baseUrl}/new`, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigation });
    try {
      await waitForFirst(page, 'composer', { timeoutMs: 20_000 });
    } catch (e) {
      if (!(e instanceof EngineError) || e.code !== 'SELECTOR_NOT_FOUND') throw e;
      // Fallback: click the in-app New chat control, then require the composer again.
      const nc = await waitForFirst(page, 'newChat', { timeoutMs: 5_000 });
      await page.click(nc.css, { timeout: this.timeouts.pageAction });
      await this.humanDelay(800, 1_500);
      await waitForFirst(page, 'composer', { timeoutMs: 20_000 });
    }
  }

  /** Short prompts: click the composer and insert the text line by line. NEVER page.fill(). */
  private async deliverTyped(page: PageLike, prompt: string): Promise<void> {
    const composer = await waitForFirst(page, 'composer', { timeoutMs: this.timeouts.pageAction });
    await page.click(composer.css, { timeout: this.timeouts.pageAction });
    await this.humanDelay(300, 700);

    const lines = prompt.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > 0) await page.keyboard.insertText(line);
      if (i < lines.length - 1) await page.keyboard.press('Shift+Enter'); // plain Enter would submit
    }
    await this.humanDelay(400, 900);

    const typed = await page
      .locator(composer.css)
      .first()
      .innerText({ timeout: this.timeouts.pageAction })
      .then((t) => t.length)
      .catch(() => 0);
    if (typed < prompt.length * this.minFill) {
      throw new EngineError(
        `Prompt did not land in the ChatGPT composer (${typed}/${prompt.length} chars)`,
        'retryable',
        'PROMPT_NOT_DELIVERED',
      );
    }
  }

  /** Long prompts: attach as a .txt file via the hidden file input, then send a one-line instruction. */
  private async deliverAsFile(page: PageLike, prompt: string): Promise<void> {
    const composer = await waitForFirst(page, 'composer', { timeoutMs: this.timeouts.pageAction });
    let input;
    try {
      input = await waitForFirst(page, 'fileInput', { state: 'attached', timeoutMs: 10_000 });
    } catch (e) {
      if (!(e instanceof EngineError) || e.code !== 'SELECTOR_NOT_FOUND') throw e;
      this.log.warn({}, 'no file input found; falling back to typing the long prompt');
      return this.deliverTyped(page, prompt);
    }

    const file = await this.writePromptFile(prompt);
    try {
      await page.locator(input.css).first().setInputFiles(file.path, { timeout: this.timeouts.pageAction });
      // Attachment chip is best-effort evidence only.
      await page
        .waitForSelector(`text=${file.filename.slice(0, 20)}`, { state: 'visible', timeout: 8_000 })
        .catch(() => undefined);
      await this.humanDelay(1_500, 2_500);

      await page.click(composer.css, { timeout: this.timeouts.pageAction });
      await this.humanDelay(300, 700);
      await page.keyboard.insertText(ATTACH_INSTRUCTION);
      // Sending too soon after attaching can silently no-op (legacy finding 2026-09-28).
      await this.humanDelay(3_000, 5_000);
    } finally {
      await file.cleanup().catch(() => undefined);
    }
  }

  private async submit(page: PageLike, state: CallState, signal: AbortSignal): Promise<void> {
    const send = await waitForFirst(page, 'sendButton', { timeoutMs: 30_000 });
    signal.throwIfAborted(); // after this point the send may happen, so a late abort must not slip in between
    await this.humanDelay(400, 900);
    // Conservative: from here on a crash is ambiguous, so the prompt must never be sent a second time.
    state.submitted = true;
    await page.click(send.css, { timeout: this.timeouts.pageAction });
  }

  private async captureConversationUrl(page: PageLike, state: CallState): Promise<void> {
    for (let i = 0; i < this.conversationUrlPolls; i++) {
      const url = page.url();
      if (CONVERSATION_URL_RE.test(url)) {
        state.conversationUrl = url;
        return;
      }
      await this.sleep(500);
    }
  }

  /** Looks for a rate-limit notice inside modal/alert containers only (the body also holds our own prompt text). */
  private async throwIfRateLimited(page: PageLike): Promise<void> {
    const dialog = await isPresent(page, 'noticeDialog', { timeoutMs: 150 });
    if (!dialog) return;
    const text = await page
      .locator(dialog.css)
      .first()
      .innerText({ timeout: 3_000 })
      .catch((e: unknown) => {
        if (page.isClosed()) throw e;
        return '';
      });
    const rate = detectRateLimitText(text);
    if (rate) {
      throw new EngineError(`ChatGPT rate limit after submit ("${rate.matched}")`, 'rate_limited', 'RATE_LIMITED', {
        ...(rate.retryAfterMs === undefined ? {} : { retryAfterMs: rate.retryAfterMs }),
      });
    }
  }
}
