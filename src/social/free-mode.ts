import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Facebook and LinkedIn text posts are written with the free-format prompt (config/experiments/linkedin-free-prompt.txt):
 * no template, and code enforces only the character limit, the report link, a bold Ken Research mention, bold statistics
 * and no em dashes. Every social entry point (hce:draft, hce:next, hermes:run, the overnight/continuous runner) calls this
 * once at start-up. Set HCE_FREE_PROMPT=off to go back to the ten approved formats; X and Tumblr are never affected.
 */
export const FREE_PROMPT_FILE = 'config/experiments/linkedin-free-prompt.txt';

export function enableFreeTextMode(): string | null {
  if ((process.env.HCE_FREE_PROMPT ?? '').trim().toLowerCase() === 'off') {
    delete process.env.HCE_FREE_PROMPT_FILE;
    return null;
  }
  if (!process.env.HCE_FREE_PROMPT_FILE?.trim()) {
    const file = path.resolve(FREE_PROMPT_FILE);
    if (existsSync(file)) process.env.HCE_FREE_PROMPT_FILE = file;
  }
  return process.env.HCE_FREE_PROMPT_FILE?.trim() || null;
}

/** True when Facebook/LinkedIn posts use the free prompt in this process. */
export function isFreeTextPlatform(platform: string): boolean {
  return Boolean(process.env.HCE_FREE_PROMPT_FILE?.trim()) && (platform === 'linkedin' || platform === 'facebook');
}

/**
 * Report title -> market name for the free prompt: "South Africa Electric Bus & Fleet Adoption Market Share, Companies &
 * Trends Report 2025-2032" becomes "South Africa Electric Bus & Fleet Adoption Market". Keeps the word "Market".
 */
export function marketNameFromTitle(title: string): string | null {
  const m = title.replace(/\s+\bMarket\s+(?:Share|Size|Report|Outlook|Analysis|Forecast|Trends|Companies)\b.*$/i, ' Market').replace(/\s+/g, ' ').trim();
  return m && m !== title.trim() ? m : null;
}
