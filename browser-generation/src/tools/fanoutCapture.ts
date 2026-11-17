/**
 * fanoutCapture.ts: raw capture of what ChatGPT sends to the browser while it answers one question with web search.
 *
 *   npm run fanout:capture -- --q "best lubricant brands in Kenya 2026" --account=blog-main [--show] [--wait=300]
 *
 * It records, before the question is sent: WebSocket frames (Playwright and CDP), event-stream messages, and the bodies of the
 * backend conversation requests. Everything is appended to .cache/chatgpt-fanout/<slug>/frames.jsonl, next to the visible answer
 * (answer.txt) and the source links shown in the answer (sources.json). Nothing is written to the sheet or the repo's sources.
 * There is no query parser yet: the point of this run is to see where the search queries actually are in the payload.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { closeChatGptBrowser, COMPOSER_SELECTOR, ensureChatGptPage } from '../browser/chatgpt/login.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/s);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  }),
) as Record<string, string | boolean>;

const question = String(args.q ?? '').trim();
const account = String(args.account ?? 'blog-main');
const maxWaitSec = Number.parseInt(String(args.wait ?? '300'), 10);
if (!question) { console.error('Usage: npm run fanout:capture -- --q "your question" --account=blog-main [--show] [--wait=300]'); process.exit(1); }
if (args.show) process.env.SHOW_BROWSER = '1';

const slug = question.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'question';
const outDir = path.resolve('.cache', 'chatgpt-fanout', `${slug}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`);
fs.mkdirSync(outDir, { recursive: true });
const framesFile = path.join(outDir, 'frames.jsonl');
const stats = { wsFrames: 0, cdpWsFrames: 0, eventSource: 0, responses: 0, lastFrameAt: Date.now() };

const write = (source: string, extra: Record<string, unknown>): void => {
  stats.lastFrameAt = Date.now();
  fs.appendFileSync(framesFile, `${JSON.stringify({ t: new Date().toISOString(), source, ...extra })}\n`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function attachListeners(page: Page): Promise<void> {
  page.on('websocket', (ws) => {
    write('ws-open', { url: ws.url() });
    ws.on('framereceived', (f) => { stats.wsFrames++; write('ws-in', { url: ws.url(), payload: typeof f.payload === 'string' ? f.payload : `[binary ${f.payload.length} bytes] ${f.payload.toString('base64').slice(0, 4000)}` }); });
    ws.on('framesent', (f) => write('ws-out', { url: ws.url(), payload: typeof f.payload === 'string' ? f.payload : '[binary]' }));
    ws.on('close', () => write('ws-close', { url: ws.url() }));
  });

  page.on('response', (res) => {
    const req = res.request();
    if (!/backend-api\/.*conversation|backend-api\/.*search|\/ces\/|\/sentinel\//i.test(res.url())) return;
    if (!/conversation|search/i.test(res.url())) return;
    stats.responses++;
    write('http-response', { url: res.url(), method: req.method(), status: res.status(), contentType: res.headers()['content-type'] ?? '', requestBody: req.method() === 'POST' ? (req.postData() ?? '').slice(0, 4000) : '' });
    // The body of an event stream arrives when the stream ends. Read it in the background and store it whole.
    void res.text().then((body) => write('http-body', { url: res.url(), bytes: body.length, body })).catch((e: Error) => write('http-body-error', { url: res.url(), error: e.message }));
  });

  // CDP sees frames and event-stream messages even when the higher-level events miss them.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', (e: any) => { stats.cdpWsFrames++; write('cdp-ws-in', { requestId: e.requestId, opcode: e.response?.opcode, payload: String(e.response?.payloadData ?? '').slice(0, 200_000) }); });
  cdp.on('Network.webSocketFrameSent', (e: any) => write('cdp-ws-out', { requestId: e.requestId, payload: String(e.response?.payloadData ?? '').slice(0, 20_000) }));
  cdp.on('Network.eventSourceMessageReceived', (e: any) => { stats.eventSource++; write('cdp-sse', { requestId: e.requestId, eventName: e.eventName, data: String(e.data ?? '').slice(0, 200_000) }); });
}

/** Turns web search on if the composer offers a control for it. Returns how it was done, for the log. */
async function enableSearch(page: Page): Promise<string> {
  const direct = page.locator('button:has-text("Search"), button[aria-label*="Search" i]').first();
  if (await direct.isVisible({ timeout: 1500 }).catch(() => false)) {
    const pressed = await direct.getAttribute('aria-pressed').catch(() => null);
    if (pressed === 'true') return 'search button already on';
    await direct.click().catch(() => {});
    return 'clicked the Search button next to the composer';
  }
  const plus = page.locator('button[aria-label*="Add" i], button[data-testid="composer-plus-btn"], button[aria-label*="Attach" i]').first();
  if (await plus.isVisible({ timeout: 1500 }).catch(() => false)) {
    await plus.click().catch(() => {});
    const item = page.locator('[role="menuitem"]:has-text("Web search"), [role="menuitemradio"]:has-text("Web search"), [role="menuitem"]:has-text("Search")').first();
    if (await item.isVisible({ timeout: 2000 }).catch(() => false)) { await item.click().catch(() => {}); return 'chose Web search from the + menu'; }
    await page.keyboard.press('Escape').catch(() => {});
  }
  return 'no Search control found (the question text asks ChatGPT to search the web instead)';
}

async function main(): Promise<void> {
  console.log(`Question: ${question}\nAccount:  ${account}\nOutput:   ${outDir}\n`);
  const page = await ensureChatGptPage(account);
  await attachListeners(page);
  // Reload so the page's own WebSocket opens AFTER the listeners are in place.
  await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(6000);

  const composer = page.locator(COMPOSER_SELECTOR).first();
  if (!(await composer.isVisible({ timeout: 15_000 }).catch(() => false))) throw new Error('ChatGPT composer not visible: the account is not logged in or a popup is blocking it.');

  const searchHow = await enableSearch(page);
  console.log(`Search mode: ${searchHow}`);
  const needsPrefix = searchHow.startsWith('no Search control');
  const text = needsPrefix ? `Search the web and answer with current sources: ${question}` : question;

  await composer.click();
  await page.keyboard.insertText(text);
  await page.waitForTimeout(800);
  write('question', { text, searchMode: searchHow });
  await page.keyboard.press('Enter');
  console.log('Sent. Waiting for the answer to finish...');

  const started = Date.now();
  let sawStop = false;
  while ((Date.now() - started) / 1000 < maxWaitSec) {
    await sleep(3000);
    const generating = await page.locator('button[data-testid="stop-button"], button[aria-label*="Stop" i]').first().isVisible({ timeout: 500 }).catch(() => false);
    if (generating) sawStop = true;
    const quietFor = (Date.now() - stats.lastFrameAt) / 1000;
    if (sawStop && !generating && quietFor > 10) break;
    if (!sawStop && (Date.now() - started) / 1000 > 45) { console.log('The answer never started (no stop button after 45 s). Check the browser/account.'); break; }
  }
  await sleep(4000); // let the background body reads finish

  const answer = await page.locator('[data-message-author-role="assistant"]').last().innerText().catch(() => '');
  fs.writeFileSync(path.join(outDir, 'answer.txt'), answer);
  const links = await page.locator('[data-message-author-role="assistant"] a[href^="http"]').evaluateAll((as) => as.map((a) => ({ text: (a.textContent ?? '').trim().slice(0, 140), href: (a as HTMLAnchorElement).href }))).catch(() => []);
  fs.writeFileSync(path.join(outDir, 'sources.json'), JSON.stringify(links, null, 2));

  const raw = fs.readFileSync(framesFile, 'utf8');
  const hits = (raw.match(/search/gi) ?? []).length;
  console.log(`\nDone. Playwright WebSocket frames: ${stats.wsFrames}, CDP WebSocket frames: ${stats.cdpWsFrames}, event-stream messages: ${stats.eventSource}, conversation responses: ${stats.responses}`);
  console.log(`Answer: ${answer.length} chars, ${links.length} links. The word "search" appears ${hits} times in frames.jsonl.`);
  console.log(`Open: ${framesFile}`);
}

main()
  .catch((e) => { console.error(`\nFailed: ${(e as Error).message}`); process.exitCode = 1; })
  .finally(async () => { await closeChatGptBrowser().catch(() => {}); });
