import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ALL_PERFORMANCE_PLATFORMS, runAllPlatforms, type PlatformRunner } from '../src/all-platform-cli.js';

describe('all-platform automatic feedback', () => {
  it('runs every platform in order with an isolated state directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pe-auto-all-'));
    const calls: Array<{ platform: string; stateDir: string }> = [];
    const runner: PlatformRunner = async (platform, stateDir) => {
      calls.push({ platform, stateDir });
      return 0;
    };
    await runAllPlatforms({ limit: 100, syncLimit: 300, stateRoot: root, writeSheet: true }, runner);
    expect(calls.map(call => call.platform)).toEqual(ALL_PERFORMANCE_PLATFORMS);
    expect(calls.map(call => call.stateDir)).toEqual(ALL_PERFORMANCE_PLATFORMS.map(platform => path.join(root, platform)));
  });

  it('continues other platforms and reports failures at the end', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pe-auto-all-'));
    const calls: string[] = [];
    const runner: PlatformRunner = async platform => {
      calls.push(platform);
      return platform === 'facebook' ? 1 : 0;
    };
    await expect(runAllPlatforms({ limit: 100, syncLimit: 300, stateRoot: root, writeSheet: false }, runner)).rejects.toThrow('facebook');
    expect(calls).toEqual(ALL_PERFORMANCE_PLATFORMS);
  });
});
