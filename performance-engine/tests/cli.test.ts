import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PerformanceStore } from '../src/store.js';
import { Finding } from '../src/contracts.js';
const exec = promisify(execFile);

it('CLI import -> learn -> report works locally and does not apply a watch finding', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hermes-performance-cli-'));
  try {
    const accounts = path.join(dir, 'accounts.json'); const input = path.join(dir, 'metrics.json');
    await writeFile(accounts, JSON.stringify({ version: 1, accounts: [{ id: 'qa-account', platform: 'x', kind: 'user', handles: ['qa'] }] }));
    const rows = Array.from({ length: 40 }, (_, i) => ({ postUrl: `https://x.com/qa/status/${10000 + i}`, accountId: 'qa-account', publishedAt: '2026-09-01T00:00:00Z', observedAt: '2026-09-15T00:00:00Z', source: 'synthetic-test-fixture-only', scope: 'all', contentType: 'text', distribution: 'organic', strategy: { layout: i < 10 ? 'weak-layout' : 'strong-layout' }, metrics: { impressions: 1000, likes: i < 10 ? 1 : 90, comments: 1, shares: 1 } }));
    await writeFile(input, JSON.stringify(rows));
    const cli = (command: string, ...extra: string[]) => exec(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'performance-engine/src/cli.ts', command, '--state-dir', dir, '--accounts', accounts, ...extra], { cwd: process.cwd(), timeout: 25000, maxBuffer: 100000 });
    expect((await cli('import', '--file', input)).stdout).toContain('Imported 40');
    expect((await cli('learn')).stdout).toContain('Weak-pattern signals : 1');
    expect((await cli('report')).stdout).toContain('posts with collected metrics: 40');
    const findings = await new PerformanceStore(dir).list('findings', Finding);
    expect(findings.find(f => f.pattern === 'weak-layout')?.status).toBe('watch');
    await expect(cli('apply-policy', '--platform', 'x', '--account', 'qa-account')).rejects.toThrow();
    expect((await cli('status')).stdout).toContain('Registered posts');
    expect((await cli('status')).stdout).toContain(': 40');
  } finally { if (path.dirname(dir) !== path.resolve(os.tmpdir())) throw new Error('Unsafe temp cleanup'); await rm(dir, { recursive: true, force: true }); }
}, 90000);
