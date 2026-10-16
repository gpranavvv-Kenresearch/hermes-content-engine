import { describe, expect, it } from 'vitest';
import { OUTPUT_BEGIN, OUTPUT_END, TEXT_MARKER } from '../../src/contracts.js';
import { TimeoutError } from '../../src/errors.js';
import { FakeChatGptServer, okReply, type FakePage } from '../fixtures/chatgpt/fake-page.js';
import { cleanReplyText, inspectGeneration, waitForReply } from '../../src/chatgpt/response-capture.js';
import { assessCompleteness, hasEndMarker } from '../../src/chatgpt/response-schema.js';

async function submittedPage(chunks: string[]): Promise<{ server: FakeChatGptServer; page: FakePage }> {
  const server = new FakeChatGptServer();
  server.queueReply(chunks);
  const page = server.newPage();
  await page.goto('https://chatgpt.com/new');
  await page.keyboard.insertText('hello');
  await page.click('button[data-testid="send-button"]');
  return { server, page };
}

describe('cleanReplyText', () => {
  it('removes citation chips, toolbar labels at the edges, tool markup, file pills and chatgpt utm', () => {
    const raw = [
      'Copy',
      'Intro paragraph:contentReference[oaicite:0]{index=0} continues.',
      'kenresearch.com +1',
      'Reuters',
      '+2',
      'See https://kenresearch.com/a?utm_source=chatgpt.com&x=1 and https://kenresearch.com/b?utm_source=chatgpt.com.',
      'Attached ce-prompt-1790724820272-blog-prompt.txt',
      'href="https://x.com/a%22 ok',
      'Share',
    ].join('\n');
    const out = cleanReplyText(raw);
    expect(out).not.toMatch(/oaicite|contentReference|\+\d|^Copy|Share$|ce-prompt|utm_source=chatgpt/m);
    expect(out).toContain('Intro paragraph continues.');
    expect(out).toContain('https://kenresearch.com/a?x=1');
    expect(out).toContain('https://kenresearch.com/b.');
    expect(out).toContain('href="https://x.com/a" ok');
  });

  it('keeps legitimate content: bare domains and toolbar words in the middle, and the output markers', () => {
    const raw = `${OUTPUT_BEGIN}\nFACT_IDS: f1\n${TEXT_MARKER}\nVisit kenresearch.com today.\nShare\nthe results widely.\n${OUTPUT_END}`;
    const out = cleanReplyText(raw);
    expect(out).toBe(raw);
  });

  it('strips the chatgpt-content-reference variants by shape', () => {
    expect(cleanReplyText('a :chatgpt-content-reference{index="9"} b')).toBe('a b');
    expect(cleanReplyText('a chatgpt-content-reference{index="9"} b')).toBe('a b');
  });
});

describe('assessCompleteness / end marker', () => {
  it('complete only with begin, text and end markers', () => {
    expect(assessCompleteness(okReply('Hello world').join('')).complete).toBe(true);
    expect(assessCompleteness(`${OUTPUT_BEGIN}\nFACT_IDS: none\n${TEXT_MARKER}\npartial`)).toEqual({ complete: false, reason: 'missing_end' });
    expect(assessCompleteness('')).toEqual({ complete: false, reason: 'empty' });
    expect(assessCompleteness('no markers')).toEqual({ complete: false, reason: 'missing_begin' });
  });

  it('an echoed instruction template does not satisfy the end marker for a still-streaming real reply', () => {
    const echoed = `${OUTPUT_BEGIN}\n...\n${OUTPUT_END}\n\n${OUTPUT_BEGIN}\nFACT_IDS: none\n${TEXT_MARKER}\nstreaming`;
    expect(hasEndMarker(echoed, OUTPUT_END)).toBe(false);
    expect(hasEndMarker(`${echoed}\n${OUTPUT_END}`, OUTPUT_END)).toBe(true);
  });
});

describe('waitForReply', () => {
  it('waits for the stop button to disappear and the text to stabilise, then returns complete', async () => {
    const { server, page } = await submittedPage(okReply('Hello world'));
    const result = await waitForReply(page, {
      expectedEndMarker: OUTPUT_END,
      timeoutMs: 60_000,
      pollMs: 1,
      stablePolls: 3,
      sleep: async () => server.tick(),
    });
    expect(result.complete).toBe(true);
    expect(result.reason).toBe('done');
    expect(result.stopSeen).toBe(true);
    expect(result.text).toContain('Hello world');
    expect(result.text).not.toContain('Copy'); // toolbar chrome cleaned
    expect(result.polls).toBeGreaterThanOrEqual(3);
  });

  it('a settled reply without the end marker is complete:false (truncation), never complete', async () => {
    const { server, page } = await submittedPage([`${OUTPUT_BEGIN}\nFACT_IDS: none\n${TEXT_MARKER}\ncut off mid sent`]);
    const result = await waitForReply(page, {
      expectedEndMarker: OUTPUT_END,
      timeoutMs: 60_000,
      pollMs: 1,
      stablePolls: 2,
      sleep: async () => server.tick(),
    });
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('missing_end_marker');
    expect(result.text).toContain('cut off mid sent');
  });

  it('without an expected marker, a settled non-empty reply is complete', async () => {
    const { server, page } = await submittedPage(['plain answer']);
    const result = await waitForReply(page, { timeoutMs: 60_000, pollMs: 1, stablePolls: 2, sleep: async () => server.tick() });
    expect(result.complete).toBe(true);
    expect(result.text).toBe('plain answer');
  });

  it('ignores assistant messages that existed before submit (baseline)', async () => {
    const { server, page } = await submittedPage(['new answer']);
    let clock = 0;
    await expect(
      waitForReply(page, {
        timeoutMs: 50,
        pollMs: 10,
        stablePolls: 2,
        baselineAssistantCount: 1, // pretend the only message is old
        sleep: async () => {
          clock += 10;
          server.tick();
        },
        now: () => clock,
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('throws a retryable TimeoutError when the model is still generating at the deadline', async () => {
    const endless = Array.from({ length: 500 }, () => 'x');
    const { server, page } = await submittedPage(endless);
    let clock = 0;
    const err = await waitForReply(page, {
      timeoutMs: 5_000,
      pollMs: 1_000,
      stablePolls: 2,
      sleep: async () => {
        clock += 1_000;
        server.tick();
      },
      now: () => clock,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect((err as TimeoutError).category).toBe('retryable');
  });

  it('honours an abort signal and the blocker hook', async () => {
    const { page } = await submittedPage(okReply('x'));
    const ac = new AbortController();
    ac.abort();
    await expect(waitForReply(page, { timeoutMs: 10, pollMs: 1, stablePolls: 1, signal: ac.signal })).rejects.toThrow();

    const server = new FakeChatGptServer();
    const fresh = server.newPage();
    await fresh.goto('https://chatgpt.com/new');
    await expect(
      waitForReply(fresh, {
        timeoutMs: 10_000,
        pollMs: 1,
        stablePolls: 1,
        sleep: async () => undefined,
        blockerCheck: async () => {
          throw new Error('blocked');
        },
      }),
    ).rejects.toThrow('blocked');
  });
});

describe('inspectGeneration', () => {
  it('reports generating, finished and none', async () => {
    const { server, page } = await submittedPage(okReply('Hello world'));
    expect((await inspectGeneration(page, 0)).state).toBe('generating');
    server.tick();
    server.tick();
    expect((await inspectGeneration(page, 0)).state).toBe('finished');
    const empty = server.newPage();
    await empty.goto('https://chatgpt.com/new');
    expect((await inspectGeneration(empty, 0)).state).toBe('none');
  });
});
