import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JWT } from 'google-auth-library';
import { columnLetter } from '../../src/sheets/social-sheet.js';
import { stableId, type Finding, type LearningAdvice, type Platform, type Post, type PromptGuidance, type Snapshot, type Source, type Experiment } from './contracts.js';
import { diagnosticPatterns, publicVisibleScore } from './learner.js';

export const TAB = 'Algo Reports';
export const SOURCE_TAB = 'Social Media';
export const ENGINE = 'Performance Engine';
export const legacyHeaders = ['Report Date', 'Report Content', 'High Impact', 'Recommendations', 'Indexing Rate', 'Daily posting count'];
/** User-facing run summary. These columns deliberately begin at H; G identifies the engine. */
export const summaryHeaders = ['Platform', 'Rows Read', 'Content Analysis', 'Reach / Likes / Comments', 'Prompt Change Suggestion', 'Why Suggested'];
export const extraHeaders = ['PE Engine', ...summaryHeaders, 'PE Record Type', 'PE Record ID', 'PE Status', 'PE Platform', 'PE Account ID', 'PE Post ID', 'PE Post URL', 'PE Published At', 'PE Window', 'PE Observed At', 'PE Age Hours', 'PE Impressions', 'PE Reach', 'PE Views', 'PE Likes', 'PE Reactions', 'PE Comments', 'PE Shares', 'PE Quotes', 'PE Clicks', 'PE Saves', 'PE Notes', 'PE Pattern', 'PE Sample Size', 'PE Baseline Size', 'PE Interaction Rate', 'PE Baseline Rate', 'PE Action', 'PE Evidence', 'PE Policy Version', 'PE Experiment ID', 'PE Source', 'PE Missing Reason', 'PE Schema Version', 'PE Payload'];
export type CellValue = string | number;
export interface SheetGateway {
  read(tab: string, range: string): Promise<string[][]>;
  update(tab: string, cells: Array<{ range: string; values: CellValue[][] }>): Promise<void>;
  append(tab: string, values: CellValue[]): Promise<void>;
  ensureColumns(tab: string, count: number): Promise<void>;
  /** Insert blank columns without destroying existing Sheet data. startIndex is zero-based. */
  insertColumns(tab: string, startIndex: number, count: number): Promise<void>;
}
export function googleSheets(env: NodeJS.ProcessEnv = process.env, write = false): SheetGateway {
  const creds = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim() || readFileSync(env.CE_GOOGLE_SA_FILE?.trim() || path.resolve('..', '.accounts', 'google-service-account.json'), 'utf8'));
  const auth = new JWT({ email: creds.client_email, key: creds.private_key, scopes: [write ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const id = env.CE_SHEET_ID?.trim();
  if (!id) throw new Error('Google Sheet ID is missing. Set CE_SHEET_ID in the private environment.');
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${id}`;
  const full = (tab: string, range: string) => `'${tab.replaceAll("'", "''")}'!${range}`;
  const writable = () => { if (!write) throw new Error('Analytics Sheet connection is read-only; use --write-sheet'); };
  let lastRequest = 0;
  const request = async <T = any>(options: any): Promise<{ data: T }> => {
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(0, 1100 - (Date.now() - lastRequest));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      lastRequest = Date.now();
      try { return await auth.request<T>({ ...options, retry: false }); }
      catch (error) {
        const status = (error as any)?.response?.status;
        if (attempt >= 3 || (status !== 429 && !(typeof status === 'number' && status >= 500))) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(30000, 1000 * 2 ** attempt)));
      }
    }
  };
  return {
    async read(tab, range) { const r = await request<any>({ url: `${base}/values/${encodeURIComponent(full(tab, range))}`, params: { valueRenderOption: 'UNFORMATTED_VALUE' }, timeout: 30000 }); return (r.data.values ?? []).map((row: unknown[]) => row.map(v => String(v ?? ''))); },
    async update(tab, cells) { writable(); await request({ url: `${base}/values:batchUpdate`, method: 'POST', data: { valueInputOption: 'RAW', data: cells.map(c => ({ range: full(tab, c.range), values: c.values })) }, timeout: 30000 }); },
    // Reconcile uncertain append in AnalyticsSheet; never blindly repeat the append POST.
    async append(tab, values) { writable(); const wait = Math.max(0, 1100 - (Date.now() - lastRequest)); if (wait) await new Promise(resolve => setTimeout(resolve, wait)); lastRequest = Date.now(); await auth.request({ url: `${base}/values/${encodeURIComponent(full(tab, `A:${columnLetter(values.length - 1)}`))}:append`, method: 'POST', params: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' }, data: { values: [values] }, timeout: 30000, retry: false }); },
    async ensureColumns(tab, count) {
      writable();
      const response = await request<any>({ url: base, params: { fields: 'sheets(properties(sheetId,title,gridProperties(columnCount)))' }, timeout: 30000 });
      const found = response.data.sheets?.find((s: any) => s.properties.title === tab)?.properties;
      if (!found) throw new Error(`Existing tab ${tab} was not found; no tab was created.`);
      if (found.gridProperties.columnCount < count) await request({ url: `${base}:batchUpdate`, method: 'POST', data: { requests: [{ appendDimension: { sheetId: found.sheetId, dimension: 'COLUMNS', length: count - found.gridProperties.columnCount } }] }, timeout: 30000 });
    },
    async insertColumns(tab, startIndex, count) {
      writable();
      const response = await request<any>({ url: base, params: { fields: 'sheets(properties(sheetId,title))' }, timeout: 30000 });
      const found = response.data.sheets?.find((s: any) => s.properties.title === tab)?.properties;
      if (!found) throw new Error(`Existing tab ${tab} was not found; no tab was created.`);
      await request({ url: `${base}:batchUpdate`, method: 'POST', data: { requests: [{ insertDimension: { range: { sheetId: found.sheetId, dimension: 'COLUMNS', startIndex, endIndex: startIndex + count }, inheritFromBefore: true } }] }, timeout: 30000 });
    },
  };
}
export interface SheetRecord { id: string; type: 'post' | 'snapshot' | 'learning' | 'advice' | 'research' | 'experiment' | 'report' | 'capability'; at: string; status: string; content: string; recommendations?: string; fields: Record<string, string | number | null>; payload: unknown; }
export function istDate(iso: string): string { const d = new Date(Date.parse(iso) + 19800000); return d.toISOString().slice(0, 10); }

export class AnalyticsSheet {
  constructor(private readonly api: SheetGateway) {}
  async schema(write = false): Promise<string[]> {
    let headers = (await this.api.read(TAB, '1:1'))[0] ?? [];
    if (new Set(headers.filter(Boolean)).size !== headers.filter(Boolean).length) throw new Error('Duplicate Algo Reports headers; refusing ambiguous writes.');
    for (const h of legacyHeaders) if (!headers.includes(h)) throw new Error(`Missing existing Algo Reports header: ${h}`);
    if (write && headers.includes('PE Engine') && !summaryHeaders.every((header, offset) => headers[7 + offset] === header)) {
      if (summaryHeaders.some(header => headers.includes(header))) throw new Error('Readable summary columns exist in an unexpected position; refusing ambiguous migration.');
      if (headers.indexOf('PE Engine') !== 6) throw new Error('PE Engine is not in column G; refusing unsafe summary-column migration.');
      // Existing deployments used H onward for technical fields. Shift those fields right and reserve H:M for the readable summary.
      await this.api.insertColumns(TAB, 7, summaryHeaders.length);
      await this.api.update(TAB, [{ range: `H1:M1`, values: [summaryHeaders] }]);
      headers = (await this.api.read(TAB, '1:1'))[0] ?? [];
    }
    const missing = extraHeaders.filter(h => !headers.includes(h));
    if (!missing.length || !write) return headers;
    // Probe the full allocated grid for occupied columns beyond the last header.
    const occupied = await this.api.read(TAB, 'A:ZZ');
    const end = Math.max(headers.length, ...occupied.map(r => r.length));
    if (!headers.includes('PE Engine') && end > legacyHeaders.length) {
      // Preserve unlabeled/foreign data by shifting it right; our fixed summary contract begins at G/H.
      await this.api.insertColumns(TAB, legacyHeaders.length, extraHeaders.length);
      await this.api.update(TAB, [{ range: `G1:${columnLetter(legacyHeaders.length + extraHeaders.length - 1)}1`, values: [extraHeaders] }]);
    } else {
      const next = [...headers]; while (next.length < end) next.push(''); next.push(...missing);
      await this.api.ensureColumns(TAB, next.length);
      await this.api.update(TAB, [{ range: `${columnLetter(end)}1:${columnLetter(next.length - 1)}1`, values: [missing] }]);
    }
    const verified = (await this.api.read(TAB, '1:1'))[0] ?? [];
    if (extraHeaders.some(h => !verified.includes(h))) throw new Error('Analytics header readback failed');
    if (!summaryHeaders.every((header, offset) => verified[7 + offset] === header)) throw new Error('Readable summary columns are not in H:M');
    return verified;
  }
  async upsert(record: SheetRecord): Promise<{ row: number; verified: boolean }> {
    const headers = await this.schema(true);
    const index = (name: string) => headers.indexOf(name);
    const idCol = columnLetter(index('PE Record ID'));
    const find = async (): Promise<number[]> => (await this.api.read(TAB, `${idCol}2:${idCol}`)).flatMap((r, i) => r[0] === record.id ? [i + 2] : []);
    const matches = await find();
    if (matches.length > 1) throw new Error('Duplicate analytics record ID; inspect before updating.');
    const fields: Record<string, CellValue> = {
      'Report Date': istDate(record.at), 'Report Content': `${ENGINE} | ${record.type} | ${record.status}\nRecord ID: ${record.id}\n\n${record.content}`,
      Recommendations: record.recommendations ?? '', 'PE Engine': ENGINE, 'PE Record Type': record.type,
      'PE Record ID': record.id, 'PE Status': record.status, 'PE Schema Version': '1', 'PE Payload': JSON.stringify(record.payload),
      ...Object.fromEntries(Object.entries(record.fields).map(([k, v]) => [k, v === null ? '' : v])),
    };
    if (Object.keys(fields).some(k => index(k) < 0)) throw new Error('Unknown analytics field');
    if (Object.values(fields).some(v => typeof v === 'string' && v.length > 45000)) throw new Error('Analytics cell exceeds safe size; split this record before writing.');
    let row = matches[0];
    if (row) {
      const old = (await this.api.read(TAB, `${row}:${row}`))[0] ?? [];
      if (old[index('PE Engine')] !== ENGINE || old[index('PE Record ID')] !== record.id) throw new Error('Analytics row moved or belongs to another engine.');
      // Sparse cells preserve legacy indexing/daily-count fields, including concurrent updates to F.
      await this.api.update(TAB, Object.entries(fields).map(([k, v]) => ({ range: `${columnLetter(index(k))}${row}`, values: [[v]] })));
    } else {
      const values = headers.map(h => fields[h] ?? '');
      try { await this.api.append(TAB, values); }
      catch (error) { if (!(await find()).length) throw error; }
      const after = await find(); if (after.length !== 1) throw new Error('Could not reconcile analytics append by ID'); row = after[0]!;
    }
    const back = (await this.api.read(TAB, `${row}:${row}`))[0] ?? [];
    if (Object.entries(fields).some(([k, v]) => {
      const actual = back[index(k)] ?? '';
      if (typeof v !== 'number') return actual !== v;
      const n = Number(actual);
      return actual === '' || !Number.isFinite(n) || (Number.isInteger(v) ? n !== v : Math.abs(n - v) > Math.max(1, Math.abs(v)) * 1e-12);
    })) throw new Error('Analytics write readback mismatch');
    return { row, verified: true };
  }
}
export function postRecord(p: Post): SheetRecord { return { id: `post:${p.id}`, type: 'post', at: p.discoveredAt, status: p.publishedAt ? 'registered' : 'metadata_needed', content: `${p.platform}: ${p.url}\nPublished: ${p.publishedAt ?? 'unknown'} (${p.publishedAtSource})\nOptional native account: ${p.accountId ?? 'not configured; public URL mode'}\nContent:\n${p.text}`, recommendations: !p.publishedAt ? 'Supply an exact publication timestamp if the public page does not expose one.' : '', fields: { 'PE Platform': p.platform, 'PE Account ID': p.accountId, 'PE Post ID': p.id, 'PE Post URL': p.url, 'PE Published At': p.publishedAt }, payload: p }; }
export function snapshotRecord(s: Snapshot, p: Post): SheetRecord {
  const fields: SheetRecord['fields'] = { 'PE Platform': s.platform, 'PE Account ID': s.accountId, 'PE Post ID': s.postId, 'PE Post URL': p.url, 'PE Published At': p.publishedAt, 'PE Window': String(s.window), 'PE Observed At': s.observedAt, 'PE Age Hours': s.ageHours, 'PE Source': s.source, 'PE Missing Reason': s.reason, 'PE Evidence': s.rawRef };
  for (const [k, v] of Object.entries(s.metrics)) fields[`PE ${k[0]!.toUpperCase()}${k.slice(1)}`] = v;
  return { id: `snapshot:${s.id}`, type: 'snapshot', at: s.observedAt, status: s.status, content: `${p.url}\nTarget: ${s.window}; actual age: ${s.ageHours.toFixed(1)} hours\n${Object.entries(s.metrics).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n') || 'No metrics collected.'}\nScope: ${s.scope}\n${s.reason ?? ''}`, recommendations: ['blocked', 'retry', 'missed'].includes(s.status) ? s.reason ?? '' : '', fields, payload: s };
}
export function findingRecord(f: Finding): SheetRecord { return { id: `learning:${f.id}`, type: 'learning', at: f.at, status: f.status, content: `${f.platform} / ${f.accountId}: ${f.axis}=${f.pattern}\n${f.reason}\nMetric: ${f.metric}; pattern ${f.patternCount}, baseline ${f.baselineCount}\nProposed weight: ${f.proposedWeight}; applied: ${f.applied}`, recommendations: f.applied ? 'Policy change applied; monitor the next mature cohort.' : 'Advisory finding; apply a validated policy separately after reviewing evidence.', fields: { 'PE Platform': f.platform, 'PE Account ID': f.accountId, 'PE Pattern': `${f.axis}:${f.pattern}`, 'PE Sample Size': f.patternCount, 'PE Baseline Size': f.baselineCount, 'PE Interaction Rate': f.patternRate, 'PE Baseline Rate': f.baselineRate, 'PE Action': f.applied ? 'applied' : 'proposed', 'PE Evidence': f.snapshotIds.join(','), 'PE Policy Version': f.policyVersion ?? null }, payload: f }; }
export function postDiagnosticRecords(posts: Post[], snapshots: Snapshot[], findings: Finding[], at: Date): SheetRecord[] {
  const latest = new Map<string, Snapshot>();
  for (const snapshot of snapshots) {
    if (!['ok', 'partial'].includes(snapshot.status)) continue;
    const old = latest.get(snapshot.postId);
    if (!old || old.observedAt < snapshot.observedAt) latest.set(snapshot.postId, snapshot);
  }
  return posts.flatMap(post => {
    const snapshot = latest.get(post.id); if (!snapshot) return [];
    const score = publicVisibleScore(snapshot); if (!score) return [];
    const patterns = diagnosticPatterns(post);
    const weak = findings.filter(finding => ['watch', 'reduce', 'paused'].includes(finding.status) && patterns[finding.axis] === finding.pattern);
    const suggestions = weak.map(finding => {
      const stronger = findings.filter(candidate => candidate.axis === finding.axis && candidate.pattern !== finding.pattern && candidate.ratio !== null && candidate.ratio > 1).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0];
      return stronger
        ? `${finding.axis}: test ${stronger.pattern} instead of ${finding.pattern} (diagnostic ratio ${stronger.ratio!.toFixed(3)} versus ${finding.ratio?.toFixed(3) ?? 'unknown'}).`
        : `${finding.axis}: keep ${finding.pattern} under observation and test one alternative while holding the remaining post structure constant.`;
    });
    const metrics = Object.entries(snapshot.metrics).filter(([, value]) => value !== null).map(([name, value]) => `${name}=${value}`).join(', ');
    const patternLines = Object.entries(patterns).map(([axis, pattern]) => `  - ${axis}: ${pattern}`).join('\n');
    const weakLines = weak.length ? weak.map(finding => `  - ${finding.axis}=${finding.pattern}: ${finding.status}; ratio ${finding.ratio?.toFixed(3) ?? 'unknown'}; evidence ${finding.id}`).join('\n') : '  - No test-run weak signal mapped to this post.';
    const recommendationLines = suggestions.length ? suggestions.map(text => `  - ${text}`).join('\n') : '  - Keep this post as a comparison control; test only one structural variable in the next version.';
    const preview = post.text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '(text unavailable)';
    const status = weak.length ? 'watch' : 'observe';
    const content = `POST DIAGNOSTIC\nPost URL: ${post.url}\nOpening: ${preview.slice(0, 300)}\nVisible metrics: ${metrics}\nVisible interaction score: ${score.score}\n\nDETECTED POST TYPE\n${patternLines}\n\nWEAK SIGNALS\n${weakLines}\n\nWHAT TO TEST NEXT\n${recommendationLines}`;
    return [{
      id: `learning:post-diagnostic:${stableId(post.id, snapshot.id)}`, type: 'learning' as const, at: at.toISOString(), status, content,
      recommendations: suggestions.join('\n') || 'Retain as a control and test one structural change at a time.',
      fields: { 'PE Platform': post.platform, 'PE Account ID': post.accountId ?? `public-${post.platform}`, 'PE Post ID': post.id, 'PE Post URL': post.url, 'PE Published At': post.publishedAt, 'PE Observed At': snapshot.observedAt, 'PE Age Hours': snapshot.ageHours, 'PE Pattern': Object.entries(patterns).map(([axis, pattern]) => `${axis}:${pattern}`).join(' | '), 'PE Sample Size': 1, 'PE Action': weak.length ? 'watch' : 'retain_control', 'PE Evidence': [snapshot.id, ...weak.map(finding => finding.id)].join(','), 'PE Source': 'immediate public test-run post diagnostic' },
      payload: { postId: post.id, postUrl: post.url, snapshotId: snapshot.id, patterns, metrics: snapshot.metrics, visibleInteractionScore: score.score, comparableMetricSignature: score.signature, weakFindingIds: weak.map(finding => finding.id), suggestions },
    }];
  });
}
export function adviceRecords(advice: LearningAdvice): SheetRecord[] {
  const common = { 'PE Platform': advice.platform, 'PE Action': 'suggestion_only', 'PE Source': advice.sourceIds.join(','), 'PE Evidence': advice.findingIds.join(',') };
  const summary: SheetRecord = {
    id: `advice:${advice.id}:summary`, type: 'advice', at: advice.at, status: 'suggestions_only',
    content: `DEEP LEARNING ADVISORY - ${advice.platform.toUpperCase()}\nMode: suggestions only; no prompt, policy or experiment was changed.\nHermes analysis: ${advice.modelStatus}; research: ${advice.researchMode}.\n\nEXECUTIVE SUMMARY\n${advice.executiveSummary}\n\nPLATFORM LEARNING\n${advice.platformLearning.map(item => `- ${item.signal}\n  Interpretation: ${item.interpretation}\n  Next test: ${item.nextTest}\n  Evidence posts: ${item.evidencePostIds.join(', ') || 'none'}`).join('\n') || '- No supported platform learning was produced.'}${advice.modelError ? `\n\nMODEL FALLBACK\n${advice.modelError}` : ''}`,
    recommendations: 'Review the post-level and prompt-modification advisory rows. No recommendation has been implemented.', fields: common,
    payload: { adviceId: advice.id, modelStatus: advice.modelStatus, researchMode: advice.researchMode, executiveSummary: advice.executiveSummary, platformLearning: advice.platformLearning, modelError: advice.modelError },
  };
  const posts: SheetRecord[] = advice.postInsights.map(insight => ({
    id: `advice:${advice.id}:post:${insight.postId}`, type: 'advice', at: advice.at, status: insight.weakSignals.length ? 'review_recommended' : 'control_candidate',
    content: `POST SEO + B2B ADVISORY\nPost URL: ${insight.postUrl}\nOpening: ${insight.opening}\nVisible metrics: ${Object.entries(insight.visibleMetrics).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}\nDetected type: ${Object.entries(insight.patterns).map(([key, value]) => `${key}=${value}`).join(' | ')}\n\nWEAK SIGNALS\n${insight.weakSignals.map(signal => `- ${signal}`).join('\n') || '- No aggregate weak signal mapped to this post.'}\n\nSEO ASSESSMENT\n${insight.seoAssessment}\n\nB2B ASSESSMENT\n${insight.b2bAssessment}\n\nCONTENT PROBLEM\n${insight.contentProblem}\n\nRECOMMENDED CONTROLLED TEST\n${insight.recommendedTest}\n\nNo suggestion was implemented.`,
    recommendations: insight.recommendedTest,
    fields: { ...common, 'PE Post ID': insight.postId, 'PE Post URL': insight.postUrl, 'PE Pattern': Object.entries(insight.patterns).map(([key, value]) => `${key}:${value}`).join(' | ') }, payload: insight,
  }));
  const prompts: SheetRecord[] = advice.promptRecommendations.map(item => ({
    id: `advice:${advice.id}:prompt:${item.id}`, type: 'advice', at: advice.at, status: 'prompt_change_proposed',
    content: `PROMPT MODIFICATION PROPOSAL\nTarget: ${item.target}\nPriority: ${item.priority}\n\nPROBLEM\n${item.problem}\n\nPROPOSED INSTRUCTION\n${item.proposedInstruction}\n\nEXPECTED EFFECT\n${item.expectedEffect}\n\nGUARDRAIL\n${item.guardrail}\n\nEVIDENCE POSTS\n${item.evidencePostIds.join(', ') || 'No valid post IDs supplied.'}\n\nSuggestion only. Prompt files were not modified.`,
    recommendations: item.proposedInstruction,
    fields: { ...common, 'PE Pattern': `${item.target}:${item.priority}`, 'PE Action': 'prompt_change_proposed', 'PE Evidence': item.evidencePostIds.join(',') }, payload: item,
  }));
  return [summary, ...posts, ...prompts];
}

/**
 * One readable Sheet row for one platform run. Detailed observations remain in the local state store;
 * this row gives the user the decision view requested in columns H:M.
 */
/**
 * One Algo Reports row PER POST for a per-post Hermes review. The id is stable per platform and post, so a rerun updates
 * the same row instead of appending a duplicate. The readable summary columns H:M are filled for this one post.
 */
export function postReviewRecords(advice: LearningAdvice, at: Date = new Date(advice.at)): SheetRecord[] {
  const platformName = advice.platform === 'linkedin' ? 'LinkedIn' : advice.platform === 'facebook' ? 'Facebook' : advice.platform === 'x' ? 'X' : 'Tumblr';
  const source = advice.modelStatus === 'hermes' ? 'per-post Hermes review' : 'deterministic post review (Hermes summary unavailable)';
  return advice.postInsights.map((insight) => {
    const metrics = Object.entries(insight.visibleMetrics).map(([name, value]) => `${name}: ${value}`).join(' | ') || 'unavailable publicly';
    const patterns = Object.entries(insight.patterns).map(([axis, pattern]) => `${axis}=${pattern}`).join('; ');
    const weak = insight.weakSignals.length > 0;
    const analysis = `POST REVIEW (${platformName})\nPost URL: ${insight.postUrl}\nOpening: ${insight.opening.slice(0, 300)}\nDetected pattern: ${patterns || 'none'}\n\nSEO\n${insight.seoAssessment}\n\nB2B VALUE\n${insight.b2bAssessment}\n\nPROBLEM\n${insight.contentProblem}`;
    return {
      id: `learning:post-review:${stableId(advice.platform, insight.postId)}`,
      type: 'learning' as const,
      at: at.toISOString(),
      status: weak ? 'watch' : 'observe',
      content: analysis,
      recommendations: insight.recommendedTest,
      fields: {
        Platform: platformName,
        'Rows Read': 1,
        'Content Analysis': analysis.slice(0, 12000),
        'Reach / Likes / Comments': metrics,
        'Prompt Change Suggestion': `PROPOSED ONLY.\n${insight.recommendedTest}`.slice(0, 20000),
        'Why Suggested': `${insight.contentProblem}${weak ? `\nWeak signals: ${insight.weakSignals.join('; ')}` : ''}`.slice(0, 20000),
        'PE Platform': advice.platform,
        'PE Post ID': insight.postId,
        'PE Post URL': insight.postUrl,
        'PE Pattern': patterns.slice(0, 1000),
        'PE Action': 'post_review',
        'PE Source': source,
      },
      payload: { adviceId: advice.id, postId: insight.postId, postUrl: insight.postUrl, patterns: insight.patterns, visibleMetrics: insight.visibleMetrics, weakSignals: insight.weakSignals },
    };
  });
}

export function simpleRunSummaryRecord(input: { platform: Platform; posts: Post[]; snapshots: Snapshot[]; findings: Finding[]; advice: LearningAdvice; guidance?: PromptGuidance; at?: Date }): SheetRecord {
  const at = input.at ?? new Date();
  const latest = new Map<string, Snapshot>();
  for (const snapshot of input.snapshots) {
    if (!['ok', 'partial'].includes(snapshot.status)) continue;
    const old = latest.get(snapshot.postId);
    if (!old || old.observedAt < snapshot.observedAt) latest.set(snapshot.postId, snapshot);
  }
  const observed = input.posts.map(post => latest.get(post.id)).filter((snapshot): snapshot is Snapshot => Boolean(snapshot));
  const metric = (name: keyof Snapshot['metrics']): string => {
    const values = observed.map(snapshot => snapshot.metrics[name]).filter((value): value is number => value !== null);
    return values.length ? `${values.reduce((sum, value) => sum + value, 0)} (${values.length}/${input.posts.length} posts)` : 'unavailable publicly';
  };
  const weak = input.findings.filter(finding => ['watch', 'reduce', 'paused'].includes(finding.status));
  const stronger = input.findings.filter(finding => finding.ratio !== null && finding.ratio > 1).sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
  const weakText = weak.length ? weak.map(finding => `${finding.axis}=${finding.pattern} (${finding.ratio?.toFixed(3) ?? 'unknown'})`).join('; ') : 'no supported weak pattern';
  const strongText = stronger.length ? stronger.map(finding => `${finding.axis}=${finding.pattern} (${finding.ratio!.toFixed(3)})`).join('; ') : 'no stronger comparison yet';
  const analysis = `${input.posts.length} ${input.platform} posts analysed. Weaker signals: ${weakText}. Stronger observed associations: ${strongText}. Public interactions only; association does not prove causation.`;
  const compact = (text: string, max = 320): string => {
    const cleaned = text.replace(/^For review only:\s*/i, '').replace(/\s+/g, ' ').trim();
    return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1).trimEnd()}…`;
  };
  const suggestion = input.advice.promptRecommendations.length
    ? input.advice.promptRecommendations.map((item, index) => `${index + 1}. ${item.target}: ${compact(item.proposedInstruction)}`).join('\n')
    : 'No prompt change proposed. Keep the current post as a control and collect more comparable observations.';
  const why = input.advice.promptRecommendations.length
    ? input.advice.promptRecommendations.map((item, index) => `${index + 1}. ${compact(item.problem, 240)} Evidence: ${item.evidencePostIds.length} post(s).`).join('\n')
    : 'The current public sample did not support a specific prompt change.';
  const metrics = `Reach: ${metric('reach')} | Likes: ${metric('likes')} | Comments: ${metric('comments')} | Reactions: ${metric('reactions')}`;
  const platformName = input.platform === 'linkedin' ? 'LinkedIn' : input.platform === 'facebook' ? 'Facebook' : input.platform === 'x' ? 'X' : 'Tumblr';
  return {
    id: `summary:${input.advice.id}`,
    type: 'report',
    at: at.toISOString(),
    status: input.guidance ? 'prompt_guidance_replaced' : 'suggestions_only',
    content: `${platformName} performance summary\nRows read: ${input.posts.length}\n${analysis}\nVisible metrics: ${metrics}\nPrompt guidance: ${input.guidance ? `replaced with version ${input.guidance.version}` : 'suggestions only; unchanged'}`,
    recommendations: suggestion,
    fields: {
      Platform: platformName,
      'Rows Read': input.posts.length,
      'Content Analysis': analysis.slice(0, 12000),
      'Reach / Likes / Comments': metrics,
      'Prompt Change Suggestion': `${input.guidance ? `APPLIED by replacing active ${platformName} guidance (${input.guidance.version}); rules were not appended.\n` : 'PROPOSED ONLY; active guidance was not changed.\n'}${suggestion}`.slice(0, 20000),
      'Why Suggested': why.slice(0, 20000),
      'PE Platform': input.platform,
      'PE Action': input.guidance ? 'prompt_guidance_replaced' : 'suggestion_only',
      'PE Evidence': input.advice.findingIds.join(','),
      'PE Source': 'immediate public test-loop summary',
    },
    payload: {
      adviceId: input.advice.id,
      platform: input.platform,
      rowsRead: input.posts.length,
      snapshotsUsed: observed.length,
      weakFindingIds: weak.map(finding => finding.id),
      strongerFindingIds: stronger.map(finding => finding.id),
      promptRecommendationIds: input.advice.promptRecommendations.map(item => item.id),
      suggestionsApplied: Boolean(input.guidance),
      guidanceVersion: input.guidance?.version ?? null,
    },
  };
}
export function sourceRecord(s: Source): SheetRecord { return { id: `research:${stableId(s.url, s.revision ?? '')}`, type: 'research', at: s.accessedAt, status: 'hypothesis', content: `${s.title}\n${s.url}\nAuthor: ${s.author}; revision: ${s.revision ?? 'not pinned'}; license: ${s.license ?? 'not verified'}\nTechnique: ${s.technique}`, fields: { 'PE Platform': s.platform, 'PE Source': s.url }, payload: s }; }
export function experimentRecord(e: Experiment): SheetRecord { return { id: `experiment:${e.id}`, type: 'experiment', at: e.at, status: e.status, content: `${e.hypothesis}\nControl: ${e.control}\nSuccess criterion: ${e.outcome}\nAllocation: ${e.allocation * 100}%\nThis is a proposal unless status is testing/complete.`, fields: { 'PE Platform': e.platform, 'PE Experiment ID': e.id, 'PE Source': e.sourceId }, payload: e }; }
