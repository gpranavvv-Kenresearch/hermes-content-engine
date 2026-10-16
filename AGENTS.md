# Content format approvals

- LinkedIn and Facebook use the same approved format pool. Never maintain separate format pools for them.
- The user approved all ten formats on 15 October 2026: insight-led (`insight-brief`), short narrative (`short-narrative`), decision-led (`evidence-to-decision`), country comparison (`country-contrast`), one-stat spotlight (`stat-spotlight`), baseline to forecast (`forecast-timeline`), two-lens comparison (`two-lens-comparison`), source-quote analysis (`source-quote-analysis`), evaluation checklist (`evaluation-checklist`), and market watchlist (`market-watchlist`).
- These ten formats are frozen. Show samples and obtain the user's explicit approval before adding formats or changing their structure. Research or a proposal alone is not approval.
- Keep prompts concise. Inject only the selected format. Keep complete source evidence separately.
- Use one central idea, distinct supported insights, a neutral report link and one discussion question. Do not invent country detail.
- Every `Ken Research` mention must be bold on LinkedIn and Facebook. The formatter preserves required brand emphasis separately from the one optional short figure emphasis; do not make brand bold optional when reducing excessive formatting.
- X is plain text: no mandatory brand or figure bold. Strip accidental Markdown and Unicode bold; never reject or retry X for missing bold. Keep the brand mention and the total character limit.
- Attribute a Ken Research finding in the substantive body, preferably the first evidence sentence. A hashtag or report-link label alone does not satisfy the brand mention. Closing questions on LI/FB should invite a specific practical experience, obstacle, evidence threshold or first check; vary the invitation instead of repeating "Which matters most?" option menus. Keep one question after the link.

# graphify

- **graphify** (`~/.Codex/skills/graphify/SKILL.md`) - any input to knowledge graph. Trigger: `/graphify`.
- When the user types `/graphify`, invoke the Skill tool with `skill: "graphify"` before doing anything else.
