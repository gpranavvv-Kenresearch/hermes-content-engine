import { sha256Hex } from '../utils/hash.js';

/**
 * Generation retries and publication retries are NOT the same thing.
 * Retrying generation is safe (it only costs quota). Retrying a publish whose
 * outcome is unknown can create a duplicate post, so an unknown outcome must
 * be reconciled (check whether the post exists) before any new create request.
 *
 * The engine itself never publishes; these types and rules exist so that the
 * future adapter layer, and the shadow-mode comparison, share one definition.
 */
export type PublicationState = 'not_attempted' | 'in_flight' | 'published' | 'failed' | 'unknown';

export type RetryDecision = 'retry' | 'reconcile_first' | 'skip';

export function decidePublicationRetry(state: PublicationState): RetryDecision {
  switch (state) {
    case 'not_attempted':
    case 'failed':
      return 'retry';
    case 'in_flight':
    case 'unknown':
      return 'reconcile_first';
    case 'published':
      return 'skip';
  }
}

/** Generation can always be retried; this exists to make the distinction explicit in call sites. */
export function decideGenerationRetry(): RetryDecision {
  return 'retry';
}

/**
 * Deterministic idempotency key for one publication: the same item, platform
 * and content variant always yields the same key, so a re-dispatched job maps
 * to the same publication record instead of a new one.
 */
export function publicationKey(itemId: string, platform: string, variantId: string): string {
  return sha256Hex(`${itemId}\u0000${platform}\u0000${variantId}`).slice(0, 32);
}
