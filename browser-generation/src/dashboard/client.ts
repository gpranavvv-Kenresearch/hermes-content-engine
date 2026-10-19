/**
 * dashboard/client.ts — reports this automation's runs to the Automation
 * Intelligence Dashboard (see docs/team-github-onboarding.md) via its REST
 * API directly (confirmed live 2026-09-29 against GET /api/schema/ — a
 * plain Django REST Framework API, not Python-specific; the doc's "4 lines
 * of Python" SDK is just a convenience wrapper around these same endpoints).
 *
 * Auth: `Authorization: Token <AUTOMATION_DASHBOARD_TOKEN>` on every request.
 *
 * Every function here is best-effort and NEVER throws — per the onboarding
 * doc's own rule ("If the dashboard is unreachable, your automation still
 * runs normally"), a dead/misconfigured dashboard must never block or fail
 * the actual automation work.
 */

const BASE_URL = process.env.AUTOMATION_DASHBOARD_URL?.replace(/\/+$/, '');
const TOKEN = process.env.AUTOMATION_DASHBOARD_TOKEN;

type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'WARNING' | 'FAILED' | 'CANCELLED';
type ExecutionQuality = 'REAL_EXECUTION' | 'REAL_ANALYSIS_ONLY' | 'NO_EXECUTION';
type MetricValue = number | string | boolean;

let warnedMissingConfig = false;

interface ApiResult { ok: boolean; status: number; data: any; }

async function apiRequest(method: 'GET' | 'POST' | 'PATCH', path: string, body?: object): Promise<ApiResult> {
  if (!BASE_URL || !TOKEN) {
    if (!warnedMissingConfig) {
      console.warn('   [dashboard] AUTOMATION_DASHBOARD_URL / AUTOMATION_DASHBOARD_TOKEN not set — dashboard reporting disabled (automation itself is unaffected).');
      warnedMissingConfig = true;
    }
    return { ok: false, status: 0, data: null };
  }
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Authorization': `Token ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      console.warn(`   [dashboard] ${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err: any) {
    console.warn(`   [dashboard] request failed (non-fatal, automation continues): ${err.message}`);
    return { ok: false, status: 0, data: null };
  }
}

/**
 * Registers this automation's metadata — tries PATCH (update) first, since
 * in practice this runs after the automation already exists on the
 * dashboard; falls back to POST (create) on a 404 for the true first-ever
 * run. POST is NOT idempotent here (confirmed live 2026-09-29: it 400s with
 * "automation with this automation id already exists" on a second call),
 * so trying PATCH first avoids a noisy expected-failure warning on every
 * single batch. Safe to call on every process start; failures are logged
 * and swallowed.
 */
export async function registerAutomation(config: {
  automationId: string;
  name: string;
  category: string;
  technology: string;
  description?: string;
  environment?: string;
  schedule?: string;
}): Promise<void> {
  const payload = {
    automation_id: config.automationId,
    name: config.name,
    category: config.category,
    technology: config.technology,
    description: config.description,
    environment: config.environment,
    schedule: config.schedule,
  };
  const patchRes = await apiRequest('PATCH', `/api/automations/${config.automationId}/`, payload);
  if (!patchRes.ok && patchRes.status === 404) {
    await apiRequest('POST', '/api/automations/', payload);
  }
}

/**
 * Starts a run and returns its run_id (or null if the dashboard is
 * unreachable/unconfigured). Explicitly starts as NO_EXECUTION — leaving
 * execution_quality unset makes the server apply its own default, which is
 * REAL_EXECUTION and gets rejected the same way finishRun's gate rejects it
 * (confirmed live 2026-09-29) — finishRun upgrades it to the real value (or
 * falls back again) once the run's actual outcome is known.
 */
export async function startRun(automationId: string, opts: { workerId?: string; currentStage?: string } = {}): Promise<string | null> {
  const res = await apiRequest('POST', '/api/executions/', {
    automation: automationId,
    status: 'RUNNING' as RunStatus,
    execution_quality: 'NO_EXECUTION' as ExecutionQuality,
    started_at: new Date().toISOString(),
    worker_id: opts.workerId,
    current_stage: opts.currentStage,
  });
  return res.data?.run_id ?? null;
}

/** Updates progress on an in-flight run — optional, only useful for long batches. Never throws. */
export async function reportProgress(runId: string | null, opts: { percentage?: number; currentStage?: string }): Promise<void> {
  if (!runId) return;
  await apiRequest('PATCH', `/api/executions/${runId}/`, {
    progress_percentage: opts.percentage,
    current_stage: opts.currentStage,
    heartbeat_at: new Date().toISOString(),
  });
}

let warnedNotImplementedGate = false;

/**
 * Marks a run finished — SUCCESS/WARNING/FAILED plus whatever metrics this
 * run produced. If the automation is still flagged NOT_IMPLEMENTED on the
 * dashboard, the server rejects execution_quality: REAL_EXECUTION outright
 * (confirmed live 2026-09-29 — "cannot report REAL_EXECUTION... Allowed:
 * NO_EXECUTION", and that flag isn't settable via the API, only by whoever
 * reviews the automation on the dashboard side). Rather than losing the
 * report, retry once with NO_EXECUTION so the run — and its real metrics —
 * still land; the truthful REAL_EXECUTION will go through automatically
 * once the dashboard owner flips that flag after seeing genuine runs.
 */
export async function finishRun(runId: string | null, params: {
  status: RunStatus;
  metrics?: Record<string, MetricValue>;
  errorMessage?: string;
  executionQuality?: ExecutionQuality;
}): Promise<void> {
  if (!runId) return;
  const payload = {
    status: params.status,
    completed_at: new Date().toISOString(),
    metrics: params.metrics,
    error_message: params.errorMessage,
    execution_quality: params.executionQuality,
  };
  const res = await apiRequest('PATCH', `/api/executions/${runId}/`, payload);
  if (!res.ok && res.status === 400 && params.executionQuality && params.executionQuality !== 'NO_EXECUTION') {
    const msg = JSON.stringify(res.data || {});
    if (/NOT_IMPLEMENTED/i.test(msg)) {
      if (!warnedNotImplementedGate) {
        console.warn('   [dashboard] Automation still flagged NOT_IMPLEMENTED on the dashboard — reporting NO_EXECUTION instead of the real quality until that flag is lifted by the dashboard owner.');
        warnedNotImplementedGate = true;
      }
      await apiRequest('PATCH', `/api/executions/${runId}/`, { ...payload, execution_quality: 'NO_EXECUTION' as ExecutionQuality });
    }
  }
}
