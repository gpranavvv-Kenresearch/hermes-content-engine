import { EngineError } from '../errors.js';
import type { PageLike, SelectorState } from './page-like.js';

/**
 * ORDERED fallback selector lists. Names are for diagnostics only. Ported from
 * the legacy driver (promptRunner.ts, login.ts, blogGenAgent.ts). Order matters:
 * the most specific / most recently confirmed selector first.
 *
 * Every selector is used only after page.waitForSelector() has resolved it
 * (see waitForFirst / isPresent below). All of this is UNVERIFIED against the
 * live ChatGPT UI from this repo; the legacy confirmations date from 2026-09.
 */
export interface NamedSelector {
  readonly name: string;
  readonly css: string;
}

const s = (name: string, css: string): NamedSelector => ({ name, css });

export const SELECTORS = {
  composer: [
    s('prompt-textarea', '#prompt-textarea'),
    s('prosemirror', 'div[contenteditable="true"].ProseMirror'),
    s('contenteditable', 'div[contenteditable="true"]'),
  ],
  sendButton: [
    s('send-testid', 'button[data-testid="send-button"]'),
    s('send-aria-prompt', 'button[aria-label="Send prompt"]'),
    s('send-aria-any', 'button[aria-label*="Send" i]'),
  ],
  stopButton: [
    s('stop-testid', 'button[data-testid="stop-button"]'),
    s('stop-aria-streaming', 'button[aria-label="Stop streaming"]'),
    s('stop-aria-any', 'button[aria-label*="Stop" i]'),
  ],
  // Old UI used data-message-author-role; the 2026-09-26 redesign dropped it in favour of data-markdown-text-style.
  assistantMessage: [
    s('assistant-role', '[data-message-author-role="assistant"]'),
    s('assistant-markdown-style', '[data-markdown-text-style="assistant-message"]'),
    s('assistant-turn-markdown', 'article[data-testid^="conversation-turn"] .markdown'),
  ],
  newChat: [
    s('new-chat-testid', 'a[data-testid="create-new-chat-button"]'),
    s('new-chat-aria', '[aria-label="New chat"]'),
    s('new-chat-href', 'a[href="/"]'),
  ],
  fileInput: [s('file-input', 'input[type="file"]')],
  /** Present only when logged out. */
  loginButton: [
    s('login-testid', '[data-testid="login-button"]'),
    s('signup-testid', '[data-testid="signup-button"]'),
    s('login-link', 'a[href*="/auth/login"]'),
    s('stay-logged-out', 'a:has-text("Stay logged out")'),
  ],
  /** Weak positive evidence of a logged-in session (informational only). */
  loggedInIndicator: [
    s('profile-button', '[data-testid="accounts-profile-button"]'),
    s('profile-button-alt', '[data-testid="profile-button"]'),
  ],
  challenge: [
    s('cloudflare-iframe', 'iframe[src*="challenges.cloudflare.com"]'),
    s('recaptcha-iframe', 'iframe[src*="recaptcha"]'),
    s('hcaptcha-iframe', 'iframe[src*="hcaptcha"]'),
    s('challenge-form', '#challenge-form'),
  ],
  /** Modal/alert containers, where rate-limit notices appear. Scoped on purpose: the page body also contains our own prompt text. */
  noticeDialog: [s('dialog', '[role="dialog"]'), s('alertdialog', '[role="alertdialog"]'), s('alert', '[role="alert"]')],
  /** Buttons that dismiss non-blocking nudges and the rate-limit notice ("Got it"). */
  dismissButton: [
    s('dialog-got-it', '[role="dialog"] button:has-text("Got it")'),
    s('dialog-close', '[role="dialog"] button[aria-label="Close"]'),
    s('dialog-not-now', '[role="dialog"] button:has-text("Not now")'),
  ],
} as const satisfies Record<string, readonly NamedSelector[]>;

export type SelectorGroup = keyof typeof SELECTORS;

export interface ResolvedSelector {
  group: SelectorGroup;
  name: string;
  css: string;
}

export class SelectorNotFoundError extends EngineError {
  constructor(group: string, tried: readonly string[]) {
    super(
      `ChatGPT UI: no selector in group "${group}" matched (tried ${tried.join(', ')}). The UI may have changed; update src/chatgpt/selectors.ts.`,
      'needs_human',
      'SELECTOR_NOT_FOUND',
      { detail: { group, tried: [...tried] } },
    );
  }
}

function isTimeoutLike(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === 'TimeoutError' || /timeout \d+ms exceeded|timed out/i.test(e.message);
}

export interface WaitForFirstOptions {
  state?: SelectorState;
  /** Budget for the primary selector. */
  timeoutMs?: number;
  /** Budget for each fallback after the primary failed. */
  fallbackTimeoutMs?: number;
}

/**
 * waitForSelector on each selector in order; returns the first that resolves.
 * Timeouts move on to the next fallback; any other error (closed target, ...)
 * propagates so recovery can classify it. Throws SelectorNotFoundError
 * (needs_human) once every fallback is exhausted.
 */
export async function waitForFirst(
  page: PageLike,
  group: SelectorGroup,
  options: WaitForFirstOptions = {},
): Promise<ResolvedSelector> {
  const { state = 'visible', timeoutMs = 15_000, fallbackTimeoutMs = 1_500 } = options;
  const list: readonly NamedSelector[] = SELECTORS[group];
  const tried: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const sel = list[i]!;
    tried.push(sel.name);
    try {
      await page.waitForSelector(sel.css, { state, timeout: Math.max(1, i === 0 ? timeoutMs : fallbackTimeoutMs) });
      return { group, name: sel.name, css: sel.css };
    } catch (e) {
      if (!isTimeoutLike(e)) throw e;
    }
  }
  throw new SelectorNotFoundError(group, tried);
}

/** Quick probe: is any selector in the group present right now? Never throws on absence. */
export async function isPresent(
  page: PageLike,
  group: SelectorGroup,
  options: { state?: SelectorState; timeoutMs?: number } = {},
): Promise<ResolvedSelector | undefined> {
  const { state = 'visible', timeoutMs = 150 } = options;
  for (const sel of SELECTORS[group] as readonly NamedSelector[]) {
    try {
      await page.waitForSelector(sel.css, { state, timeout: Math.max(1, timeoutMs) });
      return { group, name: sel.name, css: sel.css };
    } catch (e) {
      if (!isTimeoutLike(e)) throw e;
    }
  }
  return undefined;
}
