/**
 * dashboard/config.ts — this automation's registration metadata for the
 * Automation Intelligence Dashboard (see docs/team-github-onboarding.md).
 *
 * The onboarding doc describes an `automation.yml` manifest read by a Python
 * SDK — this project has no YAML parser dependency and isn't Python, so this
 * plain typed object is the source of truth instead. Same information, same
 * REST payload shape, no new dependency. We call the dashboard's REST API
 * directly (confirmed live against GET /api/schema/) rather than installing
 * the Python SDK, since this project is TypeScript/Node.
 *
 * automation_id is SOCIAL-POSTING-001 — confirmed 2026-09-29 with the
 * dashboard owner as the correct id for this repo (SOCIAL-VPS-001 is a
 * separate, never-built Python/SSH automation and does not apply here).
 *
 * Field values are constrained by the dashboard's own OpenAPI schema:
 *   category:   INTERLINKING | VIDEO | MUSIC_METADATA | SOCIAL_DISTRIBUTION | BENCHMARKING | SEO | OTHER
 *   technology: PYTHON | N8N | PLAYWRIGHT | NEXTJS | DJANGO | OTHER
 *   environment: DEVELOPMENT | PRODUCTION
 *   schedule:   HOURLY | DAILY | WEEKLY | MANUAL
 */
export const AUTOMATION_CONFIG = {
  automationId: 'SOCIAL-POSTING-001',
  name: 'Ken Research Content Distribution Agent',
  description: 'Multi-platform content generation and distribution (blog articles + social posts) across 12+ platforms via Playwright-driven browser automation.',
  category: 'SOCIAL_DISTRIBUTION',
  technology: 'PLAYWRIGHT',
  // Matches what the dashboard owner set at registration — bump to
  // PRODUCTION/DAILY once implementation_status is confirmed IMPLEMENTED
  // and this actually runs unattended on a schedule, not just manual tests.
  environment: 'DEVELOPMENT',
  schedule: 'MANUAL',
} as const;
