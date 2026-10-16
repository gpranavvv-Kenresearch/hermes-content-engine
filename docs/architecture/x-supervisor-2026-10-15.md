# X supervisor and writing methods

Requested on 2026-10-15: support `hermes:run --platform x --count 10 --write-sheet`, with useful B2B content informed by a reviewed GitHub repository. This does not change the ten frozen LI/FB formats or the model provider.

## Reviewed repository

- Repository: https://github.com/coreyhaines31/marketingskills
- Snapshot: `55ff469422c3592dac45bcad08dfb40221981c02`, resolved from GitHub's commits API on 2026-10-15.
- Inspected: `skills/social/SKILL.md`, `skills/social/references/platforms.md`, `skills/copywriting/SKILL.md`, `skills/seo-audit/SKILL.md`, and `LICENSE` (MIT, copyright Corey Haines).
- Existing method pack: `config/techniques/coreyhaines31__marketingskills.json`. Three original, paraphrased X rules were added for early topic/keyword clarity, buyer relevance, and specific supported proof. Existing LI/FB rule text remains unchanged.

Adapted principles: put the topic early; make a specific finding understandable without a click; connect it to an evidence-backed decision consideration; use clear customer language; avoid vague claims, invented personal stories, manufactured beliefs and engagement bait. SEO audit guidance informs natural topic wording only. Blog word counts, headings, keyword-density targets and algorithm/engagement promises are not applied to X. Source evidence outranks every writing technique. No third-party repository code was installed or executed.

## Implementation

The supervisor now accepts X and its twitter alias, using its existing batch, evidence, retry, regeneration, learning and guarded Sheet write workflow. Writer and supervisor share `X POST CONTRACT` from `src/strategy/prompts/common.ts`. Every supervisor gate receives platform limits. Validator rewrites preserve the same contract. X omits long-form style examples, uses source-safe openers and structures, and has a modest 12-word useful-prose floor rather than LI's 110 words. It retains the existing 280-character cap, URL length adjustment, exact primary keyword, named brand, source link/UTM, year/scope/claim checks and formatting policy. The X contract suggests 1-2 hashtags; the pre-existing validator permits 1-4. It does not force a question or an unsupported business implication.

The existing `next:x` command remains the legacy runner; `hermes:run --platform x` explicitly selects the Hermes supervisor workflow. No FreeLLMAPI integration is included.

## Verification

`supervisor-hermes/tests/x-flow.test.ts` exercises the real strategy, writer, validator, learning and Sheet adapters with fake model responses and an evidence fixture. It checks concise prompts and provenance, URL-adjusted length, all four gates before a single X Post cell write/read-back, and refusal to write an over-limit draft even when the supervisor requests proceed. CLI tests cover X count 10, the twitter alias and opt-in Sheet writes. A live pilot must omit `--write-sheet` for editorial review.
