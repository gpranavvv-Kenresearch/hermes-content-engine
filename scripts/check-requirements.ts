import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadEnvFiles } from '../src/llm/env.js';
import { loadConfig } from '../src/config/index.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

const checks: Check[] = [];
const add = (name: string, ok: boolean, detail: string, required = true) => checks.push({ name, ok, detail, required });

loadEnvFiles();

const nodeMajor = Number(process.versions.node.split('.')[0]);
add('Node.js', nodeMajor >= 22, `${process.version}; version 22 or newer is required`);
add('Dependencies', existsSync(path.resolve('node_modules', 'tsx')), existsSync(path.resolve('node_modules', 'tsx')) ? 'installed from the committed lockfile' : 'run npm ci');
add('Local environment', existsSync(path.resolve('.env')), 'copy .env.example to .env and fill local paths/IDs');

try {
  loadConfig();
  add('Engine configuration', true, 'validated');
} catch (error) {
  add('Engine configuration', false, (error as Error).message);
}

const sheetId = process.env.CE_SHEET_ID?.trim();
add('Google Sheet ID', Boolean(sheetId), sheetId ? 'configured privately' : 'set CE_SHEET_ID in .env');

try {
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const file = process.env.CE_GOOGLE_SA_FILE?.trim();
  const raw = inline || (file ? readFileSync(file, 'utf8') : '');
  const parsed = JSON.parse(raw) as { client_email?: string; private_key?: string };
  add('Google service account', Boolean(parsed.client_email && parsed.private_key), 'credential JSON contains client_email and private_key');
} catch {
  add('Google service account', false, 'set CE_GOOGLE_SA_FILE or GOOGLE_SERVICE_ACCOUNT_JSON');
}

const hermesCommand = process.env.HCE_HERMES_BIN?.trim() || 'hermes';
const hermes = spawnSync(hermesCommand, ['--version'], { windowsHide: true, timeout: 15_000, encoding: 'utf8' });
add('Hermes CLI', hermes.status === 0, hermes.status === 0 ? 'executable responded' : 'install/login and set HCE_HERMES_BIN if it is not on PATH');

const chromeCandidates = process.platform === 'win32'
  ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(root => path.join(root!, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
const chromeAvailable = chromeCandidates.some(existsSync);
add('Chrome browser', chromeAvailable, 'required by the public-page browser fallback used by automatic performance runs');

add('Tavily research', Boolean(process.env.TAVILY_API_KEY?.trim() || process.env.TAVILY_API_KEY_1?.trim()), 'optional; curated reviewed sources are used when absent', false);
add('Native analytics APIs', process.env.PE_NATIVE_FALLBACK === '1', 'optional; public URL collection is the default', false);

const width = Math.max(...checks.map(check => check.name.length));
console.log('\nHERMES CONTENT ENGINE REQUIREMENTS\n');
for (const check of checks) {
  const status = check.ok ? 'OK' : check.required ? 'MISSING' : 'OPTIONAL';
  console.log(`${check.name.padEnd(width)}  ${status.padEnd(8)}  ${check.detail}`);
}
const missing = checks.filter(check => check.required && !check.ok);
if (missing.length) {
  console.error(`\n${missing.length} required item(s) need attention. See docs/SETUP.md.`);
  process.exitCode = 1;
} else {
  console.log('\nRequired local dependencies are ready. Verify live Sheet access with: npm run hce:doctor -- --check-sheet');
}
