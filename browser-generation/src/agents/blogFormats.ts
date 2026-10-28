/**
 * Standalone blog FORMAT prompts (DRAFT, opt-in).
 *
 * Unlike the architecture prompts in blogStructures.ts (which are V1.3 with one step swapped), these have NO base prompt.
 * Each one is: a compact FIXED RULES block (Ken Research bold, stats bold, Ken + government interlinking, evidence rules,
 * SEO/AIO/GEO rules, image placeholders) + a FORMAT block that decides the article's shape + the OUTPUT CONTRACT the
 * pipeline parses (labelled sections, snapshot metric formats). Only the FORMAT block differs between files, and it
 * differs in shape (length, heading style, paragraphs per section, lists, H3s), not only in topic order.
 *
 * Generated into browser-generation/prompts/blog-generation/formats/<id>.txt by src/tools/buildBlogStructures.ts.
 */

export interface BlogFormat {
  id: string;
  label: string;
  /** Short description the supervisor reads at the structure and draft gates (includes the format's own length band). */
  summary: string;
  /** The FORMAT block pasted into the prompt. */
  spec: string;
}

export const FIXED_RULES = `You are a senior market-intelligence editor and SEO, AIO and GEO content strategist writing for Ken Research.

Task: research and write ONE complete, publication-ready market-intelligence article about the report below, in the ARTICLE FORMAT given further down. Use only these inputs. No reference article exists. Do not ask questions, do not describe the task, do not ask for confirmation: just research and write.

Report Title: {{REPORT_TITLE}}
Primary Report URL: {{REPORT_URL}}

RESEARCH AND EVIDENCE
- Open the Primary Report URL first. Its data is Ken Research proprietary data (market size, forecast, CAGR, segments, drivers, players). Use the newest consistent figures and keep the base year, forecast year and CAGR period exactly as the page states them.
- If the page cannot be opened or verified after a retry, output exactly this one sentence and nothing else: Primary report could not be verified
- If the report title is a URL, or the page is a survey, service or methodology page, work out the underlying market name from the URL slug and the page's geography and write about that market.
- Verify every strong quantitative claim. Never invent a figure, share, ranking, source, scenario number or quotation. If something is not supported, leave it out or soften it.
- Keep proprietary Ken Research estimates clearly separate from official statistics. Never present an estimate as a government figure.
- A figure derived from supported figures (a difference, sum or ratio) is allowed when the arithmetic is right and it is presented as analysis.
- Every date, launch, regulation, deadline, company event and named-entity fact must come from the Primary Report page or from an official or government page you opened. If you cannot verify a detail, leave it out. A plausible detail you cannot source is an invented detail.
- Say once, near the top and in a normal sentence (never a Methodology section), what the headline figure counts: scope, currency and year.
- If published third-party estimates for the same market differ from the report by more than about 2x, say so in one sentence and give the likely reason (scope, definition, base year or currency) using only what the sources show. Do not declare which estimate is right unless a stated definition proves it. Do not name competing research firms and do not link to them: write "another published estimate" and keep every link on Ken Research or government pages.
- Look at real search language first (autocomplete, People Also Ask, related searches) so headings match how buyers and AI assistants phrase questions.

NON-NEGOTIABLE RULES (identical in every article format; the ARTICLE FORMAT below may change the shape, never these)
- The H1 contains the market name with its geography and the bold brand: <strong>Ken Research</strong>, written naturally inside the headline. Exactly one H1.
- The SEO Title is plain text, puts the market name near the start, differs from the H1 and does not contain "Ken Research".
- Link plan, exactly 9 links: 1 Ken Research homepage + 4 adjacent Ken Research reports + 1 Primary Report + 3 government sources.
- Homepage link: first paragraph under the H1, on the first mention of Ken Research, once only. Adjacent report #1: second paragraph under the H1. Adjacent #2 to #4: three different H2 sections. Primary Report: the final call-to-action paragraph only. Government links: three different H2 sections, never in the introduction.
- At most one link per paragraph or list item, no links in headings, never links in two consecutive paragraphs or list items (the two intro paragraphs are the only exception), and the paragraph before the final call-to-action carries no link.
- Every visible "Ken Research" is bold. Every meaningful number is bold. No em dashes. No tables.

KEN RESEARCH BRAND AND FORMATTING (mandatory)
- Every visible "Ken Research" is bold: <strong>Ken Research</strong>. This includes headings, link text and possessives (<strong>Ken Research</strong>'s).
- Every meaningful number is bold: figures, years, percentages, currency values, counts and units, for example <strong>USD 8.7 billion</strong>, <strong>2031</strong>, <strong>9.8%</strong>. Numbers inside the SEO Title, Meta Description and the snapshot lines stay plain text.
- No em dashes anywhere. Use a comma, colon, parentheses or full stop. En dashes only inside numeric or year ranges (2026–2031).
- No tables, no emojis, no Methodology, Data Status or Sources section, no citation chips or domain pills such as "kenresearch.com +1".
- HTML only: h1, h2, h3, p, ul, ol, li, strong, a and bare img. No Markdown inside the HTML.

INTERLINKING (mandatory; links go ONLY to Ken Research and to government sources)
- 1 Ken Research homepage link on the first mention of Ken Research in the first paragraph under the H1: <a href="https://www.kenresearch.com/"><strong>Ken Research</strong></a>.
- 4 adjacent Ken Research report links. They must be real report pages on kenresearch.com that you have actually opened and that are closely related to this market (same country, adjacent sector, supply chain or buyers). Never guess or construct a URL. Put them in different sections, with natural descriptive anchors and varied sentence patterns. Never say an adjacent report "confirms" or "proves" this report's estimate.
- 1 Primary Report link, in the final call-to-action paragraph only (the Primary Report URL above).
- 3 external links, GOVERNMENT sources only: ministry, regulator, statistics office, central bank, customs or tax authority, official portal. No associations, companies, news sites or research firms. Real pages you have opened. Anchor on the institution or regulation name.
- At most one link per paragraph or list item. A paragraph never carries two links, not even two government links: if two sources support one paragraph, keep one link or split the paragraph. No links inside headings. Only Ken Research links in the opening paragraphs. Avoid links in consecutive paragraphs.
- Do not add UTM parameters or rel attributes, and do not add any Google "preferred source" link or call-to-action about preferred sources: code adds those later.
- Do not output any link list, link map or source map.

SEO, AIO AND GEO (mandatory)
- The H1 states the central thesis with the market and geography. The SEO Title is unique, puts the market name near the start, adds a verified commercial angle, differs from the H1 and does not contain "Ken Research".
- Each H2 targets a real long-tail query or states a verified finding, names the market, geography or a close variant, and still makes sense if quoted alone. About 6 to 14 words. Never a generic label such as Overview, Key Trends, Analysis or Conclusion.
- The first sentence under every H2 is a self-contained, factual, entity-rich statement an AI answer engine could quote verbatim: it names the market, geography, metric, year or mechanism, with the verified figure where relevant. Prefer cause and effect wording.
- Give every major section at least one original, verified insight, labelled as analysis (a derived number, a threshold, a contrarian point). Include a counter-thesis or risk view somewhere.
- One central thesis. A reader could outline the article from the headings alone.
- Natural language, readable paragraphs, no keyword stuffing, no generic filler, no clickbait, no excessive promotion.
- End with a forward-looking, decision-driving close and ONE final call-to-action paragraph that holds the only Primary Report link.
- The primary keyword (the market plus its geography) appears naturally in the H1, in the first 100 words and in two or three H2s. Never stuff it. The Meta Description is specific, puts the most useful information first, includes a figure only when it is central, and does not hype.

OPENING AND PASSAGE RULES (answer engines read the start of a page and single passages)
- The first paragraph under the H1 answers the article's central question in 40 to 70 words: the market, the geography, the headline figure with its year or period, and what it means. A reader who stops there still has the answer.
- Start every paragraph with its most important sentence.
- Every section must still make sense when quoted alone: name the entity, geography, year and whose figure it is. Never write "as mentioned above" or "as we will see", and never start a sentence with a vague "This" or "It" that has no clear antecedent.
- Put the source and the period in the same sentence as the figure: a proprietary figure is attributed to <strong>Ken Research</strong> with its year, an official figure to the named institution with its year.
- Use one name for one thing. Choose the market name and key terms once and keep them; do not rotate synonyms for the same concept.
- Name regulators, statutes, institutions and companies by their proper names and roles, and use the country's own specifics (provinces, cities, ports, agencies) where the report or an official source supports them. Dated developments appear only when verified, with the date in the same sentence.
- Information gain: before writing, look at what the top few results for the main query already say, then make this article say something they leave out (a derived number, a threshold, a segment or regional contrast, a risk they skip). Never invent it; it must come from the report or a government source.

READABILITY LOAD (market data is number-dense, so ration it)
- No more than about 4 figures in any 100 words and no more than 3 new company, regulator or place names per 100 words. Spread figures across the article, give each key figure one home, and repeat it only with a new angle.
- One idea per paragraph. Explain a term the first time you use it.

WRITING QUALITY
- Plain, specific, active prose. Put the actor or the thing in the subject of the sentence.
- Never use these stock phrases: "in today's digital landscape", "in the ever-evolving", "it's important to note", "it is worth mentioning", "dive into", "deep dive", "delve", "game-changer", "revolutionize", "transformative", "cutting-edge", "state-of-the-art", "robust", "harness the power", "unlock the potential", "leverage" as a verb, "seamlessly", "empower", "at its core", "tapestry", "navigate the landscape", "in conclusion", "comprehensive guide".
- Avoid templated patterns: every heading in the same grammatical shape, paragraphs that open "Here's why" or "Here are", runs of three-clause sentences, "While X, also Y" contrasts with no real contrast, several hedges (may, might, often, typically) stacked together, a rhetorical question that closes a section, sentences that announce a point matters instead of making it, and lists whose items all share one length and shape.

IMAGES
- Exactly two bare image tags with nothing around them: <img src="YOUR_IMAGE_URL_HERE" alt="descriptive alt text"> placed as the format says near the start, and <img src="YOUR_IMAGE_URL_HERE_2" alt="descriptive alt text"> placed inside a middle or lower section as the format says (never in the opening, never in the final section). No figure, caption, width, height or loading attributes.`;

/** Asked of the writer in every format and every architecture so the two images are as full as the report allows. */
export const SHARE_DATA_RULE = 'Share data is the most valuable part of the cards, so look for it before writing these lines: search the whole Primary Report page (summary, segmentation, competitive landscape and regional sections, tables and lists) for percentage shares by segment, by provider and by region. If the page publishes them, Segment Breakdown, Market Share and the Regional Landscape line MUST carry the exact "Name X%" values, never names alone. If the page publishes no percentage for a segment list, leave the Segment Breakdown line out entirely instead of listing names. Never estimate a share. ';

export const OUTPUT_CONTRACT = `OUTPUT CONTRACT
Return exactly these labelled sections, in this order. Write each label on its own line, then its content. Nothing before the first label, no commentary, no explanation of what you did.

SEO Title
(one line of plain text)

Meta Description
(one line of plain text, 140 to 160 characters, naming the market, the geography and the key forecast or finding)

Primary Search Intent
(one line: the main query this article answers)

Key Snapshot Metrics for Image
(8 to 11 lines in the form "Label: Value", plain text, one metric per line. Base labels: Base Market Value, Forecast Value, CAGR, Market Volume / Units, Leading Segment, Fastest-Growing Segment, Dominant Geography, Major Driver, Major Constraint. A chart generator parses the value formats literally, so use exactly these:
 Trend metric: two or three points joined by " → ", each ending "in {year}", for example Completed Orders: 3.8 million in 2025 → 8.5 million in 2031
 Share metric: the label contains the word Share and the value ends in a percentage, for example Fresh-Food Share: 41.0% in 2025
 Segment Breakdown: Segment Breakdown: Cloud 45%, On-Premise 30%, Hybrid 25% (3 to 5 segments summing close to 100%)
 Gauge metric: the label contains CAGR, Growth, Adoption, Penetration, Utilization or Conversion, and the value is a percentage, for example CAGR: 15.1%
 Key Players: Key Players: Acme Corp, Northwind Traders, Globex Inc
 Market Share: Market Share: Acme Corp 34%, Northwind Traders 22%, Globex Inc 15%
 ${SHARE_DATA_RULE}Fill the card as completely as the Primary Report page allows: read the whole page and include every supported metric from the base labels, a trend line for market volume or units, a Share line, a Segment Breakdown, Key Players and Market Share whenever the page publishes them. Aim for 8 to 11 lines, never fewer than 7 unless the page really has less. Include Segment Breakdown, Key Players and Market Share only when the report actually publishes that data. Omit any metric the report does not support. Never fabricate.)

Key Qualitative Insights for Image 2
(up to three lines, each optional, omitted when the report does not support it: "Growth Drivers: " followed by 3 or 4 short phrases separated by semicolons, most important first; "Competitive Landscape: " followed by "Name X%" items separated by commas; "Regional Landscape: " followed by "Region X%" items separated by commas. Do not repeat base value, forecast or CAGR here. The charts need figures: whenever the Primary Report page publishes shares for providers or regions, copy them exactly as "Name X%". Give provider names alone only when the page publishes no shares, and never estimate a share.)

FINAL ARTICLE
(ONE complete, clean HTML article that follows the ARTICLE FORMAT above. It starts with the h1. No code fences. No link map, source map or any table or list describing links.)

Before you answer, silently check: every Ken Research is bold; every meaningful number is bold; the link plan holds (1 homepage, 4 adjacent Ken Research reports, 1 Primary Report only in the final paragraph, 3 government sources, at most one link per paragraph or item, so no paragraph holds two links; no link in a heading); all external links are government pages you opened; every date, launch, regulation and company event is verified on the report page or an official page, otherwise removed; no em dash, no table; exactly two image placeholders in the places the format allows; the length is inside the format's band; no unsupported figure.`;

const FORMATS: readonly BlogFormat[] = [
  {
    id: 'f-exec-brief',
    label: 'Executive Brief',
    summary: 'Short, scannable brief of 900 to 1,100 words: opening paragraph, a Key-takeaways bullet list, 4 to 5 statement H2s with one paragraph each, no H3s.',
    spec: `ARTICLE FORMAT: EXECUTIVE BRIEF
Reader: a busy decision-maker who wants the answer in two minutes.
Length: 900 to 1,100 words. This is deliberately short; do not pad.
Shape, in this order:
1. H1 that states the thesis.
2. One opening paragraph of 2 to 3 sentences (under 60 words) with the thesis and the homepage link.
3. The first image placeholder.
4. A bullet list (ul) of exactly 4 takeaways straight after the image, with no heading above it. Each bullet starts with a bold figure, then what it means, under 35 words. One of them may carry the first adjacent report link.
5. Four or five H2s, written as statements that carry a verified finding or number (not questions). Each H2 section is ONE paragraph of 70 to 95 words. Two of the sections add a bullet list of 3 short implications after the paragraph. No H3s anywhere.
6. The second image placeholder inside the third H2, after its paragraph.
7. The last H2 is forward-looking and decision-driving, with a short paragraph and then the single call-to-action paragraph holding the Primary Report link.
Tone: dense and direct. Every sentence earns its place.`,
  },
  {
    id: 'f-qa-knowledge',
    label: 'Q&A Knowledge Article',
    summary: 'Question-led article of 1,400 to 1,700 words: 7 to 9 question H2s, each opening with a direct answer under 35 words, short paragraphs, almost no lists.',
    spec: `ARTICLE FORMAT: Q&A KNOWLEDGE ARTICLE
Reader: someone asking an AI assistant or a search engine specific questions about this market.
Length: 1,400 to 1,700 words.
Shape, in this order:
1. H1 phrased around the market and its central question or thesis.
2. An opening of 2 to 3 sentences that give the short answer to the central question, with the homepage link in the first sentence. Then the first image placeholder.
3. Seven to nine H2s, EVERY one phrased as a real question a buyer, analyst or executive would ask (size and growth, drivers, segments, competitors, regulation, pricing or economics, risks, what to do). Order them from "how big" to "what should I do".
4. Under every H2: first a direct, complete answer of at most 35 words (with the verified figure), then one or two short supporting paragraphs of 40 to 70 words that add mechanism and implication. No H3s. Use at most one bullet list in the whole article.
5. The second image placeholder inside the fifth or sixth H2, after its answer.
6. The last H2 is "what should [buyers, investors or operators] do next" in this market, ending with the single call-to-action paragraph holding the Primary Report link.
Each answer must stand alone: never write "as mentioned above".`,
  },
  {
    id: 'f-deep-dive',
    label: 'Deep-Dive Analysis',
    summary: 'Long analytical piece of 1,900 to 2,300 words: three-paragraph intro, 7 to 8 statement H2s, H3 sub-sections in the main ones, long paragraphs, at most 3 lists.',
    spec: `ARTICLE FORMAT: DEEP-DIVE ANALYSIS
Reader: an analyst or strategist who wants the full argument with its evidence.
Length: 1,900 to 2,300 words.
Shape, in this order:
1. H1 that states the thesis.
2. An introduction of three paragraphs: the thesis and what the numbers show (homepage link here), what the headline figure counts (scope, currency, year) and, if published third-party estimates differ by more than about 2x, one sentence on why, and why it matters now (first adjacent report link here). Then the first image placeholder.
3. Seven or eight H2s written as statements that carry a verified finding or number. About half may be questions; the rest are declarative.
4. One H2 covers drivers and restraints as two short bullet lists. Each bullet starts with a bold driver or restraint name, then a bold impact label (High, Medium or Low) and a bold horizon (near term, or a year), then one sentence on the mechanism. Impact labels are your analysis, labelled as such.
5. The four largest sections each contain two or three H3 sub-sections with short descriptive noun-phrase headings. The other sections have no H3s.
6. Paragraphs of 4 to 5 sentences (90 to 130 words). Use at most four bullet lists in the whole article (the drivers and restraints lists count).
7. In three sections add one short paragraph that starts with a bold "Analysis:" and gives an original, derived insight.
8. One section is a counter-thesis: the strongest case against the forecast, tested against the evidence.
9. The second image placeholder inside a middle or lower section, after a paragraph.
10. The last H2 is forward-looking and decision-driving, with a closing paragraph and then the single call-to-action paragraph holding the Primary Report link.`,
  },
  {
    id: 'f-playbook',
    label: 'Playbook / Checklist',
    summary: 'Step-based playbook of 1,300 to 1,600 words: 5 to 6 numbered "Step N" H2s, each with one paragraph, a 3-item action list and a bold Watch-out line, then a 30/60/90-day list.',
    spec: `ARTICLE FORMAT: PLAYBOOK
Reader: an operator, investor or buyer deciding how to act in this market.
Length: 1,300 to 1,600 words.
Shape, in this order:
1. H1 that names the market and the outcome, for example how to enter, evaluate or invest in it.
2. One opening paragraph (problem, thesis, the key figure) with the homepage link. Then the first image placeholder.
3. Five or six H2s, each starting "Step 1:", "Step 2:" and so on, followed by a verb-led action naming the market or geography. No question headings.
4. Every step has: one paragraph of at most 80 words explaining why, anchored on a verified figure; then a bullet list of exactly 3 concrete checks or actions, each beginning with a verb; then one sentence that begins with a bold "Watch out:" and names a verified risk or constraint. No H3s.
5. The second image placeholder inside step 3, after its paragraph.
6. A final H2 about the first 30, 60 and 90 days, written as an ordered list (ol) of 4 to 5 actions that follow from the steps, then the single call-to-action paragraph holding the Primary Report link.
Every action must be grounded in the evidence. Do not invent regulations, deadlines or prices.`,
  },
  {
    id: 'f-roadmap',
    label: 'Roadmap (time horizons)',
    summary: 'Time-structured article of 1,200 to 1,500 words: an "at a glance" list, then H2s by horizon (now, next 12 to 24 months, forecast window, signals, what to do), two short paragraphs each.',
    spec: `ARTICLE FORMAT: ROADMAP
Reader: a planner who thinks in time horizons.
Length: 1,200 to 1,500 words.
Shape, in this order:
1. H1 that includes the forecast window.
2. One opening paragraph of 2 to 3 sentences with the homepage link, then a bullet list (ul) of 4 "at a glance" bullets, each starting with a bold figure: the base value, the forecast value, the CAGR and the main driver. Then the first image placeholder.
3. H2 sections organised by horizon, in this order: where the market stands in the base year; what changes over the next 12 to 24 months; the full forecast window and what has to go right; signals that would change the outlook; what to do now. Headings are statements that name the market and the horizon. Anchor the "where the market stands" section on verified, dated developments from the report page or official sources, each with its date; if none can be verified, anchor it on the base-year position and say so.
4. Each section has two paragraphs of 60 to 90 words, except the signals section, which is one short paragraph and a bullet list of 4 specific signals a reader can track.
5. The second image placeholder inside the forecast-window section, after its second paragraph.
6. The "what to do now" section is the close, ending with the single call-to-action paragraph holding the Primary Report link.
Only the report's own base value, forecast and CAGR anchor the numbers; do not invent intermediate-year figures.`,
  },
  {
    id: 'f-myth-evidence',
    label: 'Myth vs Evidence',
    summary: 'Contrarian format of 1,300 to 1,600 words: 3 to 4 H2s that each test a common assumption, an evidence paragraph then 3 implication bullets, plus a summary H2.',
    spec: `ARTICLE FORMAT: MYTH VS EVIDENCE
Reader: someone holding a common assumption about this market who should check it against data.
Length: 1,300 to 1,600 words.
Shape, in this order:
1. H1 that states the corrected picture as a thesis.
2. One opening paragraph naming the headline figure and the assumption it complicates, with the homepage link. Then the first image placeholder.
3. Three or four H2s. Each H2 is a widely repeated assumption about this market, written as a short statement beginning "Myth:" followed by the verified correction in the same heading. Choose only assumptions the report or a government source can genuinely test; never invent a belief or attribute it to a named person or company. Good candidates are: who the product or sector is regulated by, how big the market really is when published estimates disagree, who the leading players are, and where growth comes from. When official bodies disagree with each other, show each body's position separately and attribute it by name.
4. Under each H2: first a paragraph that opens with the verified answer and the figure ("What the evidence shows"), then one paragraph on why the assumption persists or where it is partly true, then a bullet list of exactly 3 implications for buyers or operators. No H3s.
5. The second image placeholder inside the second H2, after its first paragraph.
6. A final H2 that gives the accurate overall picture and the decision it supports, ending with the single call-to-action paragraph holding the Primary Report link.`,
  },
  {
    id: 'f-comparison',
    label: 'Comparison (A vs B)',
    summary: 'Comparison format of 1,400 to 1,700 words: a paired at-a-glance list, three axis H2s with Where-A-wins and Where-B-wins paragraphs, and a decision rule. No tables.',
    spec: `ARTICLE FORMAT: COMPARISON
Reader: a buyer or investor choosing between two segments, channels, products or geographies inside this market.
Length: 1,400 to 1,700 words.
Shape, in this order:
1. H1 in the form "[A] vs [B]" with the market named, covering the contrast the report supports best: two segments, two channels, two regions, this country against one or two comparable jurisdictions, or two official positions on the same question. Use only contrasts the report or a government source can support.
2. One opening paragraph with the thesis and the homepage link. Then the first image placeholder.
3. An H2 for the comparison at a glance, made of a bullet list of 4 paired bullets. Each bullet starts with a bold dimension, then "A: ..." and "B: ..." in one sentence each. No table.
4. Three H2s, one per axis of comparison (for example growth, economics, risk), written as "[Axis]: [A or B]?" with a verified finding. In each: an opening answer sentence, then a paragraph that begins with a bold "Where A wins:" and a paragraph that begins with a bold "Where B wins:". Both sides get comparable depth and no strawman.
5. The second image placeholder inside the second axis H2, after its first paragraph.
6. A final H2 with the decision rule: which to prioritise for which kind of buyer, and the single call-to-action paragraph holding the Primary Report link.`,
  },
  {
    id: 'f-scenarios',
    label: 'Scenarios (base, upside, downside)',
    summary: 'Scenario format of 1,300 to 1,600 words: base-case and what-must-go-right H2s, then one H2 with three H3 paths (base, upside, downside) each with signals to watch.',
    spec: `ARTICLE FORMAT: SCENARIOS
Reader: a planner who needs to see how the forecast could play out.
Length: 1,300 to 1,600 words.
Shape, in this order:
1. H1 stating the forecast and the uncertainty around it.
2. One opening paragraph with the base forecast and the homepage link. Then the first image placeholder.
3. An H2 for the base case: the forecast value, the CAGR and the period, in two paragraphs.
4. An H2 for what must go right for the base case to hold, in two paragraphs. The second image placeholder goes after its second paragraph.
5. An H2 for the paths to the end of the forecast window, containing exactly three H3s: the base path, the upside path and the downside path. Each H3 has one paragraph of about 70 words and a bullet list of 3 signals to watch. Scenarios are QUALITATIVE and sit around the report's own forecast and CAGR. Name the real drivers of each path where they can be verified: pending legislation, regulator rulings or consultations, funding, infrastructure projects, import dependence. Do not invent scenario numbers or probabilities.
6. An H2 on the signals a buyer should track now (one paragraph, no list).
7. The last H2 is decision-driving, ending with the single call-to-action paragraph holding the Primary Report link.`,
  },
  {
    id: 'f-estimate-reconciliation',
    label: 'Estimate Reconciliation',
    summary: 'Explainer of 1,300 to 1,600 words on why published estimates of this market differ: the range up front, what each estimate counts, why they diverge, which figure fits which decision, what would settle it.',
    spec: `ARTICLE FORMAT: ESTIMATE RECONCILIATION
Reader: an analyst, investor or planner who has seen different market sizes for this market and needs to know which to use.
Length: 1,300 to 1,600 words.
Research first: find the other published estimates of this market (and of the closest adjacent definition) that you can open, and read the stated scope, base year and currency of each. Compare them with the Primary Report. If you cannot find any other published estimate, do not invent one: say plainly that no comparable published estimate was found, explain exactly what the Primary Report counts, and use official statistics as the cross-check instead.
Shape, in this order:
1. H1 that frames the question, for example "Why Do [Market] Size Estimates Differ?" with the market and geography named.
2. One opening paragraph of 40 to 70 words that states the range of published estimates (only figures you verified, each with its year), the main reason they differ, and the homepage link. Then the first image placeholder.
3. An H2 on what each estimate counts. A bullet list of 3 to 5 bullets: the Primary Report first, then the other published estimates described as "another published estimate" (never name or link a competing research firm). Each bullet starts with a bold figure and year, then what it covers (scope, currency, base year) in one sentence.
4. An H2 on why the numbers diverge. Two or three short paragraphs, one cause each, taken only from what the sources show: scope and definition, base year and currency, and method or coverage of the channel. Do not guess at a cause you cannot see in the sources.
5. The second image placeholder inside that H2, after its second paragraph.
6. An H2 on which figure fits which decision: a short decision rule for sizing a business case, screening an investment and checking a regulatory or budget figure. Do not declare one estimate wrong unless a stated definition proves it.
7. An H2 on what would settle it: the official statistics, filings or trade data that would narrow the range, with the government source linked where you opened it. End with one forward-looking paragraph and then the single call-to-action paragraph holding the Primary Report link.
Tone: neutral and precise. The article earns trust by showing its basis, not by claiming the Primary Report is right.`,
  },
  {
    id: 'f-regulatory-explainer',
    label: 'Regulatory Explainer',
    summary: 'Question-led explainer of 1,300 to 1,700 words on whether and how the market is regulated: the answer up front, what the law says, where official positions differ, what is changing, what it means for operators.',
    spec: `ARTICLE FORMAT: REGULATORY EXPLAINER
Reader: an operator, investor or buyer asking "is this regulated here, and what changes for me?"
Length: 1,300 to 1,700 words.
Research first: identify the governing law, the regulators and any official statements on this market, and open them. Use the report page for the market context. Never state a legal conclusion beyond what an official source says. Quote a section or article number only if you opened the text and saw it.
Shape, in this order:
1. H1 phrased as the question, for example "Is [Product or Sector] Regulated in [Country]?"
2. One opening paragraph of 40 to 70 words that answers directly (yes, no or partly), names the governing law and regulator, says where official positions differ if they do, and carries the homepage link. Then the first image placeholder.
3. An H2 on what the law and regulators say: the statute, the regulator and each official position, attributed by name, with one government link per paragraph where you opened the source.
4. An H2 on where positions differ or the law is silent: each body's view stated separately and fairly, and the practical grey area for operators.
5. An H2 on what is changing: pending bills, consultations, rulings and reporting requirements, each with its date only if verified. The second image placeholder goes inside this H2, after its first paragraph.
6. An H2 on what it means for operators and buyers: compliance cost, product design, partnerships and market entry, tied to the report's market figures.
7. An H2 on what to watch next: three or four concrete signals (a named bill stage, a regulator deadline, a court or ombud decision) that would change the picture.
8. The last H2 is decision-driving. Add one plain sentence that this is market analysis and not legal advice, then the single call-to-action paragraph holding the Primary Report link.
If the market has no meaningful regulation to report, say so in the opening and keep the article short; do not manufacture regulatory detail.`,
  },
  {
    id: 'f-niche-brief',
    label: 'Niche Market Brief',
    summary: 'Evidence-labelled brief of 1,100 to 1,400 words for markets with thin published coverage: what the report measures, what official data shows, supply-side signals, what is unknown, how to use the numbers.',
    spec: `ARTICLE FORMAT: NICHE MARKET BRIEF
Reader: a decision-maker looking at a narrow market where little exact-match data is published.
Length: 1,100 to 1,400 words.
Research first: open the Primary Report page, then look for official data on the market or its closest proxy (customs and trade statistics, production or import data, regulator filings, official project announcements). Note what exists and what does not.
Shape, in this order:
1. H1 that names the market and signals an honest brief, for example "[Market]: What the Data Shows and What It Does Not".
2. One opening paragraph of 40 to 70 words with the headline figure, what it counts, and one sentence that exact-match published coverage is thin, plus the homepage link. Then the first image placeholder.
3. An H2 on what the report measures: market size, forecast, segments and the stated base year. Start the key sentences with the bold label "Reported:".
4. An H2 on what official data shows: trade, production or import figures and regulatory context from government pages you opened (one link per paragraph). Start the key sentences with the bold label "Official:". The second image placeholder goes inside this H2, after its first paragraph.
5. An H2 on supply-side signals: plants, investments, licences or projects that you verified, each with its date and source. If none can be verified, say so in one sentence instead of filling the section.
6. An H2 on what is still unknown: the specific data gaps and how large an error they could cause. Start the key sentences with the bold label "Inferred:" for any reasoning that goes beyond the data, and keep every inference to arithmetic or logic on stated figures.
7. An H2 on how to use these numbers: what a buyer or investor can rely on, what to treat as a range, and the first check to run. End with the single call-to-action paragraph holding the Primary Report link.
The three bold labels (Reported, Official, Inferred) are the structure of the article: never present an inference as reported or official.`,
  },
];

export const BLOG_FORMATS = FORMATS;

export function buildFormatPrompt(format: BlogFormat): string {
  return [FIXED_RULES, '', format.spec, '', OUTPUT_CONTRACT, ''].join('\n');
}
