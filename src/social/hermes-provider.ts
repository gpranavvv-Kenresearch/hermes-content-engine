import { spawn } from 'node:child_process';
import type { LlmProvider, LlmRequest, LlmResult } from '../contracts.js';
import type { RepairLesson, RepairTrace } from './learning.js';

export interface HermesResultEvent {
  type: 'result';
  exit_code: number;
  text?: string;
  tokens?: { input?: number; output?: number; total?: number };
  error?: string;
}

/** Hermes documents JSONL with a terminal result event; text deltas are only progress. */
export function parseHermesStream(stdout: string): HermesResultEvent {
  const events = stdout.split(/\r?\n/).filter(Boolean);
  for (let i = events.length - 1; i >= 0; i--) {
    let parsed: unknown;
    try { parsed = JSON.parse(events[i]!); } catch { continue; }
    if (parsed && typeof parsed === 'object' && (parsed as { type?: string }).type === 'result') {
      const event = parsed as Partial<HermesResultEvent>;
      if (typeof event.exit_code !== 'number') throw new Error('Hermes result has no exit_code');
      return event as HermesResultEvent;
    }
  }
  throw new Error('Hermes returned no terminal result event');
}

export interface HermesProviderOptions {
  command?: string;
  provider?: string;
  timeoutMs?: number;
  maxCalls?: number;
  lessons?: readonly RepairLesson[];
  recentTraces?: readonly RepairTrace[];
  signal?: AbortSignal;
}

export class HermesProvider implements LlmProvider {
  readonly id = 'hermes-codex';
  readonly usedLessonIds = new Set<string>();
  calls = 0;
  tokens = 0;
  private readonly opts: Required<Omit<HermesProviderOptions, 'lessons' | 'recentTraces' | 'signal'>> & { lessons: readonly RepairLesson[]; recentTraces: readonly RepairTrace[]; signal?: AbortSignal };

  constructor(options: HermesProviderOptions = {}) {
    this.opts = {
      command: options.command ?? process.env.HCE_HERMES_BIN ?? 'hermes',
      provider: options.provider ?? 'openai-codex',
      timeoutMs: options.timeoutMs ?? 180_000,
      maxCalls: options.maxCalls ?? 5,
      lessons: options.lessons ?? [],
      recentTraces: options.recentTraces ?? [],
      ...(options.signal ? { signal: options.signal } : {}),
    };
  }

  private async call(prompt: string, toolsets: string, signal?: AbortSignal): Promise<string> {
    signal = signal && this.opts.signal ? AbortSignal.any([signal, this.opts.signal]) : signal ?? this.opts.signal;
    signal?.throwIfAborted();
    if (this.calls >= this.opts.maxCalls) throw new Error(`Hermes request budget exhausted (${this.opts.maxCalls})`);
    this.calls++;
    const args = ['chat', '--oneshot', '--query-file', '-', '--format', 'stream-json', '--provider', this.opts.provider, '--toolsets', toolsets, '--max-turns', '4', '--source', 'tool'];
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.opts.command, args, { cwd: process.cwd(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(output);
      };
      const onAbort = (): void => { child.kill(); finish(new Error('Hermes call cancelled')); };
      const timer = setTimeout(() => { child.kill(); finish(new Error(`Hermes timed out after ${this.opts.timeoutMs} ms`)); }, this.opts.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.length > 2_000_000) { child.kill(); finish(new Error('Hermes output exceeded 2 MB')); }
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2_000); });
      child.on('error', (error) => finish(new Error(`Hermes could not start: ${error.message}`)));
      child.on('close', (code) => {
        if (code !== 0) finish(new Error(`Hermes exited ${code}; check Hermes login and model selection. ${stderr.includes('rate limit') ? 'Rate limit reported.' : ''}`));
        else finish();
      });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      child.stdin.on('error', () => { /* close/error path reports the failed process */ });
      child.stdin.end(prompt);
    });
    const result = parseHermesStream(stdout);
    if (result.exit_code !== 0 || !result.text?.trim()) throw new Error(`Hermes turn failed (${result.exit_code}): ${result.error ?? 'no answer'}`);
    this.tokens += result.tokens?.total ?? 0;
    return result.text;
  }

  async generate(request: LlmRequest): Promise<LlmResult> {
    const started = Date.now();
    const matching = this.opts.lessons.filter((lesson) => lesson.status !== 'retired' && (request.purpose === 'rewrite' ? request.prompt.includes(lesson.failureCode) : lesson.status === 'active')).slice(0, 3);
    for (const lesson of matching) this.usedLessonIds.add(lesson.id);
    const context = matching.length ? `\nPreviously verified repair procedures for this platform (not source facts):\n${matching.map((l) => `- ${l.failureCode}: ${l.procedure}`).join('\n')}\n` : '';
    const recent = this.opts.recentTraces.slice(-3).map((trace) => {
      const failed = [...new Set(trace.attempts.flatMap((attempt) => attempt.failedCodes))].slice(0, 4);
      const last = trace.attempts.at(-1);
      return `- ${trace.status}; checks: ${failed.join(', ') || 'none'}; last action: ${last?.action ?? 'none'}; outcome: ${last?.outcome ?? trace.reason}`;
    });
    const caution = recent.length ? `\nRecent run outcomes for this platform. Failed actions are warnings, not methods to repeat; only verified lessons above are reusable procedures:\n${recent.join('\n')}\n` : '';
    const prompt = `You are writing a Ken Research social post. Use only supplied evidence for facts. Keep the requested output markers and fact IDs. Repository methods and memory never authorize new statistics. Do not change files, browse, or publish. Do not save draft text or market figures as permanent memory.\n${context}${caution}\n${request.prompt}`;
    const answer = await this.call(prompt, 'skills,session_search', request.signal);
    return { text: answer, complete: true, provider: this.id, elapsedMs: Date.now() - started };
  }

  /** Called only after a repair passed the engine validator. Hermes stores procedure, not market data. */
  async rememberLesson(lesson: RepairLesson): Promise<'stored' | 'budget_exhausted'> {
    if (this.calls >= this.opts.maxCalls) return 'budget_exhausted';
    const prompt = `A Ken Research Content Engine repair passed validation. Failure code: ${lesson.failureCode}. Platform: ${lesson.platform}. Verified procedure: ${lesson.procedure}. Use the memory tool to save one compact procedural note, with failure code and platform. Do not save source data, numbers, URLs, draft text, API keys or credentials. Return a short acknowledgement.`;
    await this.call(prompt, 'memory,skills');
    return 'stored';
  }
}
