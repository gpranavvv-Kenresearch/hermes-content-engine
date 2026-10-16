import { describe, expect, it } from 'vitest';
import { checkClaims } from '../../src/evidence/index.js';
import { MAX_OUTPUT_TOKENS, generateContent, type PipelineDeps } from '../../src/pipeline/index.js';
import { loadFlags } from '../../src/safety/flags.js';
import { MemoryStore } from '../../src/store/store.js';
import { FakeLlmProvider, config, reply, sampleFact, utmLink } from '../fixtures/validation/helpers.js';

const item = { id: 'item-1', title: 'Examplestan Widget Market', reportUrl: 'https://www.kenresearch.com/industry-reports/examplestan-widget-market' };
const input = { item, facts: [sampleFact], campaignId: 'authority-insights', platform: 'x' as const };
const goodX = `Ken Research finds the Examplestan widget market reached USD 4.2 billion in 2025, with buyers shifting toward premium segments. Full outlook: ${utmLink('x')} #Widgets #Examplestan`;
const competitorX = `According to IMARC Group, the Examplestan widget market reached USD 4.2 billion in 2025. Full outlook: ${utmLink('x')} #Widgets #Examplestan`;

function deps(provider: FakeLlmProvider, extra: Partial<PipelineDeps> = {}): PipelineDeps {
  return { config, provider, claimChecker: checkClaims, store: new MemoryStore(), flags: loadFlags({}), now: () => new Date('2026-10-13T10:00:00Z'), seed: 1, ...extra };
}

describe('text posts through an API/local provider', () => {
  it('refuses to generate a blog: blogs stay in the existing ChatGPT pipeline', async () => {
    const provider = new FakeLlmProvider([reply('x')]);
    await expect(generateContent({ ...input, platform: 'blog' }, deps(provider))).rejects.toMatchObject({ code: 'BLOG_GENERATION_OUT_OF_SCOPE', category: 'fatal' });
    expect(provider.requests).toHaveLength(0);
  });

  it('accepts a reply that ignored the output format when lenientOutput is on, and records that it was salvaged', async () => {
    const provider = new FakeLlmProvider([reply(`Sure! Here's the post:\n${goodX}`)]);
    const result = await generateContent(input, deps(provider, { lenientOutput: true }));
    expect(result.status).toBe('approved');
    expect(result.draft?.text).toBe(goodX);
    expect(result.stages[0]).toMatchObject({ stage: 'draft', provider: 'fake', parsed: true, salvaged: true });
  });

  it('is strict by default: the same reply ends as needs_human', async () => {
    const provider = new FakeLlmProvider([reply(goodX)]);
    const result = await generateContent(input, deps(provider));
    expect(result.status).toBe('needs_human');
    expect(result.reason).toMatch(/unparseable/);
  });

  it('still validates a salvaged reply: a competitor in plain text is rewritten, using the same lenient parsing', async () => {
    const provider = new FakeLlmProvider([reply(competitorX), reply(`Revised post:\n${goodX}`)]);
    const result = await generateContent(input, deps(provider, { lenientOutput: true }));
    expect(result.status).toBe('approved');
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.prompt).toContain('COMPETITOR_MENTION');
    expect(result.draft?.text).toBe(goodX);
  });

  it('passes the per-platform token cap to the provider on every call', async () => {
    const provider = new FakeLlmProvider([reply(competitorX), reply(goodX)]);
    await generateContent(input, deps(provider, { lenientOutput: true }));
    expect(provider.requests.map((r) => r.maxOutputTokens)).toEqual([MAX_OUTPUT_TOKENS.x, MAX_OUTPUT_TOKENS.x]);
    expect(MAX_OUTPUT_TOKENS.linkedin).toBe(1600);
  });

  it('does not accept a truncated reply even in lenient mode', async () => {
    const provider = new FakeLlmProvider([reply('<<<CE_OUTPUT>>>\nFACT_IDS: F1\n---TEXT---\nCut off mid')]);
    const result = await generateContent(input, deps(provider, { lenientOutput: true }));
    expect(result.status).toBe('needs_human');
    expect(result.draft).toBeNull();
  });
});
