import fs from 'node:fs';
import { OUTPUT_BEGIN, OUTPUT_END, TEXT_MARKER } from '../../../src/contracts.js';
import type { BrowserSessionLike, KeyboardLike, LocatorLike, PageLike, SelectorState } from '../../../src/chatgpt/page-like.js';
import { SELECTORS } from '../../../src/chatgpt/selectors.js';

/**
 * TEST SUPPORT ONLY. A tiny in-memory simulation of the parts of chatgpt.com
 * the driver touches. It launches nothing and uses no network. The "server"
 * keeps conversations alive even when a page object is closed, like the real
 * thing, which is what lets the tests exercise crash/relaunch/resume.
 *
 * Streaming is driven by tick(): tests pass `sleep: async () => server.tick()`
 * so each poll of the driver reveals the next chunk of the scripted reply.
 */

export type FakeMode = 'ready' | 'login' | 'challenge' | 'rate_limit' | 'ui_changed';

interface FakeMessage {
  role: 'user' | 'assistant';
  text: string;
}

interface FakeConversation {
  id: string;
  messages: FakeMessage[];
  pendingChunks: string[];
  generating: boolean;
}

export interface FakeSubmission {
  conversationId: string;
  composerText: string;
  attachedFiles: string[];
  attachedContents: string[];
}

export const okReply = (text: string): string[] => [
  `${OUTPUT_BEGIN}\nFACT_IDS: f1, f2\n${TEXT_MARKER}\n${text.slice(0, Math.ceil(text.length / 2))}`,
  `${text.slice(Math.ceil(text.length / 2))}\n${OUTPUT_END}`,
];

export function timeoutError(ms = 1): Error {
  return Object.assign(new Error(`Timeout ${ms}ms exceeded.`), { name: 'TimeoutError' });
}

export function targetClosedError(): Error {
  return Object.assign(new Error('Target page, context or browser has been closed'), { name: 'TargetClosedError' });
}

export class FakeChatGptServer {
  mode: FakeMode = 'ready';
  /** Text shown in a modal when mode is 'rate_limit'. */
  dialogText = 'Too many requests. You are making requests too quickly. Please try again in 2 minutes.';
  /** Toolbar chrome that leaks into innerText once a reply finishes. */
  finishedSuffix = '\nCopy\nShare';
  /** When false the URL stays on /new after submit (simulates a missed /c/<id> assignment). */
  assignConversationUrl = true;
  /** When true, submitting makes the rate-limit modal appear and no reply is produced. */
  rateLimitOnSubmit = false;
  readonly conversations = new Map<string, FakeConversation>();
  readonly submissions: FakeSubmission[] = [];
  readonly pages: FakePage[] = [];
  private scripts: string[][] = [];
  private nextId = 1;
  private ticks = 0;
  private crashAtTick: number | undefined;

  /** Queue the chunks the NEXT submission will stream. */
  queueReply(chunks: string[]): void {
    this.scripts.push(chunks);
  }

  /** Close every open page when the n-th tick happens (browser dies mid-generation). */
  crashOnTick(n: number): void {
    this.crashAtTick = n;
  }

  newPage(): FakePage {
    const p = new FakePage(this);
    this.pages.push(p);
    return p;
  }

  nextScript(): string[] {
    return this.scripts.shift() ?? okReply('default reply');
  }

  createConversation(): FakeConversation {
    const conv: FakeConversation = { id: `conv${this.nextId++}`, messages: [], pendingChunks: [], generating: false };
    this.conversations.set(conv.id, conv);
    return conv;
  }

  tick(): void {
    this.ticks++;
    for (const conv of this.conversations.values()) {
      if (!conv.generating) continue;
      const assistant = [...conv.messages].reverse().find((m) => m.role === 'assistant');
      const chunk = conv.pendingChunks.shift();
      if (assistant && chunk !== undefined) assistant.text += chunk;
      if (conv.pendingChunks.length === 0) conv.generating = false;
    }
    if (this.crashAtTick !== undefined && this.ticks === this.crashAtTick) {
      for (const p of this.pages) p.crash();
    }
  }
}

class FakeLocator implements LocatorLike {
  constructor(
    private readonly page: FakePage,
    private readonly selector: string,
  ) {}

  first(): LocatorLike {
    return this;
  }
  last(): LocatorLike {
    return this;
  }
  async count(): Promise<number> {
    this.page.assertOpen();
    return this.page.matchesGroup(this.selector, 'assistantMessage')
      ? (this.page.conversation?.messages.filter((m) => m.role === 'assistant').length ?? 0)
      : 1;
  }
  async innerText(): Promise<string> {
    this.page.assertOpen();
    return this.page.textOf(this.selector);
  }
  async isVisible(): Promise<boolean> {
    this.page.assertOpen();
    return this.page.isMatch(this.selector, 'visible');
  }
  async click(): Promise<void> {
    await this.page.click(this.selector);
  }
  async setInputFiles(files: string | string[]): Promise<void> {
    this.page.assertOpen();
    for (const f of Array.isArray(files) ? files : [files]) this.page.attach(f);
  }
}

export class FakePage implements PageLike {
  readonly keyboard: KeyboardLike;
  /** Calls to the forbidden fill() (not part of PageLike; the driver must never reach it). */
  fillCalls = 0;
  composerText = '';
  attachedFiles: string[] = [];
  attachedContents: string[] = [];
  conversation: FakeConversation | undefined;
  readonly gotoLog: string[] = [];
  private currentUrl = 'about:blank';
  private closed = false;

  constructor(readonly server: FakeChatGptServer) {
    this.keyboard = {
      type: async (text) => {
        this.assertOpen();
        this.composerText += text;
      },
      insertText: async (text) => {
        this.assertOpen();
        this.composerText += text;
      },
      press: async (key) => {
        this.assertOpen();
        if (key === 'Shift+Enter') this.composerText += '\n';
        else if (key === 'Enter') this.submit();
      },
    };
  }

  /** Forbidden API; present only so a regression is observable. */
  async fill(): Promise<void> {
    this.fillCalls++;
    throw new Error('page.fill() must never be used on the ChatGPT composer');
  }

  crash(): void {
    this.closed = true;
  }

  assertOpen(): void {
    if (this.closed) throw targetClosedError();
  }

  url(): string {
    return this.currentUrl;
  }
  isClosed(): boolean {
    return this.closed;
  }
  async title(): Promise<string> {
    this.assertOpen();
    return 'ChatGPT';
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async screenshot(): Promise<Uint8Array> {
    this.assertOpen();
    return new Uint8Array([1, 2, 3]);
  }

  async goto(url: string): Promise<unknown> {
    this.assertOpen();
    this.gotoLog.push(url);
    this.currentUrl = url;
    this.composerText = '';
    this.attachedFiles = [];
    const m = /\/c\/([\w-]+)/.exec(url);
    this.conversation = m ? this.server.conversations.get(m[1]!) : undefined;
    return null;
  }
  async reload(): Promise<unknown> {
    this.assertOpen();
    return null;
  }

  // --- selector semantics ---------------------------------------------------------------

  matchesGroup(selector: string, group: keyof typeof SELECTORS): boolean {
    return (SELECTORS[group] as ReadonlyArray<{ css: string }>).some((s) => s.css === selector);
  }

  isMatch(selector: string, _state: SelectorState): boolean {
    const mode = this.server.mode;
    if (selector === 'body') return true;
    if (selector.startsWith('text=')) return this.attachedFiles.length > 0;
    if (this.matchesGroup(selector, 'fileInput')) return true;
    if (this.matchesGroup(selector, 'composer')) return mode === 'ready' || mode === 'login' || mode === 'rate_limit';
    if (this.matchesGroup(selector, 'sendButton')) {
      return mode === 'ready' && (this.composerText.length > 0 || this.attachedFiles.length > 0) && !this.conversation?.generating;
    }
    if (this.matchesGroup(selector, 'stopButton')) return this.conversation?.generating === true;
    if (this.matchesGroup(selector, 'assistantMessage')) {
      return selector === SELECTORS.assistantMessage[0].css && (this.conversation?.messages.some((m) => m.role === 'assistant') ?? false);
    }
    if (selector === SELECTORS.loginButton[0].css) return mode === 'login';
    if (selector === SELECTORS.challenge[0].css) return mode === 'challenge';
    if (selector === SELECTORS.noticeDialog[0].css) return mode === 'rate_limit';
    return false;
  }

  textOf(selector: string): string {
    if (this.matchesGroup(selector, 'composer')) return this.composerText;
    if (this.matchesGroup(selector, 'assistantMessage')) {
      const last = [...(this.conversation?.messages ?? [])].reverse().find((m) => m.role === 'assistant');
      if (!last) return '';
      return last.text + (this.conversation?.generating ? '' : this.server.finishedSuffix);
    }
    if (this.matchesGroup(selector, 'noticeDialog')) return this.server.mode === 'rate_limit' ? this.server.dialogText : '';
    if (selector === 'body') {
      switch (this.server.mode) {
        case 'login':
          return 'Log in Sign up Stay logged out';
        case 'challenge':
          return 'Verify you are human';
        case 'rate_limit':
          return this.server.dialogText;
        case 'ui_changed':
          return 'Something unfamiliar';
        default:
          return `ChatGPT ${this.conversation?.messages.map((m) => m.text).join(' ') ?? ''}`;
      }
    }
    return '';
  }

  async waitForSelector(selector: string, options?: { state?: SelectorState; timeout?: number }): Promise<unknown> {
    this.assertOpen();
    if (this.isMatch(selector, options?.state ?? 'visible')) return {};
    throw timeoutError(options?.timeout ?? 0);
  }

  locator(selector: string): LocatorLike {
    return new FakeLocator(this, selector);
  }

  async click(selector: string): Promise<void> {
    this.assertOpen();
    if (this.matchesGroup(selector, 'sendButton')) this.submit();
  }

  attach(filePath: string): void {
    this.attachedFiles.push(filePath);
    try {
      this.attachedContents.push(fs.readFileSync(filePath, 'utf8'));
    } catch {
      this.attachedContents.push('');
    }
  }

  private submit(): void {
    if (this.composerText.length === 0 && this.attachedFiles.length === 0) return;
    const conv = this.conversation ?? this.server.createConversation();
    this.conversation = conv;
    conv.messages.push({ role: 'user', text: this.composerText });
    if (this.server.rateLimitOnSubmit) {
      this.server.mode = 'rate_limit';
      this.server.submissions.push({
        conversationId: conv.id,
        composerText: this.composerText,
        attachedFiles: [...this.attachedFiles],
        attachedContents: [...this.attachedContents],
      });
      this.composerText = '';
      return;
    }
    conv.messages.push({ role: 'assistant', text: '' });
    conv.pendingChunks = [...this.server.nextScript()];
    conv.generating = true;
    this.server.submissions.push({
      conversationId: conv.id,
      composerText: this.composerText,
      attachedFiles: [...this.attachedFiles],
      attachedContents: [...this.attachedContents],
    });
    this.composerText = '';
    this.attachedFiles = [];
    this.attachedContents = [];
    if (this.server.assignConversationUrl) this.currentUrl = `https://chatgpt.com/c/${conv.id}`;
  }
}

export class FakeSession implements BrowserSessionLike {
  relaunchCount = 0;
  closeCount = 0;
  private page: FakePage;

  constructor(readonly server: FakeChatGptServer) {
    this.page = server.newPage();
  }

  async getPage(): Promise<PageLike> {
    if (this.page.isClosed()) this.page = this.server.newPage();
    return this.page;
  }

  async relaunch(): Promise<void> {
    this.relaunchCount++;
    await this.page.close();
    this.page = this.server.newPage();
  }

  async close(): Promise<void> {
    this.closeCount++;
    await this.page.close();
  }

  get currentPage(): FakePage {
    return this.page;
  }
}
