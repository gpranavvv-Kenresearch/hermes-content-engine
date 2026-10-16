import { spawn } from 'node:child_process';
import { parseHermesStream } from '../../src/social/hermes-provider.js';
import type { HermesAsk } from './supervisor.js';

export interface HermesAskOptions {
  command?: string;
  provider?: string;
  timeoutMs?: number;
  toolsets?: string;
  signal?: AbortSignal;
}

/** One `hermes chat --oneshot` call per question, same interface the engine's HermesProvider uses. */
export function createHermesAsk(options: HermesAskOptions = {}): HermesAsk {
  const command = options.command ?? process.env.HCE_HERMES_BIN ?? 'hermes';
  const provider = options.provider ?? 'openai-codex';
  const timeoutMs = options.timeoutMs ?? 180_000;
  const toolsets = options.toolsets ?? 'skills';
  return (prompt) =>
    new Promise<string>((resolve, reject) => {
      if (options.signal?.aborted) { reject(new Error('Hermes call cancelled')); return; }
      const args = ['chat', '--oneshot', '--query-file', '-', '--format', 'stream-json', '--provider', provider, '--toolsets', toolsets, '--max-turns', '4', '--source', 'tool'];
      const child = spawn(command, args, { cwd: process.cwd(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let done = false;
      const finish = (error?: Error, value?: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value ?? '');
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error(`Hermes timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      const onAbort = (): void => { child.kill(); finish(new Error('Hermes call cancelled')); };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8');
        if (out.length > 2_000_000) {
          child.kill();
          finish(new Error('Hermes output exceeded 2 MB'));
        }
      });
      child.stderr.on('data', (c: Buffer) => {
        err = (err + c.toString('utf8')).slice(-2_000);
      });
      child.on('error', (e) => finish(new Error(`Hermes could not start: ${e.message}`)));
      child.on('close', (code) => {
        if (code !== 0) return finish(new Error(`Hermes exited ${code}. ${err.trim().slice(-200)}`));
        try {
          const result = parseHermesStream(out);
          if (result.exit_code !== 0 || !result.text?.trim()) return finish(new Error(`Hermes turn failed (${result.exit_code}): ${result.error ?? 'no answer'}`));
          finish(undefined, result.text);
        } catch (e) {
          finish(e as Error);
        }
      });
      child.stdin.on('error', () => {
        /* the close handler reports a failed process */
      });
      child.stdin.end(prompt);
    });
}
