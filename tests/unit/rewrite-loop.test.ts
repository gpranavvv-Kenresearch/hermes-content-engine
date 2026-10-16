import { describe, expect, it } from 'vitest';
import { BudgetExceededError, ShutdownError } from '../../src/errors.js';
import { Budget } from '../../src/safety/budget.js';
import { ShutdownController } from '../../src/safety/shutdown.js';
import { runRewriteLoop, type GeneratedText } from '../../src/rewrite/rewrite-loop.js';
import {
  BASE_URL,
  config,
  FakeLlmProvider,
  noClaimIssues,
  reply,
  sampleFact,
  utmLink,
  validate,
  wrapReply,
} from '../fixtures/validation/helpers.js';

const GOOD = `Ken Research finds Examplestan widget buyers weigh service coverage above price. ${utmLink('x')} #Widgets`;
const BAD_NO_LINK = 'Ken Research finds Examplestan widget buyers weigh service coverage above price. #Widgets';
const BAD_COMPETITOR = `According to IMARC Group buyers weigh service coverage above price. ${utmLink('x')} #Widgets`;

const base = (initialText: string, provider: FakeLlmProvider, extra: Partial<Parameters<typeof runRewriteLoop>[0]> = {}) =>
  runRewriteLoop({
    initial: async (): Promise<GeneratedText> => ({ text: initialText, factIds: [] }),
    provider,
    validate: (text) => validate(text, 'x', [], noClaimIssues),
    facts: [sampleFact],
    platform: 'x',
    config,
    maxRounds: 3,
    sourceUrl: BASE_URL,
    ...extra,
  });

describe('runRewriteLoop', () => {
  it('approves immediately when the initial text passes (no LLM call)', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(GOOD))]);
    const result = await base(GOOD, provider);
    expect(result.status).toBe('approved');
    expect(provider.requests).toHaveLength(0);
    expect(result.rounds).toBe(0);
    expect(result.attempts.map((a) => a.kind)).toEqual(['initial']);
  });

  it('fixes deterministic problems without calling the LLM', async () => {
    const dashed = `Ken Research finds growth — fast. ${BASE_URL} #Widgets`;
    const provider = new FakeLlmProvider([]);
    const result = await base(dashed, provider);
    expect(result.status).toBe('approved');
    expect(provider.requests).toHaveLength(0);
    expect(result.attempts.map((a) => a.kind)).toEqual(['initial', 'fixer']);
    expect(result.attempts[1]!.fixes).toEqual(['REPLACE_DASHES', 'NORMALIZE_UTM']);
    expect(result.text).toContain(utmLink('x'));
  });

  it('succeeds on round 2 after a first rewrite that still fails', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(BAD_NO_LINK, ['F1'])), reply(wrapReply(GOOD, ['F1']))]);
    const result = await base(BAD_NO_LINK, provider);
    expect(result.status).toBe('approved');
    expect(result.rounds).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(result.text).toBe(GOOD);
    expect(result.factIds).toEqual(['F1']);
    expect(result.attempts.map((a) => a.kind)).toEqual(['initial', 'rewrite', 'rewrite']);
    // every prompt names the specific failure
    for (const r of provider.requests) {
      expect(r.prompt).toContain('MISSING_SOURCE_LINK');
      expect(r.purpose).toBe('rewrite');
    }
  });

  it('exhausts rounds and hands over to a human, with a bounded number of calls', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(BAD_NO_LINK))]);
    const result = await base(BAD_NO_LINK, provider, { maxRounds: 2 });
    expect(result.status).toBe('needs_human');
    expect(result.reason).toMatch(/exhausted/);
    expect(provider.requests).toHaveLength(2);
    expect(result.rounds).toBe(2);
    expect(result.text).toBe(BAD_NO_LINK);
  });

  it('maxRounds 0 never calls the provider', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(GOOD))]);
    const result = await base(BAD_NO_LINK, provider, { maxRounds: 0 });
    expect(result.status).toBe('needs_human');
    expect(provider.requests).toHaveLength(0);
  });

  it('treats an incomplete reply as a failed attempt, not as content', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(GOOD), false), reply(wrapReply(GOOD))]);
    const result = await base(BAD_NO_LINK, provider);
    expect(result.status).toBe('approved');
    expect(result.attempts[1]).toMatchObject({ kind: 'rewrite', failure: 'incomplete_reply', report: null, adopted: false, text: '' });
    expect(provider.requests[1]!.prompt).toContain('cut off');
  });

  it('treats a parse failure as a failed attempt', async () => {
    const provider = new FakeLlmProvider([reply('Sure! Here is a post without the markers.'), reply(wrapReply(GOOD))]);
    const result = await base(BAD_NO_LINK, provider);
    expect(result.status).toBe('approved');
    expect(result.attempts[1]!.failure).toMatch(/parse_failure/);
    expect(result.attempts[1]!.adopted).toBe(false);
  });

  it('counts only failed attempts when every reply is unusable', async () => {
    const provider = new FakeLlmProvider([reply('garbage'), reply('more garbage', false), reply('')]);
    const result = await base(BAD_NO_LINK, provider);
    expect(result.status).toBe('needs_human');
    expect(result.attempts.filter((a) => a.failure).length).toBe(3);
    expect(result.text).toBe(BAD_NO_LINK);
  });

  it('stops immediately with needs_human when the budget is exhausted', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(BAD_NO_LINK))]);
    const budget = new Budget('rewrite rounds', 1);
    const result = await base(BAD_NO_LINK, provider, { budget, maxRounds: 5 });
    expect(result.status).toBe('needs_human');
    expect(result.reason).toMatch(/budget_exceeded/);
    expect(provider.requests).toHaveLength(1);
  });

  it('stops when the provider itself throws BudgetExceededError', async () => {
    const provider = new FakeLlmProvider([new BudgetExceededError('chatgpt calls', 3)]);
    const result = await base(BAD_NO_LINK, provider);
    expect(result.status).toBe('needs_human');
    expect(result.reason).toMatch(/budget_exceeded/);
  });

  it('stops when shutdown begins mid-loop', async () => {
    const shutdown = new ShutdownController();
    const provider = new FakeLlmProvider([
      () => {
        void shutdown.shutdown(10);
        return reply(wrapReply(BAD_NO_LINK));
      },
    ]);
    const result = await base(BAD_NO_LINK, provider, { shutdown, maxRounds: 5 });
    expect(result.status).toBe('needs_human');
    expect(result.reason).toMatch(/shutdown/);
    expect(provider.requests).toHaveLength(1);
  });

  it('stops when the provider throws ShutdownError', async () => {
    const provider = new FakeLlmProvider([new ShutdownError()]);
    const result = await base(BAD_NO_LINK, provider);
    expect(result.status).toBe('needs_human');
    expect(result.reason).toMatch(/shutdown/);
  });

  it('stops with needs_human when the initial generation hits the budget', async () => {
    const result = await runRewriteLoop({
      initial: async () => {
        throw new BudgetExceededError('chatgpt calls', 1);
      },
      provider: new FakeLlmProvider([]),
      validate: (t) => validate(t),
      facts: [],
      platform: 'x',
      config,
      maxRounds: 2,
    });
    expect(result.status).toBe('needs_human');
    expect(result.text).toBeNull();
    expect(result.attempts).toEqual([]);
  });

  it('rejects a rewrite that introduces a competitor and keeps the clean text', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(BAD_COMPETITOR)), reply(wrapReply(GOOD))]);
    const result = await base(BAD_NO_LINK, provider);
    expect(result.status).toBe('approved');
    expect(result.attempts[1]).toMatchObject({ kind: 'rewrite', adopted: false });
    expect(result.attempts[1]!.failure).toMatch(/COMPETITOR_MENTION/);
    expect(result.text).toBe(GOOD);
    // the retry prompt carries the regression but never names the competitor
    expect(provider.requests[1]!.prompt).toContain('COMPETITOR_MENTION');
    expect(provider.requests[1]!.prompt).toContain('discarded');
    expect(provider.requests[1]!.prompt).not.toMatch(/imarc/i);
  });

  it('never ends approved or with a competitor in the working text when the model keeps adding one', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(BAD_COMPETITOR))]);
    const result = await base(BAD_NO_LINK, provider, { maxRounds: 2 });
    expect(result.status).toBe('needs_human');
    expect(result.text).toBe(BAD_NO_LINK);
    expect(result.text).not.toMatch(/imarc/i);
  });

  it('runs deterministic fixers on rewrite output too', async () => {
    const dashedRewrite = `Ken Research finds growth — fast. ${BASE_URL} #Widgets`;
    const provider = new FakeLlmProvider([reply(wrapReply(dashedRewrite))]);
    const result = await base(BAD_NO_LINK, provider);
    expect(result.status).toBe('approved');
    expect(result.attempts.map((a) => a.kind)).toEqual(['initial', 'rewrite', 'fixer']);
    expect(result.attempts[2]!.adopted).toBe(true);
    expect(result.text).not.toContain('—');
  });

  it('hands to a human without any LLM call for a human-only code', async () => {
    const provider = new FakeLlmProvider([reply(wrapReply(GOOD))]);
    const result = await base(GOOD, provider, {
      validate: () => ({
        draftId: 'd',
        passed: false,
        checkedAt: new Date().toISOString(),
        issues: [{ code: 'CONFLICTING_FACT', severity: 'hard_fail', message: 'conflict' }],
      }),
    });
    expect(result.status).toBe('needs_human');
    expect(result.reason).toMatch(/CONFLICTING_FACT/);
    expect(provider.requests).toHaveLength(0);
  });
});
