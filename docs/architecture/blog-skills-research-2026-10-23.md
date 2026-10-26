# Blog skills research: what was taken from GitHub (23 October 2026)

Scope: the standalone blog FORMAT prompts (`browser-generation/src/agents/blogFormats.ts`) and the blog supervisor (`browser-generation/blog-supervisor/`). The V1.3 master prompt and the 8 V1.3-based architectures were not touched.

## Method

Shallow clones into a throwaway folder, markdown read only. No script from any repo was run and nothing was installed. Practices were distilled into our own wording; no repo text was copied into a prompt. Repos marked MIT allow this; the one without a stated licence (yoyothesheep) was used for ideas only.

## Sources

| Repo | Licence | Last commit seen | Used for |
|---|---|---|---|
| [AgriciDaniel/claude-blog](https://github.com/AgriciDaniel/claude-blog) | MIT | 2026-10-14 | Reviewer severity model (P0 to P3), editorial heuristics (heading as a contract, fabricated-stat prevention), two-tier "AI slop" review, cognitive-load thresholds, passage-level extractability, information gain |
| [TheCraigHewitt/seomachine](https://github.com/TheCraigHewitt/seomachine) | MIT | 2026-10-15 | SERP-first research ("what do the top results leave out"), keyword placement (H1, first 100 words, a few H2s, no stuffing), meta description practice |
| [199-biotechnologies/claude-skill-seo-geo-optimizer](https://github.com/199-biotechnologies/claude-skill-seo-geo-optimizer) | MIT | 2026-05 | Answer in the first 40 to 60 words, first 150 words as the highest-weight zone, primary-source citation with year, entity consistency |
| [Yaroslavle/seo-content-writer-claude-skill](https://github.com/Yaroslavle/seo-content-writer-claude-skill) | MIT (README) | 2026-03 | Five-layer editing order (structure, facts, readability, voice, humanise), research brief idea |
| [yoyothesheep/claude-skills](https://github.com/yoyothesheep/claude-skills) | not stated | 2026-10-09 | Ideas only: lead with the finding, then evidence, meaning, caveats, action |

## What was adopted, and where it lives

| Practice | Where |
|---|---|
| First paragraph answers the central question in 40 to 70 words with the headline figure and period | `FIXED_RULES`, "Opening and passage rules" |
| Each paragraph opens with its most important sentence; each section stands alone when quoted (no "as mentioned above", no dangling "This") | same |
| Source and period in the same sentence as the figure | same |
| One name for one thing (no synonym rotation) | same |
| Information gain: check what the top results omit, then add a derived number, contrast or risk from the report | same, and in the research bullets |
| Cognitive load for number-dense text: about 4 figures and 3 new names per 100 words at most | `FIXED_RULES`, "Readability load"; measured by code as `densestPer100` |
| Stock-phrase ban list, templated-pattern list (same-shape headings, "Here's why" openers, three-clause runs, false balance, hedge stacking, closing rhetorical question, announcing importance, uniform bullets) | `FIXED_RULES`, "Writing quality"; counted by code in `measure.ts` (`stockPhrases`, `hereOpeners`, `sameShapeHeadings`) |
| Keyword placement without stuffing; specific, front-loaded meta description | `FIXED_RULES`, SEO block |
| Severity tags on every supervisor finding (P0 to P3); retry only for P0 or P1 | `roles/supervisor.md` |
| "Heading is a contract" as a MUST (the first paragraph delivers what the H2 promises) | `roles/supervisor.md`, MUST 5 |
| Three or more distinct stock phrases is a P1; one or two is a P3 | `roles/supervisor.md`, MUST 6 |

## What was deliberately NOT adopted

| Practice | Why not |
|---|---|
| FAQPage schema and visible FAQ blocks | Our pipeline writes plain HTML for syndication, V1.3 forbids FAQ and Methodology blocks, and claude-blog itself notes FAQ markup brings no Google rich result. The Q&A format gets the same extractability from question headings. |
| Comparison tables, TL;DR callout boxes, TOC | Tables are forbidden by our rules. The Executive Brief uses a bullet takeaway list instead of a box. |
| Author bio, about page, schema, OG tags, page-speed items | Handled by the publishing site, not by article text. |
| Off-site surfaces (Reddit, G2, directories, listicle outreach) | Outside this pipeline. |
| Fixed question-heading quota | claude-blog's own review lists question-cadence H2s as a templating tell. Only the Q&A format is all-questions on purpose. |
| Percentage "citation lift" claims | The geo-optimizer repo itself removed them as unreplicated. Nothing here relies on them. |
| Word-count floors as a citation strategy | Each format has its own length band instead; the supervisor judges against that band. |

## Still unproven

None of this has been tested against live ChatGPT output yet. The format prompts, the new rules and the supervisor tags should be judged on real samples (`npm run blog:sample -- --structure=<id> --review`).
