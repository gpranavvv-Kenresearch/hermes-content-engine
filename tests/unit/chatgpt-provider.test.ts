import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OUTPUT_BEGIN, TEXT_MARKER, outputFormatInstruction, parseModelOutput } from '../../src/contracts.js';
import { BudgetExceededError, ShutdownError } from '../../src/errors.js';
import { Budget } from '../../src/safety/budget.js';
import { ShutdownController } from '../../src/safety/shutdown.js';
import { ChatGptProvider, CHATGPT_PROVIDER_ID, type ChatGptProviderOptions } from '../../src/chatgpt/prompt-runner.js';
import { FakeChatGptServer, FakeSession, okReply } from '../fixtures/chatgpt/fake-page.js';
import { createRecoveryPolicy, type RecoveryOptions } from '../../src/chatgpt/recovery-policy.js';
import type { DiagnosticArtifact } from '../../src/chatgpt/session-health.js';

const PROMPT = `${outputFormatInstruction()}\nWrite one sentence about tea.`;

function setup(
  extra: Partial<ChatGptProviderOptions> = {},
  recovery: RecoveryOptions = {},
  configure?: (server: FakeChatGptServer) => void,
) {
  const server = new FakeChatGptServer();
  configure?.(server);
  const session = new FakeSession(server);
  const diagnostics: DiagnosticArtifact[] = [];
  const provider = new ChatGptProvider({
    session,
    sleep: async () => server.tick(),
    humanDelay: async () => undefined,
    pollMs: 1,
    stablePolls: 2,
    diagnosticWriter: async (a) => {
      diagnostics.push(a);
    },
    recovery: createRecoveryPolicy({ initialDelayMs: 1, maxDelayMs: 2, rateLimitDefaultWaitMs: 1, rateLimitMaxWaitMs: 10, ...recovery }),
    ...extra,
  });
  return { server, session, provider, diagnostics };
}

const noFill = (server: FakeChatGptServer) => server.pages.every((p) => p.fillCalls === 0);

describe('ChatGptProvider happy path', () => {
  it('generates, returns cleaned parseable text, complete:true, and never calls page.fill', async () => {
    const { server, provider } = setup({}, {}, (s) => s.queueReply(okReply('Tea is a beverage.')));
    const result = await provider.generate({ prompt: PROMPT, purpose: 'draft' });

    expect(provider.id).toBe(CHATGPT_PROVIDER_ID);
    expect(result.provider).toBe('chatgpt-browser');
    expect(result.complete).toBe(true);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    const parsed = parseModelOutput(result.text);
    expect(parsed.ok && parsed.output.text).toBe('Tea is a beverage.');
    expect(result.text).not.toMatch(/Copy|Share/);

    expect(server.submissions).toHaveLength(1);
    expect(server.submissions[0]!.composerText).toBe(PROMPT); // multi-line prompt typed faithfully
    expect(server.submissions[0]!.attachedFiles).toHaveLength(0);
    expect(noFill(server)).toBe(true);
    // new chat was opened, never networkidle-style waiting (not even expressible in PageLike)
    expect(server.pages[0]!.gotoLog).toContain('https://chatgpt.com/new');
  });

  it('uses the long reply timeout only when expectLong is set', async () => {
    const msFor = async (expectLong: boolean): Promise<unknown> => {
      let clock = 0;
      const { server, provider } = setup(
        {
          timeouts: { chatGptShortReply: 3_000, chatGptLongReply: 9_000 },
          pollMs: 1_000,
          now: () => clock,
          sleep: async () => {
            clock += 1_000;
            server.tick();
          },
        },
        { maxAttempts: 1 },
        (s) => s.queueReply(Array.from({ length: 500 }, () => 'x')),
      );
      const err = await provider.generate({ prompt: PROMPT, purpose: 'p', expectLong }).catch((e: unknown) => e);
      return (err as { detail?: { ms?: number } }).detail?.ms;
    };
    expect(await msFor(false)).toBe(3_000);
    expect(await msFor(true)).toBe(9_000);
  });
});

describe('truncated and blocked replies', () => {
  it('a reply missing OUTPUT_END is returned complete:false, never as if complete', async () => {
    const { provider } = setup({}, {}, (s) => s.queueReply([`${OUTPUT_BEGIN}\nFACT_IDS: none\n${TEXT_MARKER}\nCut off in the mid`]));
    const result = await provider.generate({ prompt: PROMPT, purpose: 'draft' });
    expect(result.complete).toBe(false);
    expect(result.text).toContain('Cut off in the mid');
  });

  it('login wall -> auth_required, one health check, nothing submitted, diagnostic saved, not retried', async () => {
    const { server, provider, diagnostics } = setup({}, {}, (s) => (s.mode = 'login'));
    await expect(provider.generate({ prompt: PROMPT, purpose: 'draft' })).rejects.toMatchObject({
      category: 'auth_required',
      code: 'LOGIN_REQUIRED',
    });
    expect(server.submissions).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.state).toBe('login_required');
  });

  it('captcha/challenge -> needs_human, not retried', async () => {
    const { server, provider, diagnostics } = setup({}, {}, (s) => (s.mode = 'challenge'));
    await expect(provider.generate({ prompt: PROMPT, purpose: 'draft' })).rejects.toMatchObject({
      category: 'needs_human',
      code: 'CHALLENGE',
    });
    expect(server.submissions).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
  });

  it('rate-limit text -> rate_limited carrying retryAfterMs; a too-long wait is not waited out', async () => {
    const { server, provider, diagnostics } = setup({}, {}, (s) => (s.mode = 'rate_limit'));
    await expect(provider.generate({ prompt: PROMPT, purpose: 'draft' })).rejects.toMatchObject({
      category: 'rate_limited',
      retryAfterMs: 120_000,
    });
    expect(server.submissions).toHaveLength(0);
    expect(diagnostics).toHaveLength(1); // checked once, not retried
  });

  it('rate-limit modal appearing AFTER submit is detected and the prompt is not resubmitted', async () => {
    const { server, provider } = setup({}, {}, (s) => (s.rateLimitOnSubmit = true));
    await expect(provider.generate({ prompt: PROMPT, purpose: 'draft' })).rejects.toMatchObject({
      category: 'rate_limited',
      retryAfterMs: 120_000,
    });
    expect(server.submissions).toHaveLength(1);
  });

  it('prompt text mentioning "rate limit" is not mistaken for a rate-limit notice', async () => {
    const { server, provider } = setup({}, {}, (s) => s.queueReply(okReply('fine')));
    const result = await provider.generate({ prompt: `${PROMPT}\nTopic: API rate limit design. Too many requests.`, purpose: 'draft' });
    expect(result.complete).toBe(true);
    expect(server.submissions).toHaveLength(1);
  });

  it('unrecognised UI -> needs_human after reloading once', async () => {
    const { provider } = setup({}, {}, (s) => (s.mode = 'ui_changed'));
    await expect(provider.generate({ prompt: PROMPT, purpose: 'draft' })).rejects.toMatchObject({ category: 'needs_human', code: 'UI_UNKNOWN' });
  });
});

describe('browser crash mid-run: relaunch without duplicate submission', () => {
  it('relaunches, reopens the same conversation, captures the still-running generation, submits exactly once', async () => {
    const { server, session, provider } = setup({}, {}, (s) => {
      s.queueReply(okReply('Resumed after crash'));
      s.crashOnTick(1); // browser dies after the first streamed chunk
    });
    const result = await provider.generate({ prompt: PROMPT, purpose: 'draft' });

    expect(session.relaunchCount).toBe(1);
    expect(server.submissions).toHaveLength(1); // NO duplicate prompt
    expect(result.complete).toBe(true);
    const parsed = parseModelOutput(result.text);
    expect(parsed.ok && parsed.output.text).toBe('Resumed after crash');
    // the new page navigated back to the existing conversation rather than /new
    const lastPage = server.pages[server.pages.length - 1]!;
    expect(lastPage.gotoLog[0]).toMatch(/\/c\/conv1$/);
    expect(noFill(server)).toBe(true);
  });

  it('captures an already-finished generation after the crash instead of resubmitting', async () => {
    const { server, session, provider } = setup({}, {}, (s) => {
      s.queueReply(okReply('Finished before crash'));
      s.crashOnTick(2); // both chunks delivered, then the browser dies
    });
    const result = await provider.generate({ prompt: PROMPT, purpose: 'draft' });
    expect(session.relaunchCount).toBe(1);
    expect(server.submissions).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(result.text).toContain('Finished before crash');
  });

  it('refuses to resubmit when the conversation URL was never captured (DUPLICATE_RISK)', async () => {
    const { server, provider } = setup({ conversationUrlPolls: 1 }, {}, (s) => {
      s.assignConversationUrl = false;
      s.queueReply(okReply('x'));
      s.crashOnTick(1);
    });
    await expect(provider.generate({ prompt: PROMPT, purpose: 'draft' })).rejects.toMatchObject({
      category: 'needs_human',
      code: 'DUPLICATE_RISK',
    });
    expect(server.submissions).toHaveLength(1);
  });

  it('a crash BEFORE the send is safe to redo from scratch (still exactly one submission)', async () => {
    const { server, session, provider } = setup({}, {}, (s) => s.queueReply(okReply('Fresh start')));
    let crashed = false;
    const original = session.getPage.bind(session);
    session.getPage = async () => {
      const page = await original();
      if (!crashed) {
        crashed = true;
        page.keyboard.insertText = async () => {
          (page as unknown as { crash(): void }).crash();
          throw Object.assign(new Error('Target page, context or browser has been closed'), { name: 'TargetClosedError' });
        };
      }
      return page;
    };
    const result = await provider.generate({ prompt: PROMPT, purpose: 'draft' });
    expect(result.complete).toBe(true);
    expect(session.relaunchCount).toBe(1);
    expect(server.submissions).toHaveLength(1);
  });
});

describe('circuit breaker through the provider', () => {
  it('opens after N consecutive failed generations and then fails fast', async () => {
    const { server, provider } = setup({}, { maxAttempts: 1, breakerThreshold: 2, breakerHalfOpenAfterMs: 60_000 }, (s) => (s.mode = 'ui_changed'));
    for (let i = 0; i < 2; i++) {
      await expect(provider.generate({ prompt: PROMPT, purpose: 'draft' })).rejects.toMatchObject({ code: 'UI_UNKNOWN' });
    }
    expect(provider.accountPaused).toBe(true);
    expect(provider.breakerState).toBe('open');
    const gotos = server.pages.reduce((n, p) => n + p.gotoLog.length, 0);
    await expect(provider.generate({ prompt: PROMPT, purpose: 'draft' })).rejects.toMatchObject({ code: 'ACCOUNT_PAUSED' });
    expect(server.pages.reduce((n, p) => n + p.gotoLog.length, 0)).toBe(gotos); // browser untouched
  });
});

describe('safety gates', () => {
  it('budget exhausted -> BudgetExceededError, no second submission', async () => {
    const budget = new Budget('chatgpt', 1);
    const { server, provider } = setup({ budget }, {}, (s) => s.queueReply(okReply('one')));
    await provider.generate({ prompt: PROMPT, purpose: 'draft' });
    await expect(provider.generate({ prompt: PROMPT, purpose: 'draft' })).rejects.toBeInstanceOf(BudgetExceededError);
    expect(server.submissions).toHaveLength(1);
    expect(budget.remaining).toBe(0);
  });

  it('shutdown started -> ShutdownError, browser never touched, budget not spent', async () => {
    const shutdown = new ShutdownController();
    const budget = new Budget('chatgpt', 5);
    const { server, provider } = setup({ shutdown, budget });
    await shutdown.shutdown(10);
    await expect(provider.generate({ prompt: PROMPT, purpose: 'draft' })).rejects.toBeInstanceOf(ShutdownError);
    expect(server.submissions).toHaveLength(0);
    expect(server.pages.every((p) => p.gotoLog.length === 0)).toBe(true);
    expect(budget.spent).toBe(0);
  });

  it('tracks in-flight work with the shutdown controller', async () => {
    const shutdown = new ShutdownController();
    const { provider } = setup({ shutdown }, {}, (s) => s.queueReply(okReply('tracked')));
    const p = provider.generate({ prompt: PROMPT, purpose: 'draft' });
    const done = await p;
    expect(done.complete).toBe(true);
    expect(shutdown.inFlightCount).toBe(0);
  });

  it('serialises concurrent generate calls on the single page', async () => {
    const { server, provider } = setup({}, {}, (s) => {
      s.queueReply(okReply('first'));
      s.queueReply(okReply('second'));
    });
    const [a, b] = await Promise.all([
      provider.generate({ prompt: PROMPT, purpose: 'a' }),
      provider.generate({ prompt: PROMPT, purpose: 'b' }),
    ]);
    expect(a.text).toContain('first');
    expect(b.text).toContain('second');
    expect(server.submissions).toHaveLength(2);
  });
});

describe('long prompt delivery', () => {
  it('attaches prompts above the threshold as a .txt file plus a one-line instruction, no fill, temp file cleaned', async () => {
    const longPrompt = `${outputFormatInstruction()}\n${'Background paragraph. '.repeat(400)}`;
    expect(longPrompt.length).toBeGreaterThan(6_000);
    const { server, provider } = setup({}, {}, (s) => s.queueReply(okReply('Long answer')));
    const result = await provider.generate({ prompt: longPrompt, purpose: 'draft', expectLong: true });

    expect(result.complete).toBe(true);
    const sub = server.submissions[0]!;
    expect(sub.attachedFiles).toHaveLength(1);
    expect(sub.attachedFiles[0]).toMatch(/ce-prompt-\d+\.txt$/);
    expect(sub.attachedContents[0]).toBe(longPrompt);
    expect(sub.composerText).toMatch(/Execute the attached instructions immediately/);
    expect(sub.composerText.length).toBeLessThan(300);
    expect(fs.existsSync(sub.attachedFiles[0]!)).toBe(false);
    expect(noFill(server)).toBe(true);
  });

  it('short prompts are typed, not attached', async () => {
    const { server, provider } = setup({ longPromptThreshold: 100_000 }, {}, (s) => s.queueReply(okReply('ok')));
    await provider.generate({ prompt: PROMPT, purpose: 'draft' });
    expect(server.submissions[0]!.attachedFiles).toHaveLength(0);
  });
});
