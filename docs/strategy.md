# Strategy, variation and prompt templates (src/strategy)

This module decides what to write and how to vary it. It never decides what is true: facts come from the evidence layer.

## Source policy in this module

- Facts, numbers and citations come only from Ken Research and government/regulatory sites.
- Trend, SERP and industry-leader material is a **planning signal** (`PlanningSignal`, `purpose: 'planning'`). It may suggest topics and angles. No function in `src/strategy` accepts a `PlanningSignal` and returns a `Fact`; signals travel in `Brief.planningSignals`, separate from `Brief.factIds`.
- Competitor hosts (`sourcePolicy.blockedHosts`) are dropped by `isBlockedHost()` (dot-boundary subdomain match) before a signal is created. Prompts never list competitor names.
- `serp-gap` output and prompts never include a SERP page title, URL or quote. Prompts do not receive `planningSignals` at all.

## What is rule-based (deterministic, explainable)

| Piece | Behaviour |
| --- | --- |
| `persona-selector` | Fixed rules: growth/CAGR-heavy facts -> pe-vc; policy words in title/tags or policy facts -> strategy-head; headline words, `headlineDriven`, or 1-2 facts -> cxo. Always within `campaign.personaIds`; ties go to the earlier id; a reason string is returned. |
| `brief-builder` | Angle template filled from the strongest verified fact (confidence, observed before derived, id). `factIds` = verified facts that do not disagree on value within the same metric/period/geography/definition/unit. |
| `evergreen` | Pillar sections are data. Each fact attaches to the first section whose metric hints match. Refresh notes flag facts older than a configurable age. |
| `variation` | Axes are data tables (`variation-axes.ts`). Sampling is seeded (mulberry32) and picks the least-used option per axis for the item, so tone, structure and opener are not repeated for one item until the table is exhausted. |
| `prompts` | Pure string builders. Same inputs give the same prompt. |

## What is heuristic (treat as a starting point)

- **SERP gaps** (`compareOutline`): heading-token overlap with light stemming plus capitalised 2-3 word runs as entities. Title-case headings make entity detection noisy; single capitalised words are ignored. "Angles nobody covers" is a fixed keyword list, not market insight. The output is a prompt to a writer, not a verdict.
- **Variant duplication** (`checkVariantSet`): shingle Jaccard from `utils/similarity`. It catches reworded copies poorly and the default threshold (0.5) is **not calibrated**. Calibrate on labelled pairs before relying on it.
- **Campaign tone cap**: a soft cap over the last N campaign variants. When item-level distinctness and the cap conflict (small windows, few fresh tones), item distinctness wins.
- **Persona tone weights**: small hand-set preferences, editable data.
- **Length classes**: clamped to configured limits (`lengthClassesFor`). Limits marked "verify" in `platform-limits.config.ts` are inherited unverified.

## Variation history

`VariationHistory(store)` persists each sampled variant to collection `variants` (id = zero-padded sequence + item hash). Call `await history.load()` once, sample with `sampleVariant`, then `await history.record(variant, platform)`. Sampling is synchronous against the loaded view.

## No ranking promises

Nothing here claims or guarantees search ranking, traffic or visibility. Pillar templates aim at clear, current, well-structured content; any search outcome depends on factors outside this code.

## Not built

- Google Trends client: `TrendSource` is only an interface. The library is unverified and was not added.
- Fetching SERP pages: `extractHeadings` takes HTML supplied by the caller (through a `Fetcher`); this module does no network I/O.
