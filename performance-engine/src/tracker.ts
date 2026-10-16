import { CollectionError, Post, Snapshot, Metrics, emptyMetrics, hash, stableId, timestamp, type Account, type Adapter, type Collection, type Thresholds } from './contracts.js';
import { PerformanceStore } from './store.js';
import { parsePostUrl } from './urls.js';

export const snapshotId = (postId: string, window: Snapshot['window'], observedAt?: string): string => stableId(postId, String(window), window === 'late' ? observedAt ?? '' : '');
export function redactEvidence(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw.map(redactEvidence);
  if (raw && typeof raw === 'object') return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, /^(?:access_token|api_key|authorization|client_secret|refresh_token|private_key)$/i.test(k) ? '[redacted]' : redactEvidence(v)]));
  if (typeof raw === 'string') return raw.replace(/([?&](?:access_token|api_key|client_secret)=)[^&#\s]+/gi, '$1[redacted]').replace(/Bearer\s+[^\s]+/g, 'Bearer [redacted]');
  return raw;
}
export function dueWindows(post: Post, now: Date, graceHours = 24): Array<{ window: 7 | 14; dueAt: string; missed: boolean }> {
  if (!post.publishedAt) return [];
  const age = now.getTime() - Date.parse(post.publishedAt);
  if (age < 0) return [];
  return ([7, 14] as const).filter(d => age >= d * 86400000).map(window => ({ window, dueAt: new Date(Date.parse(post.publishedAt!) + window * 86400000).toISOString(), missed: age > (window * 24 + graceHours) * 3600000 }));
}
export async function persistCollection(store: PerformanceStore, post: Post, window: Snapshot['window'], dueAt: string, at: Date, result: Collection, attempts = 1): Promise<Snapshot> {
  if (!post.publishedAt || Date.parse(post.publishedAt) > at.getTime()) throw new Error('A verified past publication time is required');
  const sanitized = redactEvidence(result.raw);
  const rawId = hash(JSON.stringify(sanitized));
  await store.put('evidence', rawId, { postId: post.id, observedAt: at.toISOString(), source: result.source, raw: sanitized });
  const available = Object.values(result.metrics).filter(v => v !== null).length;
  const snapshot = Snapshot.parse({ id: snapshotId(post.id, window, at.toISOString()), postId: post.id, platform: post.platform, accountId: post.accountId, window, dueAt, observedAt: at.toISOString(), ageHours: (at.getTime() - Date.parse(post.publishedAt)) / 3600000, status: available === 0 ? 'unavailable' : result.metrics.impressions !== null && (result.metrics.likes !== null || result.metrics.reactions !== null) && result.metrics.comments !== null && result.metrics.shares !== null ? 'ok' : 'partial', source: result.source, metrics: result.metrics, definitions: result.definitions, scope: result.scope, reason: available === 0 ? result.definitions.visibility ?? 'The source exposed no supported metric values.' : Object.values(result.metrics).some(v => v === null) ? 'Only fields exposed by this source were collected.' : null, rawRef: store.file('evidence', rawId), attempts, nextAttemptAt: null });
  await store.put('snapshots', snapshot.id, snapshot);
  return snapshot;
}
export interface TrackResult { snapshots: Snapshot[]; metadataBlocked: Array<{ postId: string; reason: string }>; calls: number; }
export async function trackPosts(store: PerformanceStore, posts: Post[], accounts: Account[], adapter: Adapter, opts: { now?: () => Date; graceHours?: number; limit?: number; includeLate?: boolean; forceRetry?: boolean; collectAllNow?: boolean } = {}): Promise<TrackResult> {
  const now = opts.now ?? (() => new Date()); const snapshots: Snapshot[] = []; const metadataBlocked: TrackResult['metadataBlocked'] = []; let calls = 0; let worked = 0;
  const accountBlocked = new Map<string, string>();
  for (const initial of posts) {
    if (worked >= (opts.limit ?? 25)) break;
    let post = initial; let cached: Collection | undefined;
    const account = accounts.find(a => a.id === post.accountId && a.platform === post.platform);
    if (!post.publishedAt) {
      let metadataError: string | undefined;
      if (!account || !accountBlocked.has(account.id)) {
        try {
          calls++; cached = await adapter.collect(post, account);
          if (cached.publishedAt && Number.isFinite(Date.parse(cached.publishedAt)) && Date.parse(cached.publishedAt) <= now().getTime()) {
            post = Post.parse({ ...post, publishedAt: new Date(cached.publishedAt).toISOString(), publishedAtSource: cached.source, text: post.text || cached.text || '', textHash: post.text ? post.textHash : hash(cached.text ?? '') });
            await store.put('posts', post.id, post);
          }
        } catch (e) {
          metadataError = e instanceof Error ? e.message : 'Public post metadata collection failed.';
          if (e instanceof CollectionError && e.kind === 'blocked' && account) accountBlocked.set(account.id, e.message);
        }
      }
      if (!post.publishedAt) { metadataBlocked.push({ postId: post.id, reason: metadataError ? `Publication time remains unknown: ${metadataError}` : 'Missing verified publication time; public page, publisher metadata or a dated import did not provide it.' }); worked++; continue; }
    }
    const at = now();
    const windows: Array<{ window: Snapshot['window']; dueAt: string; missed: boolean }> = opts.collectAllNow
      ? [{ window: 'late', dueAt: at.toISOString(), missed: false }]
      : dueWindows(post, at, opts.graceHours ?? 24);
    if (!opts.collectAllNow && opts.includeLate && windows.some(w => w.missed)) windows.push({ window: 'late', dueAt: at.toISOString(), missed: false });
    let processed = false;
    for (const w of windows) {
      const id = snapshotId(post.id, w.window, at.toISOString());
      const prior = await store.get('snapshots', id, Snapshot);
      if (prior && ['ok', 'partial', 'unavailable', 'missed'].includes(prior.status)) continue;
      if (prior?.nextAttemptAt && Date.parse(prior.nextAttemptAt) > at.getTime() && !opts.forceRetry) continue;
      const base = { id, postId: post.id, platform: post.platform, accountId: post.accountId, window: w.window, dueAt: w.dueAt, observedAt: at.toISOString(), ageHours: Math.max(0, (at.getTime() - Date.parse(post.publishedAt!)) / 3600000), scope: 'unknown', rawRef: null, metrics: emptyMetrics(), definitions: {}, source: 'scheduler', attempts: (prior?.attempts ?? 0) + 1, nextAttemptAt: null };
      let snapshot: Snapshot;
      if (w.missed) snapshot = Snapshot.parse({ ...base, status: 'missed', reason: 'Exact observation window was missed; no historical counts fabricated.' });
      else {
        try {
          if (account && accountBlocked.has(account.id)) throw new CollectionError('blocked', accountBlocked.get(account.id)!);
          if (!cached) { calls++; cached = await adapter.collect(post, account); }
          const observed = now();
          if (w.window !== 'late' && observed.getTime() > Date.parse(w.dueAt) + (opts.graceHours ?? 24) * 3600000) throw new CollectionError('unavailable', 'Collection finished outside the observation grace window.');
          snapshot = await persistCollection(store, post, w.window, w.dueAt, observed, cached, base.attempts);
        } catch (e) {
          const error = e instanceof CollectionError ? e : new CollectionError('retry', 'Unexpected collection failure; inspect adapter/configuration.');
          if (error.kind === 'blocked' && account) accountBlocked.set(account.id, error.message);
          const retrySeconds = error.kind === 'retry' ? Math.min(86400, Math.max(error.retryAfterSeconds ?? 0, 60 * 2 ** Math.min(base.attempts, 10))) : 21600;
          snapshot = Snapshot.parse({ ...base, status: error.kind, reason: error.message, nextAttemptAt: error.kind === 'unavailable' ? null : new Date(at.getTime() + retrySeconds * 1000).toISOString() });
        }
      }
      await store.put('snapshots', snapshot.id, snapshot); snapshots.push(snapshot); processed = true;
    }
    if (processed) worked++;
  }
  return { snapshots, metadataBlocked, calls };
}

export interface ImportInput { postUrl: string; accountId: string; publishedAt: string; observedAt: string; metrics: unknown; source: string; scope: Snapshot['scope']; contentType?: Post['contentType']; distribution?: Post['distribution']; nativeUrn?: string; nativePostId?: string; }
export async function importObservation(store: PerformanceStore, input: ImportInput, accounts: Account[], at = new Date(), graceHours = 24): Promise<Snapshot> {
  const identity = parsePostUrl(input.postUrl);
  timestamp.parse(input.publishedAt); timestamp.parse(input.observedAt);
  const metrics = Metrics.parse(input.metrics);
  const account = accounts.find(a => a.id === input.accountId && a.platform === identity.platform);
  if (!account) throw new Error('Import account/platform is not configured');
  const published = Date.parse(input.publishedAt); const observed = Date.parse(input.observedAt);
  if (!Number.isFinite(published) || !Number.isFinite(observed) || observed < published || observed > at.getTime() + 60000) throw new Error('Import timestamps are invalid or in the future');
  const existing = (await store.list('posts', Post)).find(p => p.platform === identity.platform && p.postId === identity.postId && p.url === identity.canonicalUrl);
  if (existing?.accountId && existing.accountId !== account.id) throw new Error('Import account conflicts with registered post');
  if (existing?.publishedAt && Math.abs(Date.parse(existing.publishedAt) - published) > 1000) throw new Error('Import publication time conflicts with registered post');
  const post = Post.parse({ ...existing, id: existing?.id ?? stableId(identity.platform, identity.postId, identity.accountHint ?? ''), platform: identity.platform, accountId: account.id, postId: identity.postId, url: identity.canonicalUrl, reportUrl: existing?.reportUrl ?? '', text: existing?.text ?? '', textHash: existing?.textHash ?? hash(''), publishedAt: new Date(published).toISOString(), publishedAtSource: `import:${input.source}`, discoveredAt: existing?.discoveredAt ?? at.toISOString(), sourceRow: existing?.sourceRow ?? 2, strategy: existing?.strategy ?? {}, contentType: input.contentType ?? existing?.contentType ?? 'unknown', distribution: input.distribution ?? existing?.distribution ?? 'unknown', ...(input.nativeUrn ? { nativeUrn: input.nativeUrn } : {}), ...(input.nativePostId ? { nativePostId: input.nativePostId } : {}) });
  const age = (observed - published) / 3600000;
  const window = ([7, 14] as const).find(d => age >= d * 24 && age <= d * 24 + graceHours) ?? 'late';
  const id = snapshotId(post.id, window, new Date(observed).toISOString());
  const prior = await store.get('snapshots', id, Snapshot);
  if (prior && ['ok', 'partial'].includes(prior.status)) {
    if (prior.observedAt === new Date(observed).toISOString() && JSON.stringify(prior.metrics) === JSON.stringify(metrics)) return prior;
    throw new Error('Checkpoint already has observed metrics; use a separately versioned correction rather than overwriting history.');
  }
  await store.put('posts', post.id, post);
  return persistCollection(store, post, window, window === 'late' ? new Date(observed).toISOString() : new Date(published + window * 86400000).toISOString(), new Date(observed), { metrics, definitions: { import: `User-supplied dated first-party export: ${input.source}` }, scope: input.scope, source: 'analytics-import', raw: input });
}
