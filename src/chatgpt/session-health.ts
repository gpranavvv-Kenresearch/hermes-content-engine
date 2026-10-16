import fs from 'node:fs/promises';
import path from 'node:path';
import { EngineError } from '../errors.js';
import type { PageLike } from './page-like.js';
import { parseRetryAfterMs } from './recovery-policy.js';
import { safeUrl } from './runtime.js';
import { SELECTORS, isPresent, waitForFirst } from './selectors.js';

export type HealthState = 'ready' | 'login_required' | 'challenge' | 'rate_limited' | 'unknown_ui';

export interface HealthReport {
  state: HealthState;
  /** Human-readable reasons, e.g. "login button 'login-testid' visible". */
  evidence: string;
  url: string;
  retryAfterMs?: number;
}

export interface DiagnosticArtifact {
  state: HealthState;
  evidence: string;
  /** URL without query/hash. */
  url: string;
  title: string;
  /** First ~500 chars of visible page text (no cookies/storage are ever captured). */
  textSnippet: string;
  screenshot?: Uint8Array;
  capturedAt: string;
}

export type DiagnosticWriter = (artifact: DiagnosticArtifact) => Promise<void>;

/** Default writer: <dir>/<timestamp>-<state>.json (+ .png when a screenshot exists). */
export function createFileDiagnosticWriter(dir: string): DiagnosticWriter {
  return async (artifact) => {
    await fs.mkdir(dir, { recursive: true });
    const base = `${artifact.capturedAt.replace(/[:.]/g, '-')}-${artifact.state}`;
    const { screenshot, ...meta } = artifact;
    await fs.writeFile(path.join(dir, `${base}.json`), JSON.stringify(meta, null, 2), 'utf8');
    if (screenshot) await fs.writeFile(path.join(dir, `${base}.png`), screenshot);
  };
}

const CHALLENGE_TEXT = /verify you are human|checking if the site connection is secure|checking your browser|just a moment|captcha/i;
const AUTH_URL = /\/auth\/|auth0\.openai\.com|auth\.openai\.com|\/log-?in\b/i;
const RATE_LIMIT_TEXT =
  /too many requests|making requests too quickly|you['’]ve reached (our|the|your) (current )?(usage |message |daily )?(limit|cap)|reached the (message|usage) (limit|cap)|usage (limit|cap)|rate limit/i;

export interface RateLimitSignal {
  matched: string;
  retryAfterMs?: number;
}

/** Pure text check shared with the in-flight blocker detection in the provider. */
export function detectRateLimitText(text: string): RateLimitSignal | undefined {
  const m = RATE_LIMIT_TEXT.exec(text);
  if (!m) return undefined;
  const retryAfterMs = parseRetryAfterMs(text.slice(Math.max(0, m.index - 200), m.index + 400));
  return { matched: m[0], ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

export interface CheckHealthOptions {
  writer?: DiagnosticWriter;
  /** How long to wait for the composer before judging the page not ready. Default 8000 (legacy value). */
  composerTimeoutMs?: number;
  now?: () => Date;
}

async function readBodyText(page: PageLike): Promise<string> {
  try {
    await page.waitForSelector('body', { state: 'attached', timeout: 2_000 });
    return (await page.locator('body').innerText({ timeout: 3_000 })).slice(0, 20_000);
  } catch (e) {
    if (page.isClosed()) throw e;
    return '';
  }
}

/**
 * Classifies what the page in front of us is. Precedence:
 * challenge > login_required > rate_limited > ready (composer visible) > unknown_ui.
 * When the state is not 'ready' a diagnostic (screenshot + metadata) is handed
 * to the injectable writer; a failing writer never masks the real result.
 */
export async function checkHealth(page: PageLike, options: CheckHealthOptions = {}): Promise<HealthReport> {
  if (page.isClosed()) throw new Error('Target page, context or browser has been closed');
  const url = page.url();

  const composer = await waitForFirst(page, 'composer', {
    timeoutMs: options.composerTimeoutMs ?? 8_000,
    fallbackTimeoutMs: 500,
  }).then(
    (r) => r,
    (e: unknown) => {
      if (e instanceof EngineError && e.code === 'SELECTOR_NOT_FOUND') return undefined;
      throw e;
    },
  );

  const body = await readBodyText(page);
  const challengeEl = await isPresent(page, 'challenge');
  const loginEl = await isPresent(page, 'loginButton');

  let report: HealthReport;
  if (challengeEl || CHALLENGE_TEXT.test(body) || /\/cdn-cgi\/challenge/i.test(url)) {
    report = {
      state: 'challenge',
      url: safeUrl(url),
      evidence: challengeEl ? `challenge element '${challengeEl.name}' present` : 'challenge text or URL detected',
    };
  } else if (loginEl || AUTH_URL.test(url)) {
    report = {
      state: 'login_required',
      url: safeUrl(url),
      evidence: loginEl ? `login element '${loginEl.name}' visible` : `on auth URL ${safeUrl(url)}`,
    };
  } else {
    const rate = detectRateLimitText(body);
    if (rate) {
      report = {
        state: 'rate_limited',
        url: safeUrl(url),
        evidence: `rate-limit text "${rate.matched}"`,
        ...(rate.retryAfterMs === undefined ? {} : { retryAfterMs: rate.retryAfterMs }),
      };
    } else if (composer) {
      const signedIn = await isPresent(page, 'loggedInIndicator');
      report = {
        state: 'ready',
        url: safeUrl(url),
        evidence: `composer '${composer.name}' visible${signedIn ? `, signed-in indicator '${signedIn.name}'` : ''}`,
      };
    } else {
      report = { state: 'unknown_ui', url: safeUrl(url), evidence: 'composer not found and no known blocker detected' };
    }
  }

  if (report.state !== 'ready' && options.writer) {
    await saveDiagnostic(page, report, body, options.writer, options.now);
  }
  return report;
}

async function saveDiagnostic(
  page: PageLike,
  report: HealthReport,
  body: string,
  writer: DiagnosticWriter,
  now: (() => Date) | undefined,
): Promise<void> {
  try {
    const screenshot = await page.screenshot({ fullPage: false, timeout: 5_000 }).catch(() => undefined);
    const title = await page.title().catch(() => '');
    await writer({
      state: report.state,
      evidence: report.evidence,
      url: report.url,
      title,
      textSnippet: body.slice(0, 500),
      ...(screenshot ? { screenshot } : {}),
      capturedAt: (now ? now() : new Date()).toISOString(),
    });
  } catch {
    // diagnostics are best-effort
  }
}

/** Converts a non-ready report into the matching EngineError (undefined when ready). */
export function healthToError(report: HealthReport): EngineError | undefined {
  switch (report.state) {
    case 'ready':
      return undefined;
    case 'login_required':
      return new EngineError(`ChatGPT login required (${report.evidence}). Run scripts/login-chatgpt.ts.`, 'auth_required', 'LOGIN_REQUIRED', {
        detail: { evidence: report.evidence },
      });
    case 'challenge':
      return new EngineError(`ChatGPT shows a challenge/captcha (${report.evidence}). A human must solve it.`, 'needs_human', 'CHALLENGE', {
        detail: { evidence: report.evidence },
      });
    case 'rate_limited':
      return new EngineError(`ChatGPT rate limit (${report.evidence})`, 'rate_limited', 'RATE_LIMITED', {
        ...(report.retryAfterMs === undefined ? {} : { retryAfterMs: report.retryAfterMs }),
        detail: { evidence: report.evidence },
      });
    case 'unknown_ui':
      return new EngineError(`ChatGPT UI not recognised (${report.evidence}). Selectors may have drifted.`, 'needs_human', 'UI_UNKNOWN', {
        detail: { evidence: report.evidence },
      });
  }
}
