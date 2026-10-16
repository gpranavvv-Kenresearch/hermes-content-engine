/**
 * Minimal structural interfaces for the parts of Playwright the ChatGPT driver
 * uses. Real Playwright Page / BrowserContext objects satisfy them (checked at
 * type level in tests/unit/chatgpt-page-like.test.ts), and tests supply fakes,
 * so no test ever needs a browser.
 *
 * Deliberately absent: fill(), evaluate(), waitForLoadState('networkidle').
 * fill() truncates Lexical composers and caused 'target closed' in the legacy
 * system; networkidle never settles on chatgpt.com.
 */

export type SelectorState = 'attached' | 'visible';

export interface WaitForSelectorOptions {
  state?: SelectorState;
  timeout?: number;
}

export interface LocatorLike {
  first(): LocatorLike;
  last(): LocatorLike;
  count(): Promise<number>;
  innerText(options?: { timeout?: number }): Promise<string>;
  isVisible(options?: { timeout?: number }): Promise<boolean>;
  click(options?: { timeout?: number }): Promise<void>;
  setInputFiles(files: string | string[], options?: { timeout?: number }): Promise<void>;
}

export interface KeyboardLike {
  type(text: string, options?: { delay?: number }): Promise<void>;
  press(key: string, options?: { delay?: number }): Promise<void>;
  insertText(text: string): Promise<void>;
}

export interface PageLike {
  readonly keyboard: KeyboardLike;
  goto(url: string, options?: { waitUntil?: 'domcontentloaded' | 'load' | 'commit'; timeout?: number }): Promise<unknown>;
  reload(options?: { waitUntil?: 'domcontentloaded' | 'load' | 'commit'; timeout?: number }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  isClosed(): boolean;
  waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<unknown>;
  locator(selector: string): LocatorLike;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  screenshot(options?: { fullPage?: boolean; timeout?: number }): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface ContextLike {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

/** What the provider needs from a browser session (real or fake). */
export interface BrowserSessionLike {
  /** The live ChatGPT page; opens a new one if none is open. */
  getPage(): Promise<PageLike>;
  /** Closes the context and launches a fresh one on the SAME profile (lock is kept). */
  relaunch(): Promise<void>;
  /** Closes the browser and releases the profile lock. Safe to call twice. */
  close(): Promise<void>;
}
