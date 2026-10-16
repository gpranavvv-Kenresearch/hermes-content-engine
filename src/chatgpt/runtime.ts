/** Small injectable runtime helpers so tests never wait on real timers. */

export type SleepFn = (ms: number) => Promise<void>;
export type HumanDelayFn = (minMs: number, maxMs: number) => Promise<void>;

export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ported from the legacy stagehand.ts humanDelay(): random pause in [min, max] ms. */
export const realHumanDelay: HumanDelayFn = async (minMs, maxMs) => {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await realSleep(ms);
};

export interface LoggerLike {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export const noopLogger: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Strips query/hash so URLs are safe to log and store. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? '';
  }
}
