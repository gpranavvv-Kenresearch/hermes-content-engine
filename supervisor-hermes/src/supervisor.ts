import type { RunLimits } from './limits.js';
import { DecisionSchema, type AgentReport, type Decision, type Gate } from './types.js';

export type HermesAsk = (prompt: string, purpose: string) => Promise<string>;

export interface DecideInput {
  gate: Gate;
  reports: readonly AgentReport<unknown>[];
  /** The text the supervisor must read at this gate (evidence statements, draft text, validator report). */
  material: string;
  history: readonly Decision[];
  limitsNote: string;
}

export interface SupervisorResult {
  decision: Decision;
  failedClosed: boolean;
}

/** First balanced {...} object in a reply, tolerant of prose and code fences. */
export function extractJson(raw: string): unknown {
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('no JSON object in reply');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(raw.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object in reply');
}

export function buildSupervisorPrompt(role: string, input: DecideInput): string {
  const reports = input.reports.map((r) => `- ${r.agent}: ${r.summary}${r.concerns.length ? ` | concerns: ${r.concerns.join('; ')}` : ''}`);
  const history = input.history.map((d) => [
    `- ${d.gate}: ${d.action} (${d.reason})`,
    d.instructions ? `  Required corrections: ${d.instructions}` : '',
    d.concerns.length ? `  Checklist findings: ${d.concerns.join('; ')}` : '',
  ].filter(Boolean).join('\n'));
  return [
    role.trim(),
    `\n## GATE\n${input.gate}`,
    `\n## LIMITS\n${input.limitsNote}`,
    `\n## EARLIER DECISIONS IN THIS RUN\n${history.length ? history.join('\n') : 'none'}`,
    `\n## AGENT REPORTS\n${reports.length ? reports.join('\n') : 'none'}`,
    `\n## MATERIAL FOR THIS GATE\n${input.material}`,
    `\nAnswer with the JSON object for gate "${input.gate}" only.`,
  ].join('\n');
}

export class Supervisor {
  constructor(
    private readonly ask: HermesAsk,
    private readonly role: string,
    private readonly limits: RunLimits,
  ) {}

  async decide(input: DecideInput): Promise<SupervisorResult> {
    const closed = (why: string): SupervisorResult => ({
      decision: { gate: input.gate, action: 'stop', reason: `supervisor unavailable or invalid: ${why}`.slice(0, 600), concerns: [] },
      failedClosed: true,
    });
    try {
      this.limits.calls.consume();
      const raw = await this.ask(buildSupervisorPrompt(this.role, input), `supervisor-${input.gate}`);
      const parsed = DecisionSchema.parse(extractJson(raw));
      if (parsed.gate !== input.gate) return closed(`answered for gate "${parsed.gate}" instead of "${input.gate}"`);
      return { decision: parsed, failedClosed: false };
    } catch (error) {
      return closed((error as Error).message);
    }
  }
}
