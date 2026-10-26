import 'dotenv/config';
import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { loadEnvFiles } from '../../src/llm/env.js';
import { JsonFileStore } from '../../src/store/store.js';
import { Account, Finding, LearningAdvice, Post, PromptGuidance, Snapshot, Policy, Source, Experiment, Strategy, thresholds, stableId, hash, type Metrics, type Platform } from './contracts.js';
import { discover, loadAccounts } from './discovery.js';
import { googleSheets, AnalyticsSheet, SOURCE_TAB, TAB, postRecord, snapshotRecord, findingRecord, postDiagnosticRecords, adviceRecords, postReviewRecords, simpleRunSummaryRecord, sourceRecord, experimentRecord, type SheetRecord } from './sheets.js';
import { PerformanceStore, atomicWrite } from './store.js';
import { NativeAdapters } from './platforms.js';
import { PublicUrlAdapters, UniversalAdapters } from './public-platforms.js';
import { trackPosts, importObservation, persistCollection, dueWindows } from './tracker.js';
import { evaluate, evaluateTestRun } from './learner.js';
import { createReport } from './reporter.js';
import { seedSources, proposeExperiments, researchIdeas, optionalReview } from './research.js';
import { enqueue, flush, Outbox } from './outbox.js';
import { buildPolicy, savePolicy } from './policy.js';
import { readImport } from './imports.js';
import { attachHandoffs } from './metadata.js';
import { parsePostUrl } from './urls.js';
import { changeExperiment } from './experiments.js';
import { createLearningAdvice, PostReviewSchema, type PostReview, type ReviewProgress } from './advisor.js';
import { buildPromptGuidance, guidanceRoot, loadPromptGuidance, replacePromptGuidance } from './guidance.js';

const args = parseArgs({ options: { 'write-sheet': { type: 'boolean' }, late: { type: 'boolean' }, 'force-retry': { type: 'boolean' }, 'test-run': { type: 'boolean' }, json: { type: 'boolean' }, platform: { type: 'string' }, account: { type: 'string' }, accounts: { type: 'string' }, 'state-dir': { type: 'string' }, limit: { type: 'string' }, 'sync-limit': { type: 'string' }, file: { type: 'string' }, url: { type: 'string' }, query: { type: 'string' }, explain: { type: 'string' }, version: { type: 'string' }, id: { type: 'string' }, action: { type: 'string' }, help: { type: 'boolean' } }, allowPositionals: true });
const command = args.positionals[0] ?? 'status';
const v = args.values;
const testLoop = command === 'test-loop';
const autoLoop = command === 'auto-loop';
const testRun = v['test-run'] === true || testLoop || autoLoop;
const pipelineRun = command === 'run' || testLoop || autoLoop;
const simpleSheetMode = testLoop || autoLoop || (command === 'sync' && testRun);
const jsonOutput = v.json === true;
function integer(input: string | undefined, fallback: number, name: string): number { const n = input === undefined ? fallback : Number(input); if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error(`${name} must be 1-10000`); return n; }
const required = (value: string | undefined, name: string): string => { if (!value?.trim()) throw new Error(`Missing --${name}`); return value.trim(); };
const visibleMetrics = (metrics: Metrics): Partial<Metrics> => Object.fromEntries(Object.entries(metrics).filter(([, value]) => value !== null)) as Partial<Metrics>;
const visibleDefinitions = (metrics: Partial<Metrics>, definitions: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(definitions).filter(([key]) => key in metrics || key === 'visibility' || key === 'nativeFallback'));
const label = (value: string): string => value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('-', ' ').replace(/\b\w/g, c => c.toUpperCase());
const divider = (char = '='): string => char.repeat(72);
function heading(title: string, subtitle?: string): void {
  if (jsonOutput) return;
  console.log(`\n${divider()}\n  ${title}${subtitle ? `\n  ${subtitle}` : ''}\n${divider()}`);
}
function section(title: string, rows: Array<[string, string | number | boolean]> = []): void {
  if (jsonOutput) return;
  console.log(`\n${title}\n${divider('-')}`);
  const width = Math.max(0, ...rows.map(([key]) => key.length));
  for (const [key, value] of rows) console.log(`  ${key.padEnd(width)} : ${value}`);
}
function emit(payload: unknown, title: string, rows: Array<[string, string | number | boolean]>): void {
  if (jsonOutput) console.log(JSON.stringify(payload, null, 2)); else section(title, rows);
}
function metricRows(metrics: Partial<Metrics>): Array<[string, number]> { return Object.entries(metrics).map(([key, value]) => [label(key), value!] as [string, number]); }
const allowedCommands = ['doctor', 'discover', 'track', 'inspect', 'import', 'enrich', 'learn', 'research', 'advise', 'apply-guidance', 'experiment', 'report', 'sync', 'apply-policy', 'rollback-policy', 'run', 'test-loop', 'auto-loop', 'status'];
async function main(): Promise<void> {
  if (v.help) { console.log(`Performance Engine\nCommands: ${allowedCommands.join(', ')}\nDefault collection visits public post URLs without login or API keys; --write-sheet enables Algo Reports writes.\n--platform x|facebook|linkedin|tumblr --accounts FILE --limit 25 --sync-limit 25\ntest-loop performs immediate collection, diagnostic learning, Hermes SEO/B2B advice, reporting and Sheet sync without applying suggestions.\nauto-loop performs the same flow, atomically replaces that platform's active prompt guidance, and the next Supervisor Hermes generation reads it automatically.\nrun --test-run bypasses checkpoint waiting and produces immediate diagnostic analysis without applying policy.\nAdd --json only when machine-readable raw output is required.\ninspect --url URL [--account ACCOUNT] | import/enrich --file FILE\nSet PE_NATIVE_FALLBACK=1 only to allow configured official analytics APIs after public collection fails.\nresearch [--query QUERY] | advise --platform PLATFORM | report [--explain hermes|ollama]\napply-policy --platform PLATFORM --account ACCOUNT | rollback-policy --version VERSION\nSee performance-engine/README.md for setup and import schema.`); return; }
  if (!allowedCommands.includes(command)) throw new Error('Unknown performance command; use --help');
  if (args.positionals.length > 1) throw new Error('Unexpected positional argument');
  if (v['test-run'] && !['run', 'learn', 'advise', 'report', 'sync'].includes(command)) throw new Error('--test-run is supported by run, learn, advise, report and sync');
  const limit = integer(v.limit, 25, 'limit'); const syncLimit = integer(v['sync-limit'], 25, 'sync-limit');
  const platform = v.platform ? z.enum(['x', 'facebook', 'linkedin', 'tumblr']).parse(v.platform) : undefined;
  if (['advise', 'apply-guidance', 'test-loop', 'auto-loop'].includes(command) && !platform) throw new Error(`${command} requires --platform`);
  loadEnvFiles();
  const accounts = await loadAccounts(v.accounts ?? process.env.PE_ACCOUNTS_FILE ?? 'performance-engine/config/accounts.json');
  const config = thresholds.parse(JSON.parse(await readFile('performance-engine/config/thresholds.json', 'utf8')));
  const store = new PerformanceStore(path.resolve(v['state-dir'] ?? process.env.PE_STATE_DIR ?? 'output/performance-engine/state'));
  const adapter = new UniversalAdapters(new PublicUrlAdapters(), new NativeAdapters(), process.env.PE_NATIVE_FALLBACK === '1');
  const selected = (posts: Post[]) => posts.filter(p => (!platform || p.platform === platform) && (!v.account || p.accountId === v.account));
  const getPosts = async () => selected(await store.list('posts', Post));
  const payload = async () => { const posts = await getPosts(); const ids = new Set(posts.map(p => p.id)); return { posts, snapshots: (await store.list('snapshots', Snapshot)).filter(s => ids.has(s.postId)), findings: (await store.list('findings', Finding)).filter(f => (!platform || f.platform === platform) && (!v.account || f.accountId === v.account)) }; };
  // A full test-loop keeps detailed data locally and sends one readable platform summary to the shared Sheet.
  const queue = (r: SheetRecord) => simpleSheetMode ? Promise.resolve() : enqueue(store, r);
  let liveResearchUsed = false;
  let appliedGuidance: PromptGuidance | undefined;
  if (command === 'status') {
    const data = await payload(); const outbox = await store.list('outbox', Outbox);
    const status = { state: store.root, posts: data.posts.length, snapshots: data.snapshots.length, findings: data.findings.length, pendingSheetRecords: outbox.filter(o => o.syncedHash !== hash(JSON.stringify(o.record))).length, configuredAccounts: accounts.length };
    heading('HERMES PERFORMANCE ENGINE', 'Current tracking status');
    emit(status, 'STATUS', [['State directory', status.state], ['Registered posts', status.posts], ['Metric snapshots', status.snapshots], ['Analysis findings', status.findings], ['Pending Sheet records', status.pendingSheetRecords], ['Configured accounts', status.configuredAccounts]]); return;
  }
  await store.lock(async () => {
    if (command === 'apply-guidance') {
      const advice = (await store.list('advice', LearningAdvice)).filter(item => item.platform === platform).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
      if (!advice) throw new Error('No saved Hermes advisory is available. Run performance:test-loop or performance:auto-loop first.');
      const guidance = buildPromptGuidance(advice);
      await replacePromptGuidance(guidanceRoot(), guidance);
      emit(guidance, 'PROMPT GUIDANCE REPLACED', [['Platform', label(guidance.platform)], ['Guidance version', guidance.version], ['Rules replaced', Object.values(guidance.rules).reduce((total, group) => total + group.length, 0)], ['Update mode', 'Replace - no append'], ['Next generation', 'Uses this guidance automatically']]);
      return;
    }
    if (testRun) {
      const mode = { mode: autoLoop ? 'auto-loop' : 'test-run', checkpointWait: 'bypassed', analysis: 'public-visible-interactions', policyChanges: false, promptGuidance: autoLoop ? 'replace-after-hermes-review' : 'unchanged' };
      heading('HERMES PERFORMANCE ENGINE', `${label(platform ?? 'all')} immediate ${autoLoop ? 'learning' : 'diagnostic'} run`);
      emit(mode, 'RUN MODE', [['Mode', autoLoop ? 'Automatic learning loop' : 'Test run'], ['Checkpoint wait', 'Bypassed'], ['Analysis', 'Public visible interactions'], ['Generation policy', 'Unchanged'], ['Prompt guidance', autoLoop ? 'Replace after Hermes review' : 'Unchanged']]);
    }
    if (command === 'doctor') {
      const api = googleSheets(); const header = (await api.read(SOURCE_TAB, '1:1'))[0] ?? [];
      const analyticsHeader = await new AnalyticsSheet(api).schema();
      const capability = accounts.map(a => ({ id: a.id, platform: a.platform, kind: a.kind, credentialConfigured: Boolean(a.tokenEnv && process.env[a.tokenEnv]?.trim()), apiVersion: a.apiVersion ?? null, mapping: a.handles.length ? 'URL handles' : a.matchUnknown ? 'explicit platform default' : 'explicit post enrichment required' }));
      const at = new Date().toISOString();
      const record: SheetRecord = { id: `capability:${stableId(at.slice(0, 10))}`, type: 'capability', at, status: 'public_collection_ready', content: `Published source: ${SOURCE_TAB}; output: ${TAB}\nPublic URL collection is enabled for X, Facebook, LinkedIn and Tumblr without login or API keys. Metrics hidden by a platform remain blank, never zero.\n${capability.map(a => `${a.platform}/${a.id}: optional native credential ${a.credentialConfigured ? 'present (not live-verified)' : 'missing'}; ${a.mapping}`).join('\n') || 'No optional analytics accounts configured; public collection still works.'}\nOfficial API fallback runs only when PE_NATIVE_FALLBACK=1.`, fields: { 'PE Source': 'local configuration and Sheet headers' }, payload: { collectionMode: 'public-url-primary', optionalNativeFallback: process.env.PE_NATIVE_FALLBACK === '1', capability, sourceHeaders: header, analyticsHeaders: analyticsHeader } };
      await queue(record); console.log(record.content);
    }
    if (command === 'discover' || pipelineRun) {
      const api = googleSheets();
      const found = discover(await api.read(SOURCE_TAB, 'A:ZZ'), accounts, new Date(), platform);
      const enriched = await attachHandoffs(found.posts, new JsonFileStore(path.resolve('output/store')));
      let added = 0, refreshed = 0;
      for (const p of enriched) {
        if (v.account && p.accountId !== v.account) continue;
        const old = await store.get('posts', p.id, Post);
        if (!old && added >= limit) continue;
        const changedText = old && old.textHash !== p.textHash;
        const next = Post.parse({ ...old, ...p, discoveredAt: old?.discoveredAt ?? p.discoveredAt, accountId: p.accountId ?? old?.accountId ?? null, publishedAt: p.publishedAt ?? old?.publishedAt ?? null, publishedAtSource: p.publishedAt ? p.publishedAtSource : old?.publishedAtSource ?? 'unknown', strategy: changedText ? p.strategy : Object.keys(p.strategy).length ? p.strategy : old?.strategy ?? {}, runId: changedText ? p.runId : p.runId ?? old?.runId, contentType: old?.contentType ?? p.contentType, distribution: old?.distribution ?? p.distribution, nativeUrn: p.nativeUrn ?? old?.nativeUrn });
        if (old && JSON.stringify(old) === JSON.stringify(next)) continue;
        await store.put('posts', next.id, next); await queue(postRecord(next)); if (!old) added++; else refreshed++;
      }
      const discoveryAt = new Date().toISOString();
      const skippedReasons = Object.fromEntries([...new Set(found.skipped.map(s => `${s.platform}: ${s.reason}`))].map(reason => [reason, found.skipped.filter(s => `${s.platform}: ${s.reason}` === reason).length]));
      await atomicWrite(path.join(store.root, 'last-discovery.json'), { at: discoveryAt, publishedFound: found.posts.length, added, refreshed, skipped: found.skipped });
      await queue({ id: `report:discovery:${stableId(discoveryAt.slice(0, 10), platform ?? 'all', v.account ?? 'all', testRun ? 'test-run' : 'scheduled')}`, type: 'report', at: discoveryAt, status: testRun ? 'test_discovery_completed' : 'discovery_completed', content: `Published URL records recognized: ${found.posts.length}; newly registered in this bounded run: ${added}; refreshed: ${refreshed}; skipped URL cells: ${found.skipped.length}.\n${Object.entries(skippedReasons).map(([reason, n]) => `${n}: ${reason}`).join('\n')}\nHomepage URLs and off-platform URLs need correction in the publisher/source. Public Facebook share aliases are followed and validated during collection.`, recommendations: 'Correct invalid published URLs; public pages will supply timestamps when exposed, otherwise add an exact publication timestamp.', fields: { 'PE Source': testRun ? 'Social Media published URL cells; immediate test run' : 'Social Media published URL cells' }, payload: { testRun, recognized: found.posts.length, added, refreshed, skipped: found.skipped.length, skippedReasons } });
      const discovery = { publishedFound: found.posts.length, added, refreshed, skipped: found.skipped.length };
      emit(discovery, pipelineRun ? '1. URL DISCOVERY' : 'URL DISCOVERY', [['Published URLs found', discovery.publishedFound], ['New posts registered', discovery.added], ['Existing posts refreshed', discovery.refreshed], ['Skipped URLs', discovery.skipped]]);
    }
    if (command === 'enrich') {
      const entries = z.array(z.object({ postUrl: z.url(), accountId: z.string(), publishedAt: z.iso.datetime({ offset: true }).optional(), nativeUrn: z.string().optional(), nativePostId: z.string().optional(), contentType: z.enum(['text', 'image', 'video', 'unknown']).optional(), distribution: z.enum(['organic', 'paid', 'unknown']).optional(), strategy: Strategy.optional() })).parse(JSON.parse(await readFile(required(v.file, 'file'), 'utf8')));
      for (const entry of entries) {
        const identity = parsePostUrl(entry.postUrl);
        const post = (await store.list('posts', Post)).find(p => p.url === identity.canonicalUrl);
        if (!post) throw new Error('Discover the published post before enrichment');
        if (!accounts.some(a => a.id === entry.accountId && a.platform === post.platform)) throw new Error('Enrichment account/platform not configured');
        if (post.accountId && post.accountId !== entry.accountId) throw new Error('Enrichment cannot silently move a post between accounts');
        if (entry.publishedAt && post.publishedAt && Date.parse(entry.publishedAt) !== Date.parse(post.publishedAt) && (await store.list('snapshots', Snapshot)).some(s => s.postId === post.id)) throw new Error('Publication timestamp has observations attached; use an audited correction rather than silently changing history.');
        const next = Post.parse({ ...post, ...entry, publishedAt: entry.publishedAt ? new Date(entry.publishedAt).toISOString() : post.publishedAt, publishedAtSource: entry.publishedAt ? 'user-verified-enrichment' : post.publishedAtSource, strategy: entry.strategy ?? post.strategy });
        if (next.publishedAt && Date.parse(next.publishedAt) > Date.now()) throw new Error('Publication timestamp cannot be in the future');
        await store.put('posts', next.id, next); await queue(postRecord(next));
      }
      console.log(`Enriched ${entries.length} published posts.`);
    }
    if (command === 'import') {
      const rows = await readImport(required(v.file, 'file'));
      for (const row of rows) {
        const snapshot = await importObservation(store, row, accounts, new Date(), config.graceHours);
        let post = (await store.get('posts', snapshot.postId, Post))!;
        if (row.strategy) { post = Post.parse({ ...post, strategy: row.strategy }); await store.put('posts', post.id, post); }
        await queue(postRecord(post)); await queue(snapshotRecord(snapshot, post));
      }
      console.log(`Imported ${rows.length} dated analytics observations.`);
    }
    if (command === 'track' || pipelineRun) {
      const posts = await getPosts();
      posts.sort((a, b) => Number(dueWindows(b, new Date(), config.graceHours).some(w => !w.missed)) - Number(dueWindows(a, new Date(), config.graceHours).some(w => !w.missed)) || (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
      const result = await trackPosts(store, posts, accounts, adapter, { limit, graceHours: config.graceHours, includeLate: v.late, forceRetry: v['force-retry'], collectAllNow: testRun });
      const after = await getPosts();
      for (const s of result.snapshots) await queue(snapshotRecord(s, after.find(p => p.id === s.postId)!));
      for (const p of after.filter(p => result.metadataBlocked.some(b => b.postId === p.id))) await queue(postRecord(p));
      const tracking = { snapshots: result.snapshots.length, metadataBlocked: result.metadataBlocked.length, collectionCalls: result.calls, collectionMode: 'public-url-primary' };
      emit(tracking, pipelineRun ? '2. PUBLIC METRIC COLLECTION' : 'PUBLIC METRIC COLLECTION', [['Snapshots created', tracking.snapshots], ['Collection calls', tracking.collectionCalls], ['Metadata blocked', tracking.metadataBlocked], ['Collection mode', 'Public post URLs']]);
    }
    if (command === 'inspect') {
      const identity = parsePostUrl(required(v.url, 'url'), platform);
      const account = v.account ? accounts.find(a => a.id === v.account && a.platform === identity.platform) : undefined;
      if (v.account && !account) throw new Error('The optional --account does not match a configured account for this platform');
      const existing = (await store.list('posts', Post)).find(p => p.url === identity.canonicalUrl);
      const post = Post.parse({ ...existing, id: existing?.id ?? stableId(identity.platform, identity.postId, identity.accountHint ?? ''), platform: identity.platform, accountId: account?.id ?? existing?.accountId ?? null, postId: identity.postId, url: identity.canonicalUrl, reportUrl: existing?.reportUrl ?? '', text: existing?.text ?? '', textHash: existing?.textHash ?? hash(''), publishedAt: existing?.publishedAt ?? identity.publishedAt, publishedAtSource: existing?.publishedAtSource ?? (identity.publishedAt ? 'x-snowflake' : 'unknown'), discoveredAt: existing?.discoveredAt ?? new Date().toISOString(), sourceRow: existing?.sourceRow ?? 2, strategy: existing?.strategy ?? {}, nativeUrn: existing?.nativeUrn ?? /urn:li:(ugcPost|share):\d+/.exec(decodeURIComponent(v.url!))?.[0] });
      if (account && existing?.accountId && existing.accountId !== account.id) throw new Error('Inspection account conflicts with existing post');
      const result = await adapter.collect(post, account);
      if (!post.publishedAt && result.publishedAt) { post.publishedAt = new Date(result.publishedAt).toISOString(); post.publishedAtSource = result.source; }
      if (!post.text && result.text) { post.text = result.text; post.textHash = hash(result.text); }
      await store.put('posts', post.id, post);
      if (!post.publishedAt) {
        await queue(postRecord(post));
        const metrics = visibleMetrics(result.metrics); const inspected = { postUrl: post.url, status: 'metadata_only', metrics, source: result.source, storedSnapshot: false, reason: 'Public metrics were inspected, but no publication timestamp was exposed for age-based storage.' };
        heading('POST INSPECTION', post.url); emit(inspected, 'RESULT', [['Status', 'Metadata only'], ['Source', result.source], ['Snapshot stored', false]]); if (!jsonOutput) section('AVAILABLE METRICS', metricRows(metrics).length ? metricRows(metrics) : [['Result', 'No public metrics exposed']]);
      } else {
        // On-demand lookup is always labeled late/ad-hoc, never substituted for a scheduled checkpoint.
        const snapshot = await persistCollection(store, post, 'late', new Date().toISOString(), new Date(), result);
        await queue(postRecord(post)); await queue(snapshotRecord(snapshot, post));
        const metrics = visibleMetrics(snapshot.metrics);
        const inspected = { postUrl: post.url, status: snapshot.status, metrics, source: snapshot.source, window: 'late/ad-hoc', reason: snapshot.reason, metricDefinitions: visibleDefinitions(metrics, snapshot.definitions) };
        heading('POST INSPECTION', post.url); emit(inspected, 'RESULT', [['Status', label(snapshot.status)], ['Source', snapshot.source], ['Observation', 'Immediate / ad-hoc'], ['Note', snapshot.reason ?? 'Complete public result']]); if (!jsonOutput) section('AVAILABLE METRICS', metricRows(metrics).length ? metricRows(metrics) : [['Result', 'No public metrics exposed']]);
      }
    }
    if (command === 'learn' || pipelineRun) {
      const data = await payload(); const result = testRun ? evaluateTestRun(data.posts, data.snapshots, data.findings, new Date()) : evaluate(data.posts, data.snapshots, data.findings, new Date(), config);
      for (const f of result) { await store.put('findings', f.id, f); await queue(findingRecord(f)); }
      const diagnostics = testRun ? postDiagnosticRecords(data.posts, data.snapshots, result, new Date()) : [];
      for (const diagnostic of diagnostics) await queue(diagnostic);
      if (!result.length) {
        const at = new Date().toISOString();
        await queue({ id: `learning:coverage:${stableId(at.slice(0, 10), platform ?? 'all', v.account ?? 'all', testRun ? 'test-run' : 'scheduled')}`, type: 'learning', at, status: 'insufficient_data', content: testRun ? `Immediate test collection completed, but no comparable public metric patterns were available. Registered posts: ${data.posts.length}; observations: ${data.snapshots.length}. No content approach was changed.` : `No eligible comparable 14-day cohorts yet. Registered posts: ${data.posts.length}; observations: ${data.snapshots.length}. Need publication time, strategy metadata, content type, organic/paid status and compatible visible impression/interaction counts. Private reach or impressions hidden by a platform remain unknown. No content approach was retired or changed.`, recommendations: testRun ? 'Inspect public metric coverage and post text before repeating the diagnostic test.' : 'Collect mature comparable observations before drawing content conclusions.', fields: { 'PE Action': 'no_change' }, payload: { testRun, posts: data.posts.length, observations: data.snapshots.length, decision: 'no_change' } });
      }
      const learning = { findings: result.length, weak: result.filter(f => ['watch', 'reduce', 'paused'].includes(f.status)).length, postDiagnostics: diagnostics.length };
      emit(learning, pipelineRun ? '3. CONTENT PATTERN ANALYSIS' : 'CONTENT PATTERN ANALYSIS', [['Patterns analysed', learning.findings], ['Weak-pattern signals', learning.weak], ['Post diagnostic rows', learning.postDiagnostics], ['Generation policy', 'Unchanged'], ['Prompt guidance', autoLoop ? 'Will be replaced after Hermes review' : testRun ? 'Unchanged (diagnostic only)' : 'Unchanged']]);
    }
    if (command === 'research' || pipelineRun) {
      let sources = v.query ? await researchIdeas(v.query, platform ?? 'all') : await seedSources(v.file);
      if ((testLoop || autoLoop) && !v.query && process.env.TAVILY_API_KEY?.trim()) {
        const weak = (await payload()).findings.filter(finding => ['watch', 'reduce', 'paused'].includes(finding.status));
        const query = `${platform} B2B social content SEO and platform search practices for market-research posts; controlled improvements for ${weak.map(finding => `${finding.axis} ${finding.pattern}`).join(', ') || 'hooks, decision value and discussion prompts'}`;
        try {
          const live = await researchIdeas(query, platform!);
          const merged = new Map([...sources, ...live].map(source => [`${source.url}|${source.technique}`, source]));
          sources = [...merged.values()]; liveResearchUsed = live.length > 0;
        } catch {
          const at = new Date().toISOString();
          await queue({ id: `report:research-fallback:${stableId(at.slice(0, 10), platform!)}`, type: 'report', at, status: 'curated_research_fallback', content: 'Live research was unavailable, so the advisory continued with reviewed curated sources. No suggestion was applied.', recommendations: 'Check the configured search/Hermes provider before the next test loop if live research is required.', fields: { 'PE Platform': platform!, 'PE Action': 'no_change', 'PE Source': 'curated research fallback' }, payload: { platform, fallback: true } });
        }
      }
      for (const s of sources) { const id = stableId(s.url, s.revision ?? ''); await store.put('sources', id, s); await queue(sourceRecord(s)); }
      const experiments = proposeExperiments(sources, (await payload()).findings);
      for (const e of experiments) {
        const old = await store.get('experiments', e.id, Experiment);
        if (!old) { await store.put('experiments', e.id, e); await queue(experimentRecord(e)); }
      }
      const research = { researchSources: sources.length, proposedExperiments: experiments.length };
      emit(research, pipelineRun ? '4. RESEARCH AND EXPERIMENTS' : 'RESEARCH AND EXPERIMENTS', [['Research sources', research.researchSources], ['Proposed experiments', research.proposedExperiments], ['Suggestions applied', autoLoop ? 'After Hermes review' : 'No']]);
    }
    if (command === 'advise' || testLoop || autoLoop) {
      const data = await payload();
      const sources = (await store.list('sources', Source)).filter(source => source.platform === 'all' || source.platform === platform);
      // One Hermes call per post. Reviews are saved as they finish, so a stopped run continues where it left off.
      const reviewCache = { get: (key: string) => store.get('post-reviews', key, PostReviewSchema), put: (key: string, review: PostReview) => store.put('post-reviews', key, review) };
      const reviewLabel: Record<ReviewProgress['source'], string> = { hermes: 'Hermes reviewed', cached: 'reused saved review of', fallback: 'FALLBACK (Hermes failed) for' };
      const advice = await createLearningAdvice({ posts: data.posts, snapshots: data.snapshots, findings: data.findings, sources, platform: platform!, liveResearch: Boolean(v.query) || liveResearchUsed, cache: reviewCache, onProgress: (p) => { if (!jsonOutput) console.log(`   [${p.index}/${p.total}] ${reviewLabel[p.source]} ${p.url}${p.error ? ` (${p.error.slice(0, 90)})` : ''}`); } });
      await store.put('advice', advice.id, advice);
      const records = adviceRecords(advice); for (const record of records) await queue(record);
      emit({ adviceId: advice.id, modelStatus: advice.modelStatus, postReviews: advice.postInsights.length, promptRecommendations: advice.promptRecommendations.length, applied: false }, testLoop || autoLoop ? '5. HERMES SEO + B2B ADVISORY' : 'HERMES SEO + B2B ADVISORY', [['Hermes analysis', advice.modelStatus === 'hermes' ? 'Completed' : 'Fallback used'], ['Post reviews', advice.postInsights.length], ['Prompt-change proposals', advice.promptRecommendations.length], ['Research mode', label(advice.researchMode)], ['Apply mode', autoLoop ? 'Automatic replacement' : 'Suggestions only']]);
      if (autoLoop) {
        appliedGuidance = buildPromptGuidance(advice);
        await replacePromptGuidance(guidanceRoot(), appliedGuidance);
        emit({ version: appliedGuidance.version, platform: appliedGuidance.platform, mode: appliedGuidance.mode, rules: Object.values(appliedGuidance.rules).reduce((total, group) => total + group.length, 0) }, '6. PROMPT GUIDANCE REPLACEMENT', [['Platform', label(appliedGuidance.platform)], ['Guidance version', appliedGuidance.version], ['Rules replaced', Object.values(appliedGuidance.rules).reduce((total, group) => total + group.length, 0)], ['Update mode', 'Replace - no append'], ['Next generation', 'Uses this guidance automatically']]);
      }
    }
    if (command === 'experiment') {
      const account = required(v.account, 'account'); const p = required(platform, 'platform') as Platform;
      if (!accounts.some(a => a.id === account && a.platform === p)) throw new Error('Experiment account/platform not configured');
      const e = await changeExperiment(store, required(v.id, 'id'), z.enum(['start', 'pause', 'complete']).parse(required(v.action, 'action')), account, p);
      await queue(experimentRecord(e)); console.log(`Experiment ${e.id}: ${e.status}. Completion does not automatically prove or promote the hypothesis.`);
    }
    if (command === 'apply-policy') {
      const p = required(platform, 'platform') as Platform; const account = required(v.account, 'account');
      if (!accounts.some(a => a.id === account && a.platform === p)) throw new Error('Policy account/platform not configured');
      const findings = await store.list('findings', Finding); const policy = buildPolicy(findings, p, account, new Date(), config.policyDays);
      await savePolicy(store.root, policy);
      for (const f of findings.filter(f => policy.findingIds.includes(f.id))) { f.applied = true; f.policyVersion = policy.version; await store.put('findings', f.id, f); await queue(findingRecord(f)); }
      console.log(`Applied policy ${policy.version}. Generation requires explicit PE_ACCOUNT_<PLATFORM> mapping to use it.`);
    }
    if (command === 'rollback-policy') {
      const version = required(v.version, 'version'); if (!/^[a-f0-9]{24}$/.test(version)) throw new Error('Invalid policy version');
      const prior = Policy.parse(JSON.parse(await readFile(path.join(store.root, 'policy-versions', `${version}.json`), 'utf8')));
      if (Date.parse(prior.expiresAt) <= Date.now()) throw new Error('Expired policy cannot be rolled back into active use');
      await savePolicy(store.root, prior);
      const r: SheetRecord = { id: `report:rollback:${stableId(version, new Date().toISOString())}`, type: 'report', at: new Date().toISOString(), status: 'policy_rollback_applied', content: `Restored policy ${version} for ${prior.platform}/${prior.accountId}.`, fields: { 'PE Platform': prior.platform, 'PE Account ID': prior.accountId, 'PE Policy Version': version }, payload: prior }; await queue(r);
      console.log(`Restored policy ${version}.`);
    }
    if (command === 'report' || pipelineRun) {
      const data = await payload(); const experiments = (await store.list('experiments', Experiment)).filter(e => (!platform || e.platform === 'all' || e.platform === platform) && (!v.account || e.accountId === v.account)); const report = createReport(data.posts, data.snapshots, data.findings, new Date(), `${testRun ? 'test-run:' : ''}${platform ?? 'all'}:${v.account ?? 'all'}`, experiments, { testRun });
      if (v.explain) { const model = z.enum(['hermes', 'ollama']).parse(v.explain); const notes = await optionalReview(report.content, model); report.content += `\n\nMODEL REVIEW (${model}; advisory, not measured facts)\n${notes}`; }
      await queue(report); await mkdir(path.join(store.root, 'reports'), { recursive: true });
      await writeFile(path.join(store.root, 'reports', `${new Date().toISOString().slice(0, 10)}-${stableId(platform ?? 'all', v.account ?? 'all')}.md`), `${report.content}\n\nNEXT ACTIONS\n${report.recommendations}\n`, 'utf8');
      if (jsonOutput) console.log(JSON.stringify(report, null, 2)); else { section(autoLoop ? '7. PERFORMANCE REPORT' : testLoop ? '6. PERFORMANCE REPORT' : command === 'run' ? '5. PERFORMANCE REPORT' : 'PERFORMANCE REPORT'); console.log(report.content); }
    }
    if (v['write-sheet'] || command === 'sync') {
      if (command === 'sync' && !v['write-sheet']) throw new Error('Use sync --write-sheet to commit saved records');
      const allPosts = await store.list('posts', Post);
      if (simpleSheetMode) {
        const data = await payload();
        const advice = (await store.list('advice', LearningAdvice)).filter(item => item.platform === platform).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
        if (!advice) throw new Error('No saved Hermes advisory is available for the simple Sheet summary. Run performance:test-loop first.');
        const active = appliedGuidance ?? await loadPromptGuidance(guidanceRoot(), platform!);
        const matchingGuidance = active?.adviceId === advice.id ? active : undefined;
        // One Algo Reports row per post review, then one collective summary row for the platform.
        for (const record of postReviewRecords(advice)) await enqueue(store, record);
        await enqueue(store, simpleRunSummaryRecord({ platform: platform!, posts: data.posts, snapshots: data.snapshots, findings: data.findings, advice, ...(matchingGuidance ? { guidance: matchingGuidance } : {}) }));
      } else {
        // Rebuild detailed outbox records from durable state, closing the crash gap between observation save and enqueue.
        for (const p of allPosts) await queue(postRecord(p));
        for (const s of await store.list('snapshots', Snapshot)) { const p = allPosts.find(p => p.id === s.postId); if (p) await queue(snapshotRecord(s, p)); }
        for (const f of await store.list('findings', Finding)) await queue(findingRecord(f));
        for (const advice of await store.list('advice', LearningAdvice)) for (const record of adviceRecords(advice)) await queue(record);
        for (const s of await store.list('sources', Source)) await queue(sourceRecord(s));
        for (const e of await store.list('experiments', Experiment)) await queue(experimentRecord(e));
      }
      const result = await flush(store, new AnalyticsSheet(googleSheets(process.env, true)), syncLimit);
      const reviewRows = result.written.filter(w => w.id.startsWith('learning:post-review:')).map(w => w.row).sort((a, b) => a - b);
      const summaryRows = result.written.filter(w => w.id.startsWith('summary:')).map(w => w.row);
      const rowRange = reviewRows.length ? (reviewRows.at(-1)! - reviewRows[0]! + 1 === reviewRows.length ? `rows ${reviewRows[0]}-${reviewRows.at(-1)}` : `rows ${reviewRows[0]} to ${reviewRows.at(-1)} (not contiguous)`) : 'none written this run';
      if (result.written.length) { await mkdir(store.root, { recursive: true }); await writeFile(path.join(store.root, 'sheet-rows.json'), JSON.stringify({ at: new Date().toISOString(), tab: TAB, rows: result.written }, null, 2), 'utf8'); }
      const sync = { sheet: TAB, verified: result.verified, pending: result.pending, errors: result.errors, perPostRows: reviewRows.length, summaryRows };
      emit(sync, autoLoop ? '8. GOOGLE SHEET SYNC' : testLoop ? '7. GOOGLE SHEET SYNC' : command === 'run' ? '6. GOOGLE SHEET SYNC' : 'GOOGLE SHEET SYNC', [['Sheet', TAB], ['Per-post review rows', `${reviewRows.length} (${rowRange})`], ['Platform summary row', summaryRows.length ? summaryRows.join(', ') : 'none written this run'], ['Row list saved to', 'sheet-rows.json in the state folder'], ['Records verified', result.verified], ['Records pending', result.pending], ['Errors', result.errors]]);
      if (!jsonOutput && !result.errors && !result.pending) console.log(`\n${divider()}\n  RUN COMPLETE - all available results are saved in ${TAB}.\n${divider()}\n`);
      if (result.errors || result.pending) process.exitCode = 2;
    } else if (!jsonOutput) console.log('\nSaved locally. Add --write-sheet to sync results to Algo Reports.');
  });
}
main().catch(error => {
  // Never dump raw SDK request/response objects containing credentials.
  const text = error instanceof Error ? error.message : 'Performance engine failed';
  const safe = text.replace(/(?:Bearer\s+|access_token[=:]\s*|api_key[=:]\s*)[^\s&,]+/gi, '[credential redacted]');
  console.error(safe.slice(0, 1000)); process.exitCode = 1;
});
