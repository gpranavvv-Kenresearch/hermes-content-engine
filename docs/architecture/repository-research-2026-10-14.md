# GitHub research for Ken Research social text generation

Checked: 14 October 2026. This shortlist supports the [architecture plan](social-text-engine-plan-2026-10-14.md). Public GitHub API metadata supplied star counts, SPDX labels and default-branch commit snapshots. Primary repository files and official docs supplied capability evidence. Stars change and are a popularity signal, not evidence that a method improves Ken Research content. These are recommendations, not installed dependencies.

## Recommended shortlist

| Repository | Stars at inspection | License evidence | Role in this engine | Recommendation |
|---|---:|---|---|---|
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 253,627 | MIT | Procedural skills, session memory and a writing/repair runtime | Use for the requested repair-memory integration; keep TypeScript validation authoritative. |
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | 54,648 | MIT | Social writing, platform references and editing methods | Best starting method source for FB/LI text. |
| [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) | 29,608 | Apache-2.0, including inspected marketing LICENSE | Brand review and content creation guidance | Adapt selected marketing files into engine profiles. |
| [blader/humanizer](https://github.com/blader/humanizer) | 56,749 | MIT | Editorial patterns and preserving supported meaning during edits | Optional polish method, subordinate to brand samples and evidence rules. |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | 25,993 | MIT | Repeatable output comparisons and custom assertions | Optional development evaluation tool after the first pilot. |
| [textlint/textlint](https://github.com/textlint/textlint) | 3,201 | MIT | Local prose linting with custom rules | Optional; use current validators/Vale before adding another linter. |
| [social-media-skills/skills](https://github.com/social-media-skills/skills) | 149 | MIT | Focused social writing/search playbooks | Relevant exploratory source, but does not meet a high-star preference. |
| [NousResearch/hermes-agent-self-evolution](https://github.com/NousResearch/hermes-agent-self-evolution) | 5,503 | API SPDX unavailable; README describes mixed component licenses | Offline skill optimization | Defer: unnecessary complexity/cost for bounded draft repair. |

## What to inspect and adapt

### 1. Hermes

Official [memory docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory) describe compact persistent notes and session history; [skills docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) describe reusable procedures loaded when needed. The proposed engine bridge must provide failures, actions and verified outcomes explicitly. Hermes does not automatically observe arbitrary TypeScript retry files.

The [README](https://github.com/NousResearch/hermes-agent) documents native Windows support and optional WSL2. [Configuration docs](https://hermes-agent.nousresearch.com/docs/user-guide/configuration) document Codex OAuth among provider options. Validate the installed release's headless/auth behavior before wiring unattended generation. Hermes requires a working model route; its free license is separate from inference quotas and cost. Avoid enabling unrelated tools, background optimizers or multiple workers initially.

### 2. Marketing Skills

Read the actual [social skill](https://github.com/coreyhaines31/marketingskills/blob/main/skills/social/SKILL.md), its [platform references](https://github.com/coreyhaines31/marketingskills/blob/main/skills/social/references/platforms.md) and [copy-editing skill](https://github.com/coreyhaines31/marketingskills/blob/main/skills/copy-editing/SKILL.md).

Adapt audience/goal/brand context, distinct platform formats and editing checks for clarity, voice, relevance, evidence and specificity. Do not import promotional examples as market facts. Convert multi-pass advice into one compact review rubric; seven editing passes should not automatically become seven model calls. Exclude tactics requiring unsupported benefits, invented proof, manufactured urgency or engagement promises. Platform tactics remain configurable experiments.

These Markdown methods can be adapted into TypeScript configuration or Hermes procedures. They are not intrinsically tied to Claude execution.

### 3. Anthropic marketing files

Inspect [brand-review](https://github.com/anthropics/knowledge-work-plugins/blob/main/marketing/skills/brand-review/SKILL.md), [content-creation](https://github.com/anthropics/knowledge-work-plugins/blob/main/marketing/skills/content-creation/SKILL.md) and the [marketing license](https://github.com/anthropics/knowledge-work-plugins/blob/main/marketing/LICENSE).

Useful material includes voice/terminology review, approved messaging, supported claims and social-format guidance. Translate this into a versioned Ken profile with accepted and rejected examples. A plugin bundle is not necessary to use the writing methods; the intended integration uses selected reviewed material. Preserve required license/notice attribution for copied or adapted material.

### 4. Humanizer

Inspect [SKILL.md](https://github.com/blader/humanizer/blob/main/SKILL.md). Its editing procedure emphasizes preserving supported meaning, checking factual additions/removals and matching supplied writing samples. Adapt a small optional check for filler, repetition and inflated wording. Do not adopt its every punctuation preference as a Ken brand rule. It does not establish whether text was written by AI, nor validate factual accuracy or search performance.

### 5. Promptfoo

Inspect its [assertion documentation](https://github.com/promptfoo/promptfoo/blob/main/site/docs/configuration/expected-outputs/index.md). It supports custom JavaScript/TypeScript assertions and evaluation of recorded model outputs. Useful experiment: compare baseline versus selected method packs on identical evidence, keywords and rejected cases.

Recorded-output/local assertions can run without an inference API key. Generating new outputs or model-graded judgments still needs a provider. Start with existing Vitest fixtures; add Promptfoo only if a comparison matrix/report saves effort. Keep model calls outside routine deterministic checks.

### 6. Textlint

Inspect [getting started](https://github.com/textlint/textlint/blob/master/docs/getting-started.md) and [custom rule docs](https://github.com/textlint/textlint/blob/master/docs/rule.md). It provides local prose linting and rule APIs, including TypeScript authoring. Rules are plugins; installation alone does not provide the brand or SEO checks.

Potential use: reusable terminology, style and sentence checks. The engine already has deterministic validation and Vale generation, so avoid overlapping lint stacks during the pilot. Neither regex nor AST linting proves source-backed meaning.

### 7. Social Media Skills: exploratory

The [README index](https://github.com/social-media-skills/skills/blob/main/README.md) links LinkedIn writing, Facebook strategy, social SEO and cross-platform repurposing files. This inspection establishes the catalog's relevance; individual methods still need file-level review and benchmark validation before adoption. Its 149 stars are substantially below the main shortlist. Avoid importing posting integrations or vendor-specific services just to obtain writing advice.

### 8. Hermes Self-Evolution: later experiment

The [README](https://github.com/NousResearch/hermes-agent-self-evolution/blob/main/README.md) describes skill optimization with DSPy/GEPA and an external Darwinian Evolver component with AGPL-v3 licensing. Its roadmap distinguishes implemented skill work from later layers. Repeated optimization/evaluation is different from repairing a failed post and could increase model usage substantially. Do not classify the entire integration as permissively licensed based on its README alone; inspect applicable LICENSE files and dependencies if this becomes a real implementation candidate.

## Repository snapshots

These are metadata snapshots for reproducible follow-up, not a claim that every file in each commit was audited. Source reads used the default branches during this research; verify exact file hashes at the selected commit during intake. If the branch changed between reads, re-read the selected files at that commit before adoption.

| Repo | Default-branch commit observed |
|---|---|
| NousResearch/hermes-agent | `0e427d788d253630d38a3a51cd76849e73cd6925` |
| coreyhaines31/marketingskills | `c7d7dfb6b460fc376b4b2204b78a9c9fd5ca6467` |
| anthropics/knowledge-work-plugins | `02ffa99ff00ce4d3046ccebabb8357cb39f3ab06` |
| blader/humanizer | `225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8` |
| promptfoo/promptfoo | `720657dab1e8b6880cd4a9c223e12db4a8c0fe21` |
| textlint/textlint | `8a477e2d6d661f6c6f26cd7f1cd6c1c07fd16442` |
| social-media-skills/skills | `e2c549d3570be11412d749dee6192857fe256483` |
| NousResearch/hermes-agent-self-evolution | `0a929e3aa20e15cf04dc7c28492a7d41a5139125` |

## What to adopt first

1. Establish the Ken brand/keyword/acceptance profile using current evidence rules and approved examples.
2. Curate small platform-writing and brand-review packs from Marketing Skills and Anthropic's marketing files.
3. Add Hermes behind the existing provider/repair interfaces and prove cross-run lesson reuse.
4. Compare optional Humanizer edits on recorded outputs; preserve facts and brand voice.
5. Add Promptfoo or Textlint only when a measured gap in existing tests/validators justifies them.

Do not install eight repositories into the production runtime. The main engine needs a small set of reviewed, pinned methods, one callable brain and its current validation/evidence infrastructure. New repositories should enter a candidate registry and be adopted only after relevant output improves without violating source rules.

BlogPilot and blog-focused repos remain later research references. AnythingLLM, Open WebUI and Dify do not supply the missing generation/repair contract here and would expand the platform footprint. No new claims about their current licenses or deployment requirements were needed for this shortlist.
