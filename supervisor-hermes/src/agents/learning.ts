import type { PlanResult } from '../../../src/pipeline/run-plan.js';
import { loadTechniques } from '../../../src/repos/techniques.js';
import { recordLearning } from '../../../src/social/learning.js';
import type { AgentReport, RowStatus, SocialPlatform } from '../types.js';
import type { AgentDeps } from './deps.js';
import type { ValidatorOutput } from './validator.js';

export async function runLearningAgent(
  input: { runId: string; platform: SocialPlatform; keyword: string; validator: ValidatorOutput; status: RowStatus; reason: string },
  deps: AgentDeps,
): Promise<AgentReport<{ newLessons: string[]; hermesMemory: string }>> {
  // recordLearning only reads runId, status, reason, rewrite.attempts and draft.text from the result.
  const result = {
    runId: input.runId,
    status: input.status,
    reason: input.reason,
    rewrite: { attempts: input.validator.attempts },
    draft: input.validator.text ? { text: input.validator.text } : null,
  } as unknown as PlanResult;
  const used = [...(deps.hermes?.usedLessonIds ?? [])];
  const learning = await recordLearning(
    deps.store,
    result,
    input.platform,
    input.keyword,
    loadTechniques(input.platform).files,
    used,
    deps.hermes?.calls ?? 0,
    deps.hermes?.tokens ?? null,
  );

  let hermesMemory = 'not applicable';
  if (deps.hermes && learning.newLessons.length > 0) {
    try {
      deps.limits.calls.consume();
      hermesMemory = await deps.hermes.rememberLesson(learning.newLessons[0]!);
    } catch (error) {
      hermesMemory = `pending: ${(error as Error).message}`;
    }
  }
  return {
    agent: 'learning',
    output: { newLessons: learning.newLessons.map((l) => l.id), hermesMemory },
    summary: `Saved the repair trace. ${learning.newLessons.length} new lesson(s). Hermes memory: ${hermesMemory}.`,
    concerns: [],
  };
}
