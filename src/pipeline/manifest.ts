import type { PlatformId } from '../schemas/index.js';

/**
 * The run plan. Every run is accountable for every step below: after the run, each one is reported as
 * ran, skipped (with the reason) or failed. A step nobody touched is reported as "not executed", so
 * nothing can drop out silently, which was the defect in the first version of `generate`.
 */

export type StepId =
  | 'preflight'
  | 'evidence'
  | 'supplementary-evidence'
  | 'style-library'
  | 'techniques'
  | 'planning-signals'
  | 'fresh-data'
  | 'persona-angle-variant'
  | 'research-brief'
  | 'outline'
  | 'draft'
  | 'editorial'
  | 'validate-rewrite'
  | 'content-sanity'
  | 'variant-check'
  | 'scoring'
  | 'finalize';

export type StepStatus = 'ran' | 'skipped' | 'failed';

export interface StepSpec {
  id: StepId;
  title: string;
}

/** The plan, in execution order. */
export const PLAN: readonly StepSpec[] = [
  { id: 'preflight', title: 'Preflight: config, safety flags, text providers' },
  { id: 'evidence', title: 'Evidence: verified facts and source notes from the report page' },
  { id: 'supplementary-evidence', title: 'Supplementary evidence: related Ken Research / government pages and neutral background (only when the report has no verified figure)' },
  { id: 'style-library', title: 'Style library: curated leader/house posts (style only)' },
  { id: 'techniques', title: 'Techniques: writing rules adopted from reviewed repos' },
  { id: 'planning-signals', title: 'Planning signals: government feeds' },
  { id: 'fresh-data', title: 'Fresh data: recent government items and market trends' },
  { id: 'persona-angle-variant', title: 'Persona, angle, hook and tone for this post' },
  { id: 'research-brief', title: 'Stage 1 (LLM): research brief' },
  { id: 'outline', title: 'Stage 2 (LLM): outline' },
  { id: 'draft', title: 'Stage 3 (LLM): draft' },
  { id: 'editorial', title: 'Stage 4 (LLM): editorial pass for natural, authoritative tone' },
  { id: 'validate-rewrite', title: 'Fixers, validation and bounded rewrite loop' },
  { id: 'content-sanity', title: 'Content sanity: figures, attribution, repetition, grounding, readability' },
  { id: 'variant-check', title: 'Variant check: not a near-copy of earlier posts for this report' },
  { id: 'scoring', title: 'Content readiness score (reported, not a ranking prediction)' },
  { id: 'finalize', title: 'Finalize: bold, spacing, save draft and run record' },
];

/** Steps whose absence is acceptable in a normal run (they need inputs a person supplies). Strict mode makes them mandatory. */
const OPTIONAL: ReadonlySet<StepId> = new Set(['supplementary-evidence', 'style-library', 'techniques', 'planning-signals', 'fresh-data']);

export interface StepRecord {
  id: StepId;
  title: string;
  /** Required steps must run for the run to be accepted; optional ones are only enforced in strict mode. */
  required: boolean;
  status: StepStatus;
  reason?: string;
  /** True when the step is skipped on purpose for this platform (for example outline on X). Never a problem. */
  byDesign?: boolean;
  detail?: Record<string, unknown>;
  ms: number;
}

export class RunManifest {
  private readonly records = new Map<StepId, StepRecord>();

  constructor(readonly platform: PlatformId) {}

  private spec(id: StepId): StepSpec {
    return PLAN.find((s) => s.id === id)!;
  }

  private base(id: StepId, status: StepStatus, ms: number): StepRecord {
    return { id, title: this.spec(id).title, required: !OPTIONAL.has(id), status, ms };
  }

  /** Runs a step and records it. A throw is recorded as failed and re-thrown. */
  async run<T>(id: StepId, fn: () => Promise<T> | T, detailOf?: (result: T) => Record<string, unknown>): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      const rec = this.base(id, 'ran', Date.now() - started);
      if (detailOf) rec.detail = detailOf(result);
      this.records.set(id, rec);
      return result;
    } catch (e) {
      const rec = this.base(id, 'failed', Date.now() - started);
      rec.reason = (e as Error).message;
      this.records.set(id, rec);
      throw e;
    }
  }

  /** Records a step as ran, for work done inline. */
  ran(id: StepId, detail?: Record<string, unknown>, ms = 0): void {
    const rec = this.base(id, 'ran', ms);
    if (detail) rec.detail = detail;
    this.records.set(id, rec);
  }

  skip(id: StepId, reason: string, options: { byDesign?: boolean; detail?: Record<string, unknown> } = {}): void {
    const rec = this.base(id, 'skipped', 0);
    rec.reason = reason;
    if (options.byDesign) rec.byDesign = true;
    if (options.detail) rec.detail = options.detail;
    this.records.set(id, rec);
  }

  fail(id: StepId, reason: string, detail?: Record<string, unknown>): void {
    const rec = this.base(id, 'failed', 0);
    rec.reason = reason;
    if (detail) rec.detail = detail;
    this.records.set(id, rec);
  }

  /** Adds detail to a step that has already been recorded. */
  annotate(id: StepId, detail: Record<string, unknown>): void {
    const rec = this.records.get(id);
    if (rec) rec.detail = { ...rec.detail, ...detail };
  }

  has(id: StepId): boolean {
    return this.records.has(id);
  }

  status(id: StepId): StepStatus | undefined {
    return this.records.get(id)?.status;
  }

  /**
   * Every step of the plan, in order. A step nobody recorded is returned as skipped with
   * `notReached`, so the report always has exactly one line per planned step.
   */
  steps(notReached = 'not executed'): StepRecord[] {
    return PLAN.map((s) => this.records.get(s.id) ?? { ...this.base(s.id, 'skipped', 0), reason: notReached });
  }

  /**
   * Steps that stop the run from being accepted. Always: required steps that did not run (unless skipped
   * by design). In strict mode: any step that did not run (unless by design).
   */
  problems(strict: boolean, notReached = 'not executed'): StepRecord[] {
    return this.steps(notReached).filter((r) => r.status !== 'ran' && !r.byDesign && (strict || r.required));
  }
}

/** One line per step, for the console. */
export function formatManifest(steps: readonly StepRecord[]): string {
  const mark = (s: StepRecord): string => (s.status === 'ran' ? 'RAN    ' : s.status === 'failed' ? 'FAILED ' : s.byDesign ? 'n/a    ' : 'SKIPPED');
  return steps
    .map((s, i) => {
      const detail = s.detail ? ` ${compactDetail(s.detail)}` : '';
      const reason = s.reason ? `  <- ${s.reason}` : '';
      return `${String(i + 1).padStart(2)}. ${mark(s)} ${s.title}${detail}${reason}`;
    })
    .join('\n');
}

function compactDetail(d: Record<string, unknown>): string {
  const parts = Object.entries(d).map(([k, v]) => {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}=${text && text.length > 70 ? `${text.slice(0, 67)}...` : text}`;
  });
  return `[${parts.join(', ')}]`;
}
