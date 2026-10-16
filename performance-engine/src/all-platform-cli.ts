import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Platform } from './contracts.js';

export const ALL_PERFORMANCE_PLATFORMS: readonly Platform[] = ['x', 'facebook', 'linkedin', 'tumblr'];

export interface AllPlatformOptions {
  limit: number;
  syncLimit: number;
  stateRoot: string;
  writeSheet: boolean;
}

export type PlatformRunner = (platform: Platform, stateDir: string, options: AllPlatformOptions) => Promise<number>;

const positiveInteger = (value: string | undefined, fallback: number, name: string): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) throw new Error(`${name} must be 1-10000.`);
  return parsed;
};

export function defaultStateRoot(now = new Date()): string {
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  return path.resolve('output', 'performance-engine', `auto-all-${stamp}`);
}

export async function runAllPlatforms(options: AllPlatformOptions, runner: PlatformRunner): Promise<void> {
  await mkdir(options.stateRoot, { recursive: true });
  const failed: Platform[] = [];
  for (const platform of ALL_PERFORMANCE_PLATFORMS) {
    const stateDir = path.join(options.stateRoot, platform);
    console.log(`\n${'='.repeat(72)}\n  ${platform.toUpperCase()} PERFORMANCE → HERMES GUIDANCE\n${'='.repeat(72)}`);
    const code = await runner(platform, stateDir, options);
    if (code !== 0) {
      failed.push(platform);
      console.error(`${platform}: feedback failed; its previous active guidance was retained.`);
    }
  }
  if (failed.length) throw new Error(`All-platform feedback completed with failures: ${failed.join(', ')}. Successful platforms were updated; failed platforms retained their previous guidance.`);
  console.log(`\nAll four platform guidance files were replaced successfully. State: ${options.stateRoot}`);
}

export async function processRunner(platform: Platform, stateDir: string, options: AllPlatformOptions): Promise<number> {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const childArgs = [
    ...process.execArgv,
    cli,
    'auto-loop',
    '--platform', platform,
    '--state-dir', stateDir,
    '--limit', String(options.limit),
    '--sync-limit', String(options.syncLimit),
    ...(options.writeSheet ? ['--write-sheet'] : []),
  ];
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, childArgs, {
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        PE_NATIVE_FALLBACK: process.env.PE_NATIVE_FALLBACK ?? '0',
        PE_PUBLIC_BROWSER: process.env.PE_PUBLIC_BROWSER ?? '1',
        PE_BROWSER_CHANNEL: process.env.PE_BROWSER_CHANNEL ?? 'chrome',
      },
    });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

export async function mainAllPlatforms(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs({
    args: argv,
    options: {
      limit: { type: 'string' },
      'sync-limit': { type: 'string' },
      'state-root': { type: 'string' },
      'local-only': { type: 'boolean' },
      help: { type: 'boolean' },
    },
    allowPositionals: false,
  });
  if (parsed.values.help) {
    console.log('Run performance collection, Hermes advisory and active-guidance replacement for X, Facebook, LinkedIn and Tumblr.\n\nOptions: --limit 100 --sync-limit 300 --state-root PATH --local-only');
    return;
  }
  const options: AllPlatformOptions = {
    limit: positiveInteger(parsed.values.limit, 100, 'limit'),
    syncLimit: positiveInteger(parsed.values['sync-limit'], 300, 'sync-limit'),
    stateRoot: path.resolve(parsed.values['state-root'] ?? defaultStateRoot()),
    writeSheet: parsed.values['local-only'] !== true,
  };
  await runAllPlatforms(options, processRunner);
}

if (path.resolve(process.argv[1] ?? '').toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  mainAllPlatforms().catch((error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
