import { readFileSync } from 'node:fs';
import { Budget } from '../../../src/safety/budget.js';
import { extractJson } from '../../../supervisor-hermes/src/supervisor.js';
import { createHermesAsk } from '../../../supervisor-hermes/src/hermes-client.js';
import { BlogDecisionSchema, HermesUnavailableError, type BlogAction, type BlogDecision, type BlogGate } from './types.js';

export type HermesAsk = (prompt: string, purpose: string) => Promise<string>;

export interface BlogLimitOptions {
  maxHermesCalls?: number;
  maxRevisions?: number;
  maxRegenerations?: number;
  maxStructureChanges?: number;
}

/** Hard caps for ONE row, so a bad article can never loop forever. */
export class BlogLimits {
  readonly calls: Budget;
  revisions = 0;
  regenerations = 0;
  structureChanges = 0;
  private readonly o: Required<BlogLimitOptions>;

  constructor(options: BlogLimitOptions = {}) {
    this.o = { maxHermesCalls: 24, maxRevisions: 3, maxRegenerations: 1, maxStructureChanges: 1, ...options };
    this.calls = new Budget('hermes-calls', this.o.maxHermesCalls);
  }
  get revisionsLeft(): number { return this.o.maxRevisions - this.revisions; }
  get regenerationsLeft(): number { return this.o.maxRegenerations - this.regenerations; }
  get structureChangesLeft(): number { return this.o.maxStructureChanges - this.structureChanges; }
  note(): string {
    return `fix requests in the same chat left: ${this.revisionsLeft}; fresh restarts left: ${this.regenerationsLeft}; structure changes left: ${this.structureChangesLeft}; Hermes calls left: ${this.calls.remaining}`;
  }
}

export interface BlogDecideInput {
  gate: BlogGate;
  /** What the supervisor must read at this gate. */
  material: string;
  history: readonly BlogDecision[];
  limitsNote: string;
}

export interface BlogDecideResult {
  decision: BlogDecision;
  failedClosed: boolean;
}

export function buildBlogSupervisorPrompt(role: string, input: BlogDecideInput): string {
  const history = input.history.map((d) =>
    [`- ${d.gate}: ${d.action} (${d.reason})`, d.instructions ? `  Corrections asked: ${d.instructions}` : ''].filter(Boolean).join('\n'));
  return [
    role.trim(),
    `\n## GATE\n${input.gate}`,
    `\n## LIMITS\n${input.limitsNote}`,
    `\n## EARLIER DECISIONS FOR THIS ROW\n${history.length ? history.join('\n') : 'none'}`,
    `\n## MATERIAL FOR THIS GATE\n${input.material}`,
    `\nAnswer with the JSON object for gate "${input.gate}" only.`,
  ].join('\n');
}

export function loadBlogRole(): string {
  return readFileSync(new URL('../roles/supervisor.md', import.meta.url), 'utf8');
}

export function createBlogHermesAsk(signal?: AbortSignal): HermesAsk {
  // Reviewing a full article takes longer than the social-post gates, so the timeout is higher.
  return createHermesAsk({ timeoutMs: 360_000, ...(signal ? { signal } : {}) });
}

export class BlogSupervisor {
  constructor(
    private readonly ask: HermesAsk,
    private readonly role: string,
    private readonly limits: BlogLimits,
  ) {}

  /**
   * An unreachable Hermes is an infrastructure problem, not a verdict on the article: it throws
   * HermesUnavailableError so the runner can wait and retry the same row. A reply that is not valid JSON is asked
   * for once more; if it is still invalid the gate fails closed (stop).
   */
  async decide(input: BlogDecideInput): Promise<BlogDecideResult> {
    const prompt = buildBlogSupervisorPrompt(this.role, input);
    let lastProblem = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      this.limits.calls.consume();
      let raw: string;
      try {
        raw = await this.ask(prompt, `blog-supervisor-${input.gate}`);
      } catch (error) {
        throw new HermesUnavailableError((error as Error).message);
      }
      try {
        const parsed = BlogDecisionSchema.parse(extractJson(raw));
        if (parsed.gate !== input.gate) {
          lastProblem = `answered for gate "${parsed.gate}" instead of "${input.gate}"`;
          continue;
        }
        return { decision: parsed, failedClosed: false };
      } catch (error) {
        lastProblem = (error as Error).message;
      }
    }
    const stop: BlogAction = 'stop';
    return {
      decision: { gate: input.gate, action: stop, reason: `supervisor reply invalid twice: ${lastProblem}`.slice(0, 800), concerns: [] },
      failedClosed: true,
    };
  }
}
