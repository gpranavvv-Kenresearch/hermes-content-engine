import 'dotenv/config';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { listChatGptAccounts } from './config/chatGptAccountTracker.js';
import type { BlogGenBatchOptions } from './coordinator/blogGenLoop.js';

const ROOT = process.cwd();
const MODULE_ROOT = path.resolve(ROOT, 'browser-generation');

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function forwardedArgs(command: string): string[] {
  const index = process.argv.indexOf(command);
  return index >= 0 ? process.argv.slice(index + 1) : [];
}

async function runChild(command: string, args: string[], cwd = ROOT): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

function blogOptions(): BlogGenBatchOptions {
  const limit = flag('limit');
  return {
    limit: limit ? Number.parseInt(limit, 10) : undefined,
    withImage: has('with-image') && !has('no-image'),
    imagePromptChoice: flag('image-prompt') === '2' ? '2' : '1',
    blogAccountHandle: flag('blog-account'),
    imageAccountHandle: flag('image-account'),
    retryOnVerifyFail: !has('no-retry'),
  };
}

async function doctor(): Promise<void> {
  const required = [
    'browser-generation/single-image/scripts/run_single_image_test.js',
    'browser-generation/six-slide/scripts/runRow.ts',
    'browser-generation/src/coordinator/blogGenLoop.ts',
  ];
  const missing: string[] = [];
  for (const file of required) {
    try { await access(path.resolve(ROOT, file)); } catch { missing.push(file); }
  }
  const checks = {
    moduleFiles: missing.length === 0 ? 'ok' : `missing: ${missing.join(', ')}`,
    sheetCredential: process.env.GOOGLE_SERVICE_ACCOUNT_JSON
      ? 'GOOGLE_SERVICE_ACCOUNT_JSON'
      : await access(path.resolve(ROOT, '.accounts/google-service-account.json')).then(() => '.accounts/google-service-account.json').catch(() => 'missing'),
    driveClient: await access(path.resolve(ROOT, '.accounts/google-drive-oauth-client.json')).then(() => 'ok').catch(() => 'missing (needed for blog images)'),
    driveToken: await access(path.resolve(ROOT, '.accounts/google-drive-token.json')).then(() => 'ok').catch(() => 'missing (needed for blog images)'),
    chatGptAccounts: listChatGptAccounts(),
  };
  console.log(JSON.stringify(checks, null, 2));
  if (missing.length) process.exitCode = 1;
}

function help(): void {
  console.log(`Hermes browser generation\n\nCommands:\n  npm run browser:doctor\n  npm run browser:login -- <account>\n  npm run browser:single -- --row=5\n  npm run browser:single -- --count=5\n  npm run browser:carousel -- --row=5\n  npm run browser:carousel -- --count=5\n  npm run browser:blog -- --limit=1 --with-image\n  npm run browser:blog-loop -- --limit=1 --with-image --interval=1800\n  npm run browser:blog -- --limit=10 --structure=rotate   (v1.3 | rotate | random | <architecture id>)\n  npm run browser:blog-structures   (rebuild the per-architecture prompt files from V1.3)\n\nAccounts normally used:\n  carousel-single  single image\n  storyline        six-slide carousel\n  social-image     blog text\n  account2         blog cover image`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'help';
  if (command === 'doctor') return doctor();
  if (command === 'login') {
    const account = process.argv[3] ?? 'default';
    return runChild(process.execPath, ['--import', 'tsx', path.join(MODULE_ROOT, 'src/tools/loginChatGpt.ts'), account]);
  }
  if (command === 'single') {
    return runChild(process.execPath, ['--import', 'tsx', 'scripts/run_single_image_test.js', ...forwardedArgs(command)], path.join(MODULE_ROOT, 'single-image'));
  }
  if (command === 'carousel') {
    // Spawn node directly: Node on Windows rejects spawning npx.cmd without a shell (EINVAL).
    return runChild(process.execPath, ['--import', 'tsx', path.join(MODULE_ROOT, 'six-slide/scripts/runRow.ts'), ...forwardedArgs(command)]);
  }
  if (command === 'blog' || command === 'blog-loop') {
    const structure = flag('structure');
    if (structure) process.env.BLOG_STRUCTURE = structure;
  }
  if (command === 'blog') {
    const { runBlogGenBatch } = await import('./coordinator/blogGenLoop.js');
    const result = await runBlogGenBatch(blogOptions());
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'blog-loop') {
    const { runBlogGenLoop } = await import('./coordinator/blogGenLoop.js');
    const intervalSeconds = Number.parseInt(flag('interval') ?? '1800', 10);
    return runBlogGenLoop({ ...blogOptions(), intervalSeconds });
  }
  help();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
