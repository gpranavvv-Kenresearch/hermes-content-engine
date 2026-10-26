# What ranks for market queries: structure research (26 October 2026)

Purpose: ground the standalone blog formats in how pages that actually appear for market queries are built, instead of designing them from theory.

Status (26 Oct 2026): the findings and proposals below were **applied to the standalone format prompts** at the user's instruction (`browser-generation/src/agents/blogFormats.ts`; generated files in `prompts/blog-generation/formats/`). Shared rules went into every format; `f-deep-dive`, `f-roadmap`, `f-myth-evidence`, `f-comparison` and `f-scenarios` were adjusted; three formats were added: `f-estimate-reconciliation`, `f-regulatory-explainer`, `f-niche-brief`. The V1.3 prompt and the 8 V1.3-based architectures were not touched. The new prompts have not been run on live ChatGPT output yet.

## Method and limits

- 12 web searches across 6 markets (South Africa BNPL, Mexico feminine wipes, Nigeria float glass, Brazil seed, Switzerland data center, plus sub-topic queries on competition and regulation), then 11 pages fetched and reduced to a structure fingerprint (headings, opening, lists, sourcing, links, CTAs). No page text was copied.
- This is a spot check, not a dataset. It uses a US-based search tool, so local ranking order is approximate. It shows which page types appear and how they are built; it does not prove why they rank. Ranking also depends on domain strength and backlinks.
- One page (BusinessWire) returned 403 and was skipped.

## Finding 1: three different page types win, depending on the query

| Query intent | Example | What appears | Typical build |
|---|---|---|---|
| Head query ("[country] [market] market") | South Africa BNPL, Switzerland data center | Research-firm report pages (IMARC, Mordor, Ken Research, ResearchAndMarkets, MarketsandMarkets, IndexBox, Credence) and syndicated press releases (PR Newswire, BusinessWire, GlobeNewswire, FinTech Futures) | 1,100 to 2,300 visible words. Exact-match H1 with years. Summary block first with bold size, forecast and CAGR. "Key questions answered" or FAQ. Entity phrase repeated in H2 and H3. Segmentation lists. Dated "recent developments". Visible "last updated". Sample and buy CTAs. |
| Question or explainer ("why is X growing", "is X regulated") | BNPL growth, BNPL regulation | Provider blogs (Stitch, Compass Plus, Ozow), trade press (IT-Online, W24), a law-firm deep dive (Moonstone / Webber Wentzel), regulator and ombud news | 500 to 1,300 words. Answer or data in the first 100 words. Local framing. Named regulators, statutes and executives. Quotes from named people. Short paragraphs (2 to 5 sentences). Honest hedging ("grey area"). Comparison with other jurisdictions. |
| Niche market with no exact report | Mexico feminine wipes, Nigeria float glass | Adjacent-category reports, trade databases (OEC, IndexBox with placeholder values) and trade-press news items (Glass International, MIGA) | News items of about 250 words: one lead, named entities, one or two executive quotes, specific numbers (capacity, investment). Some are 7+ years old. |

## Finding 2: techniques that recur across winners

1. Answer first: the opening gives size, forecast and CAGR, or the verdict, before any context.
2. Exact entity phrase repeated in the title and headings (market + country), and keyword-shaped headings that mirror queries.
3. Figures bolded or boxed up front; attribution in the same sentence (publisher, regulator, year) on the better pages.
4. Question-form headings with short direct answers (FAQ, "Key questions answered", expert Q&A).
5. Freshness signals: visible updated date, dated "recent developments".
6. Named entities and local specifics: regulators, statutes, companies, provinces, plants, capacities.
7. Short paragraphs and scannable lists with bold lead-in labels.
8. Stakeholder framing: "key takeaways for stakeholders", by role.

## Finding 3: gaps the winners leave open (our chance at information gain)

- **Sourcing is weak.** Several pages give figures with no external source, an empty "Citations" heading, or no links at all. Government and regulator links are almost absent.
- **Estimates disagree by up to 10x** (IMARC South Africa BNPL about USD 81 million versus about USD 815 million elsewhere; IMARC Brazil seeds about USD 781 million versus about USD 8.7 billion for Ken Research). Almost no page explains why. A short, sourced reconciliation of scope and definitions is rare and quotable.
- **Regulation answers are unsettled and uncited.** The "is BNPL regulated" pages name the NCR, FSCA, NCA, FAIS and COFI but cite no primary source. A page that links the regulator's own position would stand out.
- **Niche markets have no exact-match answer.** Nobody sizes "Mexico feminine wipes". A "what is known and what is not" brief that triangulates from the adjacent category and official trade data is unique.
- **Older pages are stale** (2018 and 2022 items still surface), so a current, dated page has room.

## Finding 4: a caution about the source data itself

On the South Africa BNPL page, the Ken Research base value (USD 815.1 million, 2025) and CAGR (9.8%) are identical to ResearchAndMarkets' public press-release figures, and the page projects a constant 9.8% every year (a straight extrapolation). The page also has internal inconsistencies (survey sample sizes, period labels). I cannot tell which came first or why they match, but it affects originality and trust. Articles should not simply restate those numbers; they need an angle the report supports.

## Conflicts with our rules

The strongest pages rely on tables, FAQ blocks, a methodology section and a TOC. Our prompts forbid tables, FAQ blocks and Methodology/Data Status sections. Substitutes that stay inside the rules:

| Winner's tool | Rule-compatible substitute |
|---|---|
| Key-stats table | Bullet list with a bold figure first |
| FAQ block | Question-form H2s with a direct first sentence (the Q&A format) |
| Methodology section | One sentence in the opening stating what the figure covers and its year |
| Drivers / restraints impact table | Bulleted drivers with a bold impact label and horizon |
| Recent developments list | Only when the report page or a government source gives dated items |

## Proposed changes (for approval, not applied)

Shared rules (all formats): state the market definition (what is counted) in the opening; when third-party estimates differ by more than 2x, say so and why, with sources; keep source and year in the same sentence as every figure.

Existing formats, adjusted by what the research shows:

| Format | Adjustment |
|---|---|
| `f-deep-dive` | Add a short "what is counted and why estimates differ" block near the top; drivers and restraints with bold impact labels and horizons; dated developments only if supported |
| `f-roadmap` | Anchor the "now" section on dated developments |
| `f-myth-evidence` | Best fit for regulation grey areas and conflicting estimates; use official positions as the test |
| `f-comparison` | Compare segments, channels or jurisdictions, as the law-firm piece does with the UK, Australia and the US |
| `f-scenarios` | Use pending legislation or regulator action as the scenario drivers; qualitative only |

Candidate new formats suggested by the gaps:

1. **Estimate reconciliation:** "Why do market-size estimates for [market] differ?" Scope, base year, definitions, and which figure fits which decision.
2. **Regulatory explainer:** "Is [product] regulated in [country]?" Regulators, statutes, positions that disagree, pending law, what it means for operators; government sources linked.
3. **Niche market brief:** for markets without a published exact-match report. What is known, what is missing, triangulation from adjacent categories and official trade data.

## Next steps (each needs approval)

1. Confirm which findings to adopt and which new formats to draft.
2. Write the sample outlines for the chosen formats on one real report.
3. Update the remaining prompts, then run samples on live ChatGPT output.
