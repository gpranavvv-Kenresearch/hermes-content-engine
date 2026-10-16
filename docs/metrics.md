# Content readiness metrics

Code: `src/evaluation/`. Entry point: `scoreContent(input)`.

## What this score is, and is not

`overall` is a **content READINESS score**. It measures observable properties of a draft: whether its numbers
trace to verified facts, whether it covers the brief, whether it is original, readable and well structured, and
(when HTML exists) whether basic technical tags are present.

It is **NOT a ranking prediction and NOT a citation prediction**. No score here guarantees that a page will be
indexed, ranked, shown in an AI answer, or cited. Search engines and answer engines use signals we cannot see.
The upstream projects whose ideas we borrowed say the same about their own scores (claude-blog's
`ai_citation_score.py` states its scores "are not calibrated probabilities and do not predict whether any answer
engine will cite a page"). The result `label` always says so, literally.

Observed outcomes (AI-citation checks, Search Console data) are a different kind of data. They are typed in
`src/evaluation/observations.ts`, can be attached to a result for reporting, and are **never** read by the scorer.
A test asserts that changing only the observed metrics changes neither `overall` nor any dimension.

## Result shape

```
ContentScore {
  dimensions: { name, score (0..1), applicable, weight, evidence[], formula }[]
  overall:    number (0..1)      weighted mean of applicable dimensions
  label:      string             states it is a READINESS score, not a ranking or citation prediction
  weights:    SCORE_WEIGHTS
  observed?:  echoed input, never used
}
```

A dimension with nothing to measure (for example no corpus, no HTML, a non-blog platform) is returned with
`applicable: false` and left out of `overall`; the remaining weights are renormalised. It is never silently scored 0 or
1 as if it had been measured.

## Weights (`SCORE_WEIGHTS`)

| Dimension | Weight |
|---|---|
| evidenceCoverage | 0.25 |
| sourceTraceability | 0.15 |
| intentMatch | 0.15 |
| originality | 0.15 |
| readability | 0.10 |
| structure | 0.10 |
| technical | 0.10 |

`overall = round4( sum(w_i * score_i) / sum(w_i) )` over applicable dimensions. These weights are an editorial
choice that puts the pipeline's core promise (every number is traceable) first. They are **not fitted to any
ranking or citation data**, and no upstream project provides weights we could reuse (the weights in claude-blog and
geo-optimizer-skill are point allocations for their own checklists, which their authors describe as heuristics). Change
them in one place and the tests will tell you what moved.

## Dimensions

### evidenceCoverage
- **Definition:** share of material numeric claims in the text that the claim checker mapped to a fact.
- **Formula:** `covered / material`; material = `ClaimMapping` with status not `ignored`; covered = `supported` or `derived`.
  No mappings but numeric figures in the text (%, currency, scale words, decimals, 1,000s; bare years excluded) gives 0.
  Nothing numeric: not applicable.
- **Source:** first principles. The idea of separating sourced from unsourced statistics is also in claude-blog
  (`citations.sourced_statistics` / `unsourced_statistics` in `analyze_blog.py`), but its regex counters are not ported.
- **Limits:** only as good as the `ClaimMapping[]` supplied; it does not re-check claims itself.

### sourceTraceability
- **Definition:** whether every supported/derived claim leads to a verified fact from an allowed source.
- **Formula:** `traceable / referenced`. Traceable = factId exists in `facts`, `verificationStatus === 'verified'`,
  `sourceUrl` passes the source policy (Ken Research or government, competitors blocked; `src/assets/source-check.ts`
  uses `src/config/source-policy.config.ts`), and for derived facts all input facts satisfy the same.
- **Source:** first principles from this project's source policy.
- **Limits:** checks the recorded provenance, not whether the source page really says it.

### intentMatch
- **Definition:** how much of the brief's keywords, beat points and angle appear in the text.
- **Formula:** mean of available components. Keywords: 1 if the normalised phrase appears contiguously, 0.5 if all
  its words appear non-adjacently, else 0. Beat points and angle: share of significant words (length >= 4, not a
  stop word, lightly stemmed) found in the text.
- **Source:** first principles. Deliberately no keyword-density target: geo-optimizer-skill's own docs cite the
  Princeton GEO study finding that keyword stuffing gave no significant improvement and could hurt fluency.
- **Limits:** lexical. A well written paragraph that uses synonyms scores lower. The brief has no explicit search
  intent field, so intent is judged only through these terms.

### originality
- **Definition:** how different the text is from a corpus of earlier texts.
- **Formula:** `1 - max similarity`, similarity = Jaccard of 3-word shingles (`src/utils/similarity.ts`).
- **Source:** first principles. Not applicable with an empty corpus.
- **Limits:** catches reuse of wording, not paraphrase or reused ideas. The similarity module notes that thresholds
  must be calibrated before being used as a pass/fail gate; we expose the continuous value and set no threshold.

### readability
- **Definition:** Flesch Reading Ease against a band suited to senior B2B readers.
- **Formula:** `206.835 - 1.015 (words/sentence) - 84.6 (syllables/word)` (Flesch 1948; the same constants appear in
  claude-blog `analyze_blog.py`). Band score: 1.0 for 50-60, 5/7 for 45-65, 3/7 for 40-70, 1/7 otherwise.
  Not applicable under 10 words.
- **Source:** claude-blog documents persona bands: "Consumer 60-80, Professional 50-60, Technical 30-50" and a
  stepped score (7/7 in the ideal band, 5/7 and 3/7 in wider bands, else 1/7). We use the Professional band as the
  ideal and reuse the 1, 5/7, 3/7, 1/7 steps. **The widths of the outer bands (plus or minus 5 and 10) are our
  adaptation**, not a sourced threshold. (geo-optimizer-skill prefers Flesch-Kincaid grade 6-8 for general
  audiences; not used, because it targets a broader readership than our senior audience.)
- **Limits:** the syllable counter is an English vowel-group heuristic, so scores are approximate. Flesch measures
  sentence and word length, not clarity or correctness.

### structure
Applies to platform `blog` only (social posts have no headings to check). Mean of these checks:

| Check | Rule | Source |
|---|---|---|
| hierarchy | no heading level skips (H2 to H4) | claude-blog `analyze_headings`, `hierarchy_clean` |
| hasH2 | at least one H2 | claude-blog content-quality scoring |
| singleH1 | at most one H1 (claude-blog rewards exactly one; we allow zero because the title is often held outside the body) | claude-blog, adapted |
| listsOrTables | a table, or at least 3 list items | claude-blog depth/structure rule |
| frontLoading | the first 30% of words is at least 50 words and contains a number | geo-optimizer-skill `audit_content.py` |
| passageDensity | share of paragraphs of 10+ words that are 50-150 words and contain a number | geo-optimizer-skill `citability.py`, `detect_passage_density` |
| answerFirst | share of question headings (ending "?") followed by a 5-60 word paragraph; skipped without question headings | geo-optimizer-skill `citability.py` (snippet readiness) |

- **Provenance caveat:** geo-optimizer-skill attributes the 50-150 word passage figure to "Stanford Nature
  Communications 2025" (2.3x citation rate). We could not verify that claim and treat the numbers as that project's
  heuristic, not established fact. Note that claude-blog's newer `analyze_ai_citation_readiness` explicitly drops
  fixed passage lengths ("without fixed passage lengths"); the two projects disagree, which is one more reason to
  read this dimension as a style checklist, not a citation predictor.
- **Not ported:** the 100-150 word "optimal section" bonus and Flesch-Kincaid 6-8 sweet spot (geo-optimizer-skill),
  because they conflict with the senior-B2B readability band above.
- **Limits:** short but well formed articles are penalised by frontLoading and passageDensity; markdown and HTML
  parsing are simple.

### technical (only when `html` is supplied)
Mean of binary checks: non-empty `<title>`; `<meta name="description">` present; `<link rel="canonical">` present;
exactly one H1 and no heading skips; at least one JSON-LD block and none unparseable; robots meta does not contain
`noindex`.

- **Source:** presence checks as in geo-optimizer-skill `audit_meta.py` / `audit_schema.py` and claude-blog's
  heading rules. `noai` / `noimageai` are reported in the evidence (geo-optimizer-skill flags them as blocking AI
  use) but are not scored, because the brief asks only for `noindex`.
- **No length thresholds:** neither source defines a hard title or description length we could reuse, so lengths are
  reported, not scored. JSON-LD is checked for parseability only, not validated against schema.org or Google's rich-result rules.
- **Limits:** static HTML only. It does not check crawlability, Core Web Vitals, rendering, links or sitemaps.

## Attribution and licenses

Research on 2026-10-13 by reading (not executing) shallow clones of:

- **claude-blog** by AgriciDaniel, <https://github.com/AgriciDaniel/claude-blog>, MIT License
  (Copyright (c) 2025-2026 AgriciDaniel). Read: `scripts/ai_citation_score.py`, `quality_gate.py`,
  `cognitive_load.py`, `lint_prose.py`, `analyze_blog.py`.
- **geo-optimizer-skill** by Juan Camilo Auriti (Auriti Labs), <https://github.com/Auriti-Labs/geo-optimizer-skill>,
  MIT License (Copyright (c) 2026 Juan Camilo Auriti). Read: `SCORING_RUBRIC.md`, `src/geo_optimizer/core/`
  `audit_meta.py`, `audit_content.py`, `citability.py`, `models/config.py`.

No code was copied. Formulas and thresholds listed above were re-implemented in fresh TypeScript; MIT asks for the
copyright notice only when copying substantial portions, and we credit the ideas here regardless.

Skipped on purpose (arbitrary or not reproducible):

- `ai_citation_score.py` per-engine point bands (e.g. 8/12/15 points for 1/2/3 citations) and its 40/35/25 engine
  blend: author-chosen points, described by the author as uncalibrated.
- `quality_gate.py` pass threshold (70): a repository policy, tied to the analyzer's own 100-point score.
- `cognitive_load.py` thresholds (entities per 100 words, clause depth ...): derived from working-memory theory but
  tuned by hand; they would need calibration on our own content first. (That file also credits an Apache-2.0 UI
  cognitive-load model; nothing from it is used here.)
- `lint_prose.py`: a repository style rule (no em/en dashes), unrelated to readiness.
- geo-optimizer-skill category weights (robots 18, llms 18, schema 16 ...): site-audit point allocations.

## Reproducibility

`scoreContent` is a pure function: no network, no clock, no randomness. The same input gives byte-identical output
(tested). Evidence strings are deterministic and capped at five items per list.
