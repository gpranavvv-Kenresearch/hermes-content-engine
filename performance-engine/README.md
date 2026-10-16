# Performance Engine

Implemented 16 October 2026: tracking, learning, research, experiment controls, reporting and supervisor feedback. The default tracker visits published public URLs without a login or API key. A platform can still hide metrics or place a page behind login; those fields remain unknown. No recurring task or live strategy change has been activated.

This is a sibling of `supervisor-hermes`, inside the same Hermes Content Engine project. It will follow published posts, measure their performance and return evidence-backed strategy feedback to the generator.

Read [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the architecture, Sheet schema, rollout and implementation checklist.

Read [OPERATIONS.md](OPERATIONS.md) for setup, commands, import formats, recovery and limits; [REPO_RESEARCH.md](REPO_RESEARCH.md) for inspected GitHub repositories; and [TEST_REPORT.md](TEST_REPORT.md) for actual verification results.

The engine will have three agents:

- **Tracker:** collect publicly visible metrics at 7 and 14 days after publication; optional official APIs or dated exports can add private analytics.
- **Learner:** identify repeatable performance patterns and manage replacement experiments; research is a module within this agent.
- **Reporter:** explain performance, missing data, strategy changes and experiment results.

All user-facing tracking, learning, research, experiment and reporting records will be written to the existing **`Algo Reports`** tab in the same Google spreadsheet. `Social Media` remains the source for published-post URLs. Existing report rows and columns are preserved; see the plan for the shared-tab record layout.

GPT/Hermes continues writing posts and rewrites. `performance:auto-loop` replaces the latest evidence-linked platform guidance after Hermes analysis; Supervisor Hermes reads that bounded guidance automatically on the next generation. Replacement versions are retained for recovery, while the active prompt slot is replaced rather than appended. Ollama is optional for tagging and summarizing; it does not invent metrics, decide numeric scores or publish strategy changes by itself.

The existing supervisor learning agent records generation repairs. This new engine learns from published-post outcomes; those two histories remain separate.
