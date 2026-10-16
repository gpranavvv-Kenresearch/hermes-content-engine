import { describe, expect, it } from 'vitest';
import { EngineError } from '../../src/errors.js';
import { ChainProvider } from '../../src/llm/chain-provider.js';
import { FakeLlmProvider, reply } from '../fixtures/validation/helpers.js';

const timeout = () => new EngineError('ollama: generation timed out', 'retryable', 'OLLAMA_TIMEOUT');
const request = { prompt: 'p', purpose: 'draft' } as never;

describe('chain cooldown: "Ollama first" costs one timeout, not one per stage', () => {
  it('skips a provider that just timed out and tries it again after the cooldown', async () => {
    let clock = 1_000_000;
    const first = new FakeLlmProvider([timeout(), reply('local answer')]);
    const second = new FakeLlmProvider([reply('api answer')]);
    const chain = new ChainProvider({ providers: [{ id: 'ollama', generate: (r) => first.generate(r) }, { id: 'groq', generate: (r) => second.generate(r) }], now: () => clock, cooldownMs: 600_000 });

    expect((await chain.generate(request)).text).toBe('api answer'); // ollama timed out, groq answered
    expect(first.requests).toHaveLength(1);

    clock += 60_000; // one minute later: still cooling down, ollama is not even called
    expect((await chain.generate(request)).text).toBe('api answer');
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toHaveLength(2);

    clock += 600_000; // cooldown over: ollama goes first again
    expect((await chain.generate(request)).text).toBe('local answer');
    expect(first.requests).toHaveLength(2);
  });

  it('does not put a provider on cooldown for other errors', async () => {
    const first = new FakeLlmProvider([new EngineError('bad reply', 'retryable', 'OTHER'), reply('fine')]);
    const second = new FakeLlmProvider([reply('api answer')]);
    const chain = new ChainProvider({ providers: [{ id: 'ollama', generate: (r) => first.generate(r) }, { id: 'groq', generate: (r) => second.generate(r) }] });
    expect((await chain.generate(request)).text).toBe('api answer');
    expect((await chain.generate(request)).text).toBe('fine'); // tried again straight away
  });

  it('lists the cooling provider in the error when every provider fails', async () => {
    const first = new FakeLlmProvider([timeout()]);
    const second = new FakeLlmProvider([new EngineError('x', 'retryable', 'HTTP_ERROR')]);
    const chain = new ChainProvider({ providers: [{ id: 'ollama', generate: (r) => first.generate(r) }, { id: 'groq', generate: (r) => second.generate(r) }] });
    await expect(chain.generate(request)).rejects.toThrow(/ollama=OLLAMA_TIMEOUT.*groq=HTTP_ERROR/);
    await expect(chain.generate(request)).rejects.toThrow(/ollama=COOLING_DOWN/);
  });
});
