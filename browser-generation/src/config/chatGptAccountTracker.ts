/**
 * chatGptAccountTracker.ts — Multi-account rotation for the ChatGPT browser session.
 *
 * Mirrors the OpenRouter key-rotation / X account-tracker pattern: if the
 * ChatGPT browser session keeps failing (rate limit, "too many prompts",
 * flaky response, etc.), rotate to the next saved account after N
 * consecutive failures instead of hammering the same one forever.
 *
 * Accounts are just named persistent-profile folders under
 * .sessions/chatgpt-accounts/<name> — log into each one by hand once via
 *   npm run login:chatgpt -- <name>
 * The original single-account session at .sessions/chatgpt (pre-dating
 * multi-account support) keeps working unmigrated as the account "default".
 */

import fs from 'fs';
import path from 'path';

const ROTATION_STATE_FILE = path.resolve('.sessions/chatgpt-rotation.json');
const ACCOUNTS_ROOT = path.resolve('.sessions/chatgpt-accounts');
const DEFAULT_ACCOUNT = 'default';

// Rotate after this many consecutive failures on the current account.
// e.g. with 3 accounts: 10 fails on account1 -> account2, 10 fails on
// account2 -> account3, 10 fails on account3 -> back to account1, and if
// that wraps all the way around (every account just failed 10 in a row),
// the caller is told to cool down before retrying from account1 again.
export const ROTATE_AFTER_FAILURES = 10;

interface RotationState {
  currentAccount: string;
  consecutiveFailures: number;
}

function loadState(): RotationState {
  const accounts = listChatGptAccounts();
  try {
    const raw = fs.readFileSync(ROTATION_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Self-heal: if the saved account is no longer in the pool (e.g. named
    // accounts were added and "default" got excluded), restart from the
    // first known account rather than getting stuck on a dropped one.
    if (parsed?.currentAccount && accounts.includes(parsed.currentAccount)) return parsed;
  } catch { /* no state yet */ }
  return { currentAccount: accounts[0], consecutiveFailures: 0 };
}

function saveState(state: RotationState): void {
  fs.mkdirSync(path.dirname(ROTATION_STATE_FILE), { recursive: true });
  fs.writeFileSync(ROTATION_STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * All accounts in the rotation pool. If any named accounts exist under
 * chatgpt-accounts/, those are the pool — "default" (the original
 * pre-multi-account session) is excluded so it doesn't silently count as an
 * extra account beyond the ones deliberately set up. "default" is only used
 * as a fallback when no named accounts have been created yet.
 */
export function listChatGptAccounts(): string[] {
  const named: string[] = [];
  try {
    const entries = fs.readdirSync(ACCOUNTS_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) named.push(e.name);
    }
  } catch { /* accounts root doesn't exist yet */ }
  return named.length > 0 ? named : [DEFAULT_ACCOUNT];
}

/** Resolve an account name to its persistent-profile session directory. */
export function sessionDirForAccount(accountName: string): string {
  if (accountName === DEFAULT_ACCOUNT) return path.resolve('.sessions/chatgpt');
  return path.join(ACCOUNTS_ROOT, accountName);
}

export function getCurrentChatGptAccount(): string {
  return loadState().currentAccount;
}

/**
 * Record a failed ChatGPT attempt on the current account. After
 * ROTATE_AFTER_FAILURES consecutive failures, switches to the next known
 * account (round-robin). If that rotation wraps back around to the first
 * account — meaning every known account just failed ROTATE_AFTER_FAILURES
 * times in a row — `cycleExhausted` comes back true, telling the caller to
 * cool down before retrying (from account1 again) rather than spinning
 * forever with no chance of success.
 */
export function recordChatGptFailure(): { rotated: boolean; account: string; cycleExhausted: boolean } {
  const state = loadState();
  state.consecutiveFailures += 1;

  if (state.consecutiveFailures >= ROTATE_AFTER_FAILURES) {
    const accounts = listChatGptAccounts();
    const idx = accounts.indexOf(state.currentAccount);
    const nextIdx = idx === -1 ? 0 : (idx + 1) % accounts.length;
    const next = accounts[nextIdx];
    const rotated = next !== state.currentAccount;
    const cycleExhausted = nextIdx === 0;
    state.currentAccount = next;
    state.consecutiveFailures = 0;
    saveState(state);
    if (rotated) {
      console.warn(`   🔁 ChatGPT: ${ROTATE_AFTER_FAILURES} consecutive failures — rotating session to account "${next}"`);
    } else {
      console.warn(`   ⚠️  ChatGPT: ${ROTATE_AFTER_FAILURES} consecutive failures, but no other saved account to rotate to (only "${next}" exists)`);
    }
    return { rotated, account: next, cycleExhausted };
  }

  saveState(state);
  return { rotated: false, account: state.currentAccount, cycleExhausted: false };
}

/** Record a successful ChatGPT attempt — resets the failure counter for the current account. */
export function recordChatGptSuccess(): void {
  const state = loadState();
  if (state.consecutiveFailures !== 0) {
    state.consecutiveFailures = 0;
    saveState(state);
  }
}
