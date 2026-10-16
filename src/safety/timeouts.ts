import { TimeoutError } from '../errors.js';

/** Default bounded timeouts (ms). Every browser/LLM/network call must run under one of these. */
export const timeoutPolicy = {
  navigation: 60_000,
  pageAction: 15_000,
  /** One ChatGPT generation (long: the legacy blog flow takes minutes). */
  chatGptShortReply: 3 * 60_000,
  chatGptLongReply: 18 * 60_000,
  httpRequest: 20_000,
  extraction: 30_000,
} as const;

export type TimeoutKey = keyof typeof timeoutPolicy;

/**
 * Races `work` against a timer. On timeout the AbortSignal passed to `work` is
 * aborted so well-behaved work can cancel itself, and a retryable TimeoutError
 * is thrown. The timer is always cleared, so no handles leak.
 */
export async function withTimeout<T>(
  label: string,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(label, ms));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
