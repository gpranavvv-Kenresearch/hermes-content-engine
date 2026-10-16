import type { Store } from '../store/store.js';
import type { PlanResult } from '../pipeline/run-plan.js';
import type { PlatformId } from '../schemas/index.js';
import { shortHash } from '../utils/hash.js';

export interface RepairLesson {
  id: string;
  platform: PlatformId;
  failureCode: string;
  procedure: string;
  status: 'candidate' | 'active' | 'retired';
  successfulRuns: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RepairTrace {
  runId: string;
  platform: PlatformId;
  status: string;
  reason: string;
  keyword: string;
  methodFiles: string[];
  usedLessons: string[];
  modelCalls: number;
  modelTokens: number | null;
  attempts: Array<{ index: number; kind: string; round: number; failedCodes: string[]; action: string; adopted: boolean; outcome: string }>;
  finalTextHash: string | null;
  at: string;
}

const COLLECTION = 'social-repair-lessons';
const TRACE_COLLECTION = 'social-repair-traces';

export function procedureFor(code: string): string {
  switch (code) {
    case 'REQUIRED_KEYWORD_MISSING': return 'Place the approved primary keyword naturally in a substantive sentence; do not count a hashtag or URL. Preserve the meaning and revalidate.';
    case 'THIN_CONTENT': return 'Develop the source-backed finding, scope, and reader implication in separate useful sentences. Add no figures or unsupported claims.';
    case 'MISATTRIBUTED_NOTE': return 'Attribute every background note to its real source, or remove it. Do not present an outside observation as Ken Research evidence.';
    case 'UNSUPPORTED_NARRATIVE_CLAIM': return 'Replace the unsupported claim with a precise source-backed statement or remove it; inspect surrounding implications too.';
    case 'SOURCE_SCOPE_MISSING': return 'Add the verified geography, period and market scope next to the relevant claim; preserve the actual source attribution.';
    case 'UNGROUNDED_SENTENCE': return 'Remove or narrowly restate the unsupported implication; each substantive sentence must be directly supported by a supplied fact or source note.';
    default: return `Repair ${code} using only the provided evidence, then run every validation check again before accepting the draft.`;
  }
}

export async function loadLessons(store: Store, platform: PlatformId): Promise<RepairLesson[]> {
  return (await store.list<RepairLesson>(COLLECTION)).map((row) => row.value).filter((lesson) => lesson.platform === platform && lesson.status !== 'retired');
}

/** Recent outcomes are cautionary context, never evidence or a promoted repair procedure. */
export async function loadRecentRepairTraces(store: Store, platform: PlatformId, limit = 3): Promise<RepairTrace[]> {
  return (await store.list<RepairTrace>(TRACE_COLLECTION))
    .map((row) => row.value)
    .filter((trace) => trace.platform === platform)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-limit);
}

export async function recordLearning(
  store: Store,
  result: PlanResult,
  platform: PlatformId,
  keyword: string,
  methodFiles: string[],
  usedLessonIds: string[],
  modelCalls: number,
  modelTokens: number | null,
): Promise<{ trace: RepairTrace; newLessons: RepairLesson[] }> {
  const attempts = result.rewrite?.attempts ?? [];
  const trace: RepairTrace = {
    runId: result.runId,
    platform,
    status: result.status,
    reason: result.reason,
    keyword,
    methodFiles,
    usedLessons: usedLessonIds,
    modelCalls,
    modelTokens,
    attempts: attempts.map((attempt) => ({
      index: attempt.index,
      kind: attempt.kind,
      round: attempt.round,
      failedCodes: attempt.report?.issues.filter((issue) => issue.severity === 'hard_fail').map((issue) => issue.code) ?? [],
      action: attempt.kind === 'fixer' ? `deterministic: ${(attempt.fixes ?? []).join(', ')}` : attempt.kind === 'rewrite' ? 'targeted model rewrite of listed failures' : 'initial generation',
      adopted: attempt.adopted,
      outcome: attempt.failure ?? (attempt.report?.passed ? 'passed' : 'failed validation'),
    })),
    finalTextHash: result.draft?.text ? shortHash(result.draft.text, 16) : null,
    at: new Date().toISOString(),
  };
  await store.put(TRACE_COLLECTION, result.runId, trace);

  const successfulRepair = result.status === 'approved' && attempts.some((attempt) => attempt.kind === 'rewrite' && attempt.adopted);
  const failedCodes = [...new Set(attempts.flatMap((attempt) => attempt.report?.issues.filter((issue) => issue.severity === 'hard_fail').map((issue) => issue.code) ?? []))];
  const promoted: RepairLesson[] = [];
  if (successfulRepair) {
    for (const code of failedCodes) {
      const id = `lesson_${shortHash(`${trace.platform}:${code}`, 16)}`;
      const prior = await store.get<RepairLesson>(COLLECTION, id);
      const successfulRuns = [...new Set([...(prior?.successfulRuns ?? []), result.runId])];
      const lesson: RepairLesson = {
        id,
        platform: trace.platform,
        failureCode: code,
        procedure: prior?.procedure ?? procedureFor(code),
        status: successfulRuns.length >= 2 && usedLessonIds.includes(id) ? 'active' : prior?.status === 'active' ? 'active' : 'candidate',
        successfulRuns,
        createdAt: prior?.createdAt ?? trace.at,
        updatedAt: trace.at,
      };
      await store.put(COLLECTION, id, lesson);
      if (!prior) promoted.push(lesson);
    }
  }
  return { trace, newLessons: promoted };
}
