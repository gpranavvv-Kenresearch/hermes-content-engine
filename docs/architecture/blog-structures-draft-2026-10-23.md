# Blog article architectures: DRAFT for approval (23 October 2026)

Status: **proposal only. Not wired into any prompt or code.** Per the format-approval rule, nothing here is adopted until the user has seen samples and approved them.

## How these fit the live prompt

`browser-generation/prompts/blog-generation/01-master-v1.3-live.txt` stays the master prompt. Every V1.3 hard rule is unchanged and applies to every architecture below:

- 5 to 7 H2s; target 1,400 words, never above 1,800; paragraphs 3 to 4 sentences, 55 to 85 words.
- H2 formula `[Entity + subtopic] + [question OR verified insight/number]`; at least 3 question H2s; first sentence under every H2 is a self-contained, entity-rich, quotable statement.
- Patterns A/B/C: C exactly once, in a non-final H2; no same pattern in two consecutive H2s.
- Every `Ken Research` bold; every number, year, percentage and currency value bold.
- Links: 1 Ken homepage, 4 adjacent Ken reports, 1 primary-report CTA, 3 government sources. No tables, no Methodology section, no standalone FAQ block, no em dashes.
- No invented figures. All numbers come from the report or a verified government source.

What changes: V1.3 currently says "silently create three possible structures, choose the strongest". With this proposal that step is replaced by **one selected architecture block** (only that block is injected, so the prompt stays short). The architecture decides the H2 spine and the order of insight; V1.3 still decides all formatting, linking and sourcing.

## Where the ideas come from

- [claude-blog](https://github.com/AgriciDaniel/claude-blog) templates (comparison, data-research, FAQ/knowledge, pillar): answer-first openings, one original insight per section, fairness and "when the other option wins" nuance, practical implication per finding. Its tables, TL;DR boxes, Methodology and FAQ blocks are **not** used because V1.3 forbids them.
- [yoyothesheep/claude-skills](https://github.com/yoyothesheep/claude-skills) AEO writer: lead with the finding, show evidence, explain meaning, state caveats, give an action.
- [seomachine](https://github.com/TheCraigHewitt/seomachine): search-intent-first outlines and "information gap" thinking.

## Architectures

Each spine lists the H2 roles in order. `Q` = question H2, `S` = statement H2 carrying a verified finding. `[ ]` is filled from the report. Pattern notes only suggest where C and the second image fit; V1.3 pattern rules win.

### 1. Decision Brief (default, closest to the current output)
Use when: no strong angle; broad B2B markets.
Spine: (1 Q) How big and how fast. (2 S) Core demand driver with mechanism. (3 S) Buyer or segment split. (4 Q) Who competes and how they win. (5 S) The counter-thesis: what could slow it. (6 S) Forward conclusion + CTA.
GEO: the first sentence of H2 1 carries base value, forecast, CAGR and years.

### 2. Question Ladder (best for AI Overviews and People-Also-Ask)
Use when: high search demand, well-known sectors.
Spine: five to six H2s, **all but one phrased as real search questions**, climbing from "how big" to "who wins" to "what should a buyer do". Each answer begins with the full direct answer in sentence one; later sentences add mechanism and implication.
GEO: replaces the FAQ block V1.3 forbids. Each H2 is a standalone quotable Q and A.

### 3. Economics Teardown
Use when: logistics, manufacturing, retail, energy, agriculture.
Spine: (1 Q) Size and growth. (2 S) Where the value chain earns its margin. (3 S) The cost or pricing driver that moves the market. (4 Q) How channel or capacity economics differ across segments. (5 S) Risk to unit economics. (6 S) Conclusion.
Insight rule: each H2 contains one derived number or named threshold labelled as Ken Research analysis, only when the report supports it.

### 4. Segment Divergence
Use when: the report shows clearly unequal segments.
Spine: (1 Q) Size and growth. (2 S) Which segment leads and why. (3 S) Which segment is accelerating or lagging. (4 Q) What buyers in each segment actually choose. (5 S) Risk or saturation signal. (6 S) Conclusion.
Guard: never rank players or segments beyond what the report states.

### 5. Regulation to Opportunity
Use when: policy-shaped markets (health, fintech, energy, food safety, telecom, mobility).
Spine: (1 Q) Size and growth. (2 S) The regulatory shift and its date, sourced to a government site. (3 S) Who gains and who bears compliance cost. (4 Q) How the rules change buyer or supplier behaviour. (5 S) Execution risk. (6 S) Conclusion.
Fit: the three mandatory government links land naturally here.

### 6. Competitive Moat
Use when: concentrated or consolidating markets.
Spine: (1 Q) Size and growth. (2 S) How the market is structured. (3 S) What creates the entry barriers (capital, licences, distribution, data). (4 Q) How do leading players differentiate. (5 S) Where challengers can still enter. (6 S) Conclusion.
Guard: V1.3's "competition not falsely ranked" rule applies in full.

### 7. Scenario Outlook (baseline, upside, downside)
Use when: volatile or policy-dependent markets.
Spine: (1 Q) Baseline size and forecast. (2 S) What must go right for the forecast to hold. (3 S) What could pull growth below it. (4 Q) Which signals should buyers watch. (5 S) Segment or region most exposed. (6 S) Conclusion.
Guard: scenarios are **qualitative** around the report's own CAGR; no invented scenario numbers.

### 8. Myth vs Evidence
Use when: the market has widely repeated assumptions the data complicates.
Spine: (1 S) The headline figure and the assumption it challenges. (2 to 4) One H2 per common belief, each testing it against report or government evidence (use Q or S form). (5 S) What the evidence implies for decisions. (6 S) Conclusion.
Value: highest information gain, and it satisfies the counter-thesis requirement structurally.

## Selection

The strategy step picks one architecture per article from the report's evidence (for example: strong regulatory sources suggests 5; clearly unequal segments suggests 4; concentrated players suggests 6), and rotates so consecutive articles do not repeat. Hermes sees the chosen architecture at the evidence and draft gates.

## Sample outline (no figures; shows the idea only)

Market: Brazil Seed Market. Architecture 2 (Question Ladder).
1. How Big Is Brazil's Seed Market and How Fast Is It Growing Toward [year]?
2. What Is Driving Seed Demand Across Brazil's Soybean and Corn Belts?
3. Which Seed Segments Are Brazil's Growers Shifting Toward, and Why?
4. Who Competes in Brazil's Seed Market and How Do They Win Growers?
5. What Regulatory and Climate Risks Could Slow Brazil's Seed Market?
6. [Fresh decision-driving conclusion H2 naming Brazil seed and the forecast window]

## Open points for the user

1. Approve, drop or rename architectures (all eight are proposals).
2. Confirm that architecture selection may rotate automatically.
3. Confirm whether to keep V1.3 byte-for-byte and only swap the "three structures" step, or also shorten V1.3's repeated rules (it is about 73 KB).
