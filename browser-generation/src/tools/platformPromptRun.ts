/**
 * platformPromptRun.ts: send one platform prompt (browser-generation/prompts/platform-content/ready/*.txt)
 * to a saved ChatGPT session, record the raw response, extract the deliverable and measure it against the
 * hard limits. Writes everything to output/platform-poc/<run>/.
 *
 * Usage (headed; the account must not be used by another running job):
 *   npx tsx browser-generation/src/tools/platformPromptRun.ts --platform linkedin --account social-image
 *   npx tsx browser-generation/src/tools/platformPromptRun.ts --measure <raw-file> --platform linkedin   (re-measure a saved response)
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { sessionDirForAccount } from '../config/chatGptAccountTracker.js';
import { killChromeForProfile } from '../utils/killChrome.js';
import { attachPromptAsTextFile, dismissBlockingModals } from '../utils/chatgptComposer.js';
import { measure, parseLabelled, formatReport, checkLinks, SPECS, type PlatformId } from './platformMeasure.js';

const SEND = 'button[data-testid="send-button"], button[aria-label="Send prompt"]';
const STOP = 'button[data-testid="stop-button"], button[aria-label*="Stop streaming"], button[aria-label*="Stop"]';
const ASSISTANT = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]';
const COMPOSER = '#prompt-textarea, div[contenteditable="true"].ProseMirror';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const FILES: Record<PlatformId, string> = {
  linkedin: 'linkedin-article.txt', medium: 'medium-story.txt', hackmd: 'hackmd-note.txt', blogger: 'blogger-post.txt', reddit: 'reddit-post.txt',
};
const LABELS: Record<PlatformId, { fields: string[]; article: string }> = {
  linkedin: { fields: ['Article Title', 'SEO Title', 'SEO Description', 'FINAL ARTICLE'], article: 'FINAL ARTICLE' },
  medium: { fields: ['Story Title', 'Subtitle', 'SEO Title', 'SEO Description', 'Tags', 'FINAL ARTICLE'], article: 'FINAL ARTICLE' },
  hackmd: { fields: ['Note Title', 'Description', 'Tags', 'Permalink', 'NOTE'], article: 'NOTE' },
  blogger: { fields: ['Post Title', 'Search Description', 'Labels', 'Custom Permalink', 'FINAL ARTICLE'], article: 'FINAL ARTICLE' },
  reddit: { fields: ['Post Title', 'Post Body', 'Subreddit Fit Notes', 'First Comment'], article: 'Post Body' },
};
const PRIMARY = 'https://www.kenresearch.com/mexico-baby-food-infant-nutrition-market';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function waitDone(page: import('playwright').Page, maxMs: number): Promise<void> {
  const start = Date.now();
  let lastLen = -1, stable = 0;
  while (Date.now() - start < maxMs) {
    await page.waitForTimeout(15000);
    const stopping = await page.locator(STOP).first().isVisible({ timeout: 1500 }).catch(() => false);
    const len = await page.evaluate((sel) => {
      const els = document.querySelectorAll(sel);
      return els.length ? (els[els.length - 1] as HTMLElement).innerText.length : 0;
    }, ASSISTANT).catch(() => 0);
    if (!stopping && len > 0 && len === lastLen) { stable++; if (stable >= 3) return; } else stable = 0;
    lastLen = len;
    console.log(`   waiting... ${Math.round((Date.now() - start) / 1000)}s, reply ${len} chars${stopping ? ' (streaming)' : ''}`);
  }
  throw new Error('TIMEOUT waiting for ChatGPT to finish');
}

async function extract(page: import('playwright').Page): Promise<{ text: string; code: string[] }> {
  return page.evaluate((sel) => {
    const els = document.querySelectorAll(sel);
    const el = els[els.length - 1] as HTMLElement | undefined;
    if (!el) return { text: '', code: [] };
    const code = Array.from(el.querySelectorAll('pre code')).map((c) => (c as HTMLElement).textContent || '');
    return { text: el.innerText, code };
  }, ASSISTANT);
}

function analyse(platform: PlatformId, raw: string, code: string[]) {
  const L = LABELS[platform];
  const fields = parseLabelled(raw, L.fields);
  let article = (fields[L.article] || '').trim();
  if (code.length) article = code.reduce((a, b) => (b.length > a.length ? b : a), '');
  if (platform === 'reddit') article = fields['Post Body'] || article;
  // strip a leading "html"/"markdown" language label some UIs leave in innerText
  article = article.replace(/^(html|markdown)\s*\n/i, '').trim();
  return { fields, article };
}

async function main() {
  const platform = arg('platform') as PlatformId;
  if (!platform || !FILES[platform]) throw new Error('--platform linkedin|medium|hackmd|blogger|reddit');

  const measureFile = arg('measure');
  const outDir = path.resolve('output/platform-poc', arg('run') || new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(outDir, { recursive: true });

  let raw = '', code: string[] = [];
  if (measureFile) {
    raw = fs.readFileSync(measureFile, 'utf-8');
    const m = [...raw.matchAll(/```(?:html|markdown)?\n([\s\S]*?)```/g)].map((x) => x[1]);
    code = m;
  } else {
    const account = arg('account') || 'social-image';
    const promptPath = path.resolve('browser-generation/prompts/platform-content/ready', FILES[platform]);
    const prompt = fs.readFileSync(promptPath, 'utf-8');
    fs.writeFileSync(path.join(outDir, `${platform}.prompt.txt`), prompt);
    const sessionDir = sessionDirForAccount(account);
    await killChromeForProfile(sessionDir); // only this account's own profile
    const ctx = await chromium.launchPersistentContext(sessionDir, {
      headless: false, executablePath: fs.existsSync(CHROME) ? CHROME : chromium.executablePath(),
      viewport: { width: 1366, height: 900 }, ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check', '--window-size=1366,900'],
    });
    try {
      const page = ctx.pages()[0] ?? await ctx.newPage();
      await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
      await dismissBlockingModals(page);
      const ok = await page.locator(COMPOSER).first().isVisible({ timeout: 8000 }).catch(() => false);
      if (!ok) throw new Error(`ChatGPT composer not visible for account "${account}" (session expired?)`);
      console.log(`[${platform}] session ok (${account}); attaching prompt (${prompt.length} chars)...`);
      await attachPromptAsTextFile(page, prompt, {
        filename: `${platform}-prompt.txt`,
        instruction: 'Execute the attached prompt file now and output the full deliverable it specifies.',
      });
      await page.waitForTimeout(6000); // let the file finish uploading
      await dismissBlockingModals(page);
      const userMsgs = () => page.locator('[data-message-author-role="user"]').count().catch(() => 0);
      const before = await userMsgs();
      let sent = false;
      for (let i = 0; i < 4 && !sent; i++) {
        const btn = page.locator(`${SEND}, button[aria-label*="Send"], button[data-testid*="send"], button[type="submit"]`).first();
        const vis = await btn.isVisible({ timeout: 5000 }).catch(() => false);
        console.log(`   send attempt ${i + 1}: send button ${vis ? 'visible' : 'NOT visible'}`);
        if (vis) { await btn.click().catch(() => {}); }
        else {
          await page.locator(COMPOSER).first().click().catch(() => {});
          await page.keyboard.press('Enter');
        }
        for (let t = 0; t < 10 && !sent; t++) {
          await page.waitForTimeout(2000);
          const stopping = await page.locator(STOP).first().isVisible({ timeout: 500 }).catch(() => false);
          const asst = await page.locator(ASSISTANT).count().catch(() => 0);
          if (stopping || asst > 0 || (await userMsgs()) > before) sent = true;
        }
      }
      if (!sent) {
        await page.screenshot({ path: path.join(outDir, `${platform}.send-failed.png`) }).catch(() => {});
        throw new Error('SEND_NOT_CONFIRMED');
      }
      console.log(`[${platform}] sent; waiting for the reply (up to 25 min)...`);
      await waitDone(page, 25 * 60 * 1000);
      const got = await extract(page);
      raw = got.text; code = got.code;
      await page.screenshot({ path: path.join(outDir, `${platform}.png`), fullPage: false }).catch(() => {});
    } finally {
      await ctx.close().catch(() => {});
    }
  }

  fs.writeFileSync(path.join(outDir, `${platform}.raw.txt`), raw);
  const { fields, article } = analyse(platform, raw, code);
  fs.writeFileSync(path.join(outDir, `${platform}.article.${SPECS[platform].format === 'html' ? 'html' : 'md'}`), article);
  fs.writeFileSync(path.join(outDir, `${platform}.fields.json`), JSON.stringify(fields, null, 2));
  const report = measure(platform, article, fields, PRIMARY);
  const links = await checkLinks(article, PRIMARY);
  const text = formatReport(report) + '\n\nLINK STATUS\n' + links.join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, `${platform}.report.txt`), text);
  console.log('\n' + text);
  console.log(`Saved to ${outDir}`);
}

main().catch((e) => { console.error('FAILED:', e?.message || e); process.exit(1); });
