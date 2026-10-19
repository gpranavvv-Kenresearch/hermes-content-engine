/**
 * blogGenAgent.ts — generate a full blog article by driving the user's own
 * logged-in ChatGPT session (not an API call). ChatGPT does its own research
 * against the report URL, verifies its data, and assembles a publication-ready
 * article per the master SERP/AI-citation prompt below.
 *
 * Generation takes ~12-15 minutes per article — this is not a fast path.
 *
 * Launches its OWN persistent Chrome context per call (does not go through
 * browser/chatgpt/login.ts's shared single-browser singleton) — that's what
 * lets this run at the same time as blogImageAgent.ts's cover-image
 * generation in a second, independent Chrome window, instead of the two
 * fighting over one shared browser/page.
 *
 * Usage:
 *   const result = await generateBlogViaChatGpt({ title: row.title, url: row.targetUrl });
 *   // result: { title, description, html }
 */

import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import { sessionDirForAccount } from '../config/chatGptAccountTracker.js';
import { killChromeForProfile } from '../utils/killChrome.js';
import { pasteIntoChatGptComposer, attachPromptAsTextFile, dismissBlockingModals } from '../utils/chatgptComposer.js';
import { recordChatGptFailure, recordChatGptSuccess } from '../config/chatGptAccountTracker.js';
import { injectUTM, UTM_PARAMS } from '../utils/utm.js';

// Matches both the old #prompt-textarea id and the new UI's bare
// div.ProseMirror composer (no id) — see the comment on the canonical
// definition in src/browser/chatgpt/login.ts for the full explanation.
const COMPOSER_SELECTOR = '#prompt-textarea, div[contenteditable="true"].ProseMirror';
const SEND_BUTTON_SELECTOR = 'button[data-testid="send-button"], button[aria-label="Send prompt"]';
const STOP_BUTTON_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop streaming"], button[aria-label*="Stop"]';
// ChatGPT's UI redesign (confirmed live 2026-09-26) dropped the
// data-message-author-role attribute entirely — the assistant's rendered
// markdown now lives in a div[data-markdown-text-style="assistant-message"]
// instead, found by walking up from a live "PONG" test reply. Match both,
// comma-separated, same as COMPOSER_SELECTOR above.
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]';

// Blog TEXT generation now shares the same ChatGPT account/session as the
// LI carousel image generator (socialPostImageAgent.ts's DEFAULT_ACCOUNT) —
// both resolve through sessionDirForAccount('social-image'), same session
// folder. Kept separate from blogImageAgent.ts's own default account (below)
// so blog text + cover image still run in separate Chrome profiles/windows
// concurrently; login once via: npx tsx src/tools/loginChatGpt.ts social-image
const DEFAULT_BLOG_ACCOUNT = 'social-image';

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Blog generation is slow (~5-15 min, varies) — no way to know in advance
// how long a given article will take, so just poll once a minute and stop
// as soon as completion is detected, capped at MAX_POLLS as a hard ceiling.
const POLL_MS = 60 * 1000; // check every 1 min
const MAX_POLLS = 15; // 15 checks * 1 min = 15 min total hard cap

/**
 * Ken Research Market Blog Master Prompt V1.3 — replaces the old
 * SERP/AI-citation 7-section prompt (2026-09-18). Self-contained: no
 * reference article, ChatGPT independently determines thesis/structure/H2s,
 * researches the report + adjacent Ken Research reports + external sources
 * itself, and returns a structured deliverable (SEO Title, Meta Description,
 * search-intent metadata, Key Snapshot Metrics, Internal Link Map, External
 * Source Map, then the FINAL ARTICLE as clean HTML) instead of the old
 * single "Description:" line + bare HTML fragment.
 */
function buildKenResearchMasterPromptV1_3(reportTitle: string, reportUrl: string): string {
  return `You are a senior market-intelligence editor, SEO strategist, AIO/GEO content architect, fact-checker, research analyst, internal-link strategist, and HTML publishing specialist working for Ken Research.

Your task is to research and create ONE final, publication-ready, platform-neutral market-intelligence article using only the inputs supplied below.

You are NOT given a reference article.

You must independently determine:

the strongest editorial thesis

the most appropriate article structure

the best H2/H3 hierarchy

the right balance of paragraphs, bullets and callouts

the most useful internal links

the most authoritative external sources

the most decision-relevant market insights

Do NOT ask for:

a sample blog

a reference article

competitor content

target platform

preferred structure

previous article

writing example

This prompt is self-contained.

Report Title:
${reportTitle}

Market Name:
${reportTitle}

Primary Report URL:
${reportUrl}

Optional Primary Keyword:


Optional Secondary Keywords:


Create a premium, research-led article that:

Provides genuine market intelligence.

Is useful to business decision-makers.

Is suitable for Google organic search.

Is structured clearly for AI search, AI Overviews, retrieval and citation.

Demonstrates real information gain.

Uses Ken Research proprietary data accurately.

Clearly separates proprietary estimates from official statistics.

Uses credible external evidence.

Uses natural, well-spaced internal linking.

Avoids keyword stuffing.

Avoids excessive promotion.

Avoids generic AI wording.

Avoids one-line paragraph fragmentation.

Avoids paragraph-only walls of text.

Uses useful H2s, H3s, bullets and limited callouts.

Includes a meaningful counter-thesis/risk view.

Can be published directly as clean HTML.

Does NOT require a reference article.

The final article should feel like:

MARKET RESEARCH
+
BUSINESS ANALYSIS
+
EDITORIAL INSIGHT
+
SEO QUALITY
+
AI-SEARCH READABILITY
+
SOURCE TRANSPARENCY

It must NOT feel like:

KEYWORD PAGE
+
GENERIC TEMPLATE
+
SALES LANDING PAGE
+
AI FILLER

Start with the supplied Primary Report URL.

Research the Ken Research website and determine whether a newer/current version of the same market or data framework exists.

Extract only supported information such as:

publication date

study period

historical period

base year

forecast period

market value

forecast value

CAGR

historical growth

physical volume

transaction count

subscribed units

project count

installed base

ASP / ARPU / value per unit

dominant segment

fastest-growing segment

dominant geography

fastest-growing geography

deployment/channel/business model

customer type

growth mechanisms

operating economics

risks

competitive participants

regulatory considerations

methodology

respondent/sample count

market-sizing basis

supporting metrics

Never invent a number because a field is missing.

If several Ken Research pages contain different figures for the same market:

Compare publication dates.

Identify the newest complete dataset.

Prefer the newest reliable framework.

Use ONE internally consistent dataset.

Do NOT mix old and new values.

Use the newest relevant report URL when appropriate.

Do not confuse readers with obsolete values unless the comparison itself is analytically important.

Treat Ken Research market figures as proprietary estimates unless explicitly identified otherwise.

Never present proprietary estimates as government statistics.

Research approximately 2–4 authoritative external sources.

The final article normally needs only 2–3 external links.

Priority:

Government ministry

National statistics office

Regulator

Central bank

Customs/trade authority

Transport/port authority

Official industry body

Primary company disclosure

Highly credible institutional source

External evidence may validate:

regulation

trade

infrastructure

demographics

payments

transport activity

internet usage

policy

technology adoption

government programs

customs

company infrastructure investments

Do not add external links merely to increase source count.

Every sourced statistic must retain the correct:

year

unit

geography

population/sample where relevant

context

Before writing, determine:

"What is actually changing in this market, and why does it matter commercially?"

Do NOT default to:
"The market is growing because demand is increasing."

Look for the strongest mechanism.

Examples:

basic service shifting toward advanced analytics

recurring revenue replacing transaction revenue

value growth exceeding volume growth

digital channel changing distribution economics

cloud changing cost structures

regulation creating demand

premiumization offsetting demographic weakness

outsourcing raising service intensity

automation improving productivity

infrastructure constraining demand

affordability weakening real growth

fragmented competition favoring integrated players

local sourcing reducing import risk

e-commerce increasing logistics intensity

data governance becoming a buying criterion

The article must be built around the strongest supported thesis.

Before writing, silently create THREE possible editorial structures.

Do NOT output them.

The three structures must differ in:

central thesis

opening angle

H2 sequence

H2 wording

H3 usage

section grouping

position of competition

position of regulation

position of geography

position of segment analysis

treatment of risk

bullet usage

callout placement

Evaluate the 3 structures based on:

Which best explains the actual economics?

Which surfaces proprietary information most effectively?

Which provides the most information gain?

Which is most useful to decision-makers?

Which avoids generic market-report templating?

Which creates the strongest SEO/AIO structure?

Select ONE.

Output ONE final article only.

Do NOT generate every article with the same flow.

Do NOT mechanically use:

Market Size
→ Drivers
→ Segments
→ Competition
→ Regulation
→ Outlook

Different industries should naturally produce different architectures.

For example:

TECH / SaaS / CYBERSECURITY may emphasize:

recurring revenue

cloud

adoption

talent

automation

integration

compliance

LOGISTICS may emphasize:

trade flows

corridor economics

utilization

freight

warehousing

outsourcing

infrastructure

FMCG / RETAIL may emphasize:

consumer demand

basket economics

pricing

distribution

channel mix

affordability

sourcing

HEALTHCARE may emphasize:

disease burden

access

reimbursement

regulation

capacity

adoption

pricing

LUXURY / FASHION may emphasize:

affluent demand

tourism

price mix

product categories

digital channels

import exposure

AGRICULTURE may emphasize:

yield

farm economics

input costs

technology

water

infrastructure

climate

regulation

CONSTRUCTION may emphasize:

project pipeline

capex

permits

materials

labor

financing

infrastructure

The exact headings must be written for the specific industry.

QUALITY RULES remain fixed even when structure changes.

Avoid generic/repetitive H2s such as:

Growth Drivers
Key Trends
Market Opportunities
Competitive Landscape
Market Analysis

Prefer analytical headings.

Examples:

Instead of:
"Growth Drivers"

Use:
"Fuel Economics Are Making Analytics Easier to Justify"

Instead of:
"Competitive Landscape"

Use:
"Competition Is Moving From Devices to Analytics Capability"

Instead of:
"Key Trends"

Use:
"Cloud Delivery Is Lowering the Barrier to Adoption"

Headings should communicate an insight.

Do not repeatedly reuse the same H2 wording across different reports.

Generate before the article:

SEO Title

SEO TITLE ROLE:
The SEO Title is the search-facing title. Its job is to preserve strong market/entity relevance while adding a distinctive, report-specific commercial angle.

MANDATORY SEO TITLE RULES:

- Retain the recognizable core Market Name / primary market entity in the SEO Title.
- Do NOT rewrite the market name so aggressively that the main search entity becomes unclear.
- Keep the market/entity phrase prominent, preferably at or near the beginning.
- Make the second half dynamic and based on the strongest VERIFIED commercial thesis in the report.
- The SEO Title must be unique, punchy, search-intent aligned, and useful rather than generic.
- The SEO Title must be meaningfully different from the H1.
- Do NOT include "Ken Research" in the SEO Title by default.
- Do NOT mechanically use generic formulas such as:
  "[Market Name] Size, Share, Trends & Forecast"
  unless that wording is genuinely required by the search intent.
- Do NOT force a rigid character limit if doing so damages the market entity or meaning.
- Keep the title as concise as the market name allows; prioritize entity clarity, search relevance and click appeal over arbitrary character-count compliance.
- Do NOT invent an angle merely to make the title sound dramatic.
- Every thesis used in the SEO Title must be supported by the researched market evidence.

DYNAMIC SEO TITLE FAMILIES:

Choose or create the pattern that best fits the report. Examples include:

- [Market Name] Enters a Higher-Value Growth Phase
- [Market Name] Shifts From [Old Model] to [New Model]
- [Market Name] Moves Toward [Important Commercial Shift]
- [Market Name]: Growth Beyond [Old Growth Mechanism]
- [Market Name] Builds a Stronger [Revenue / Channel / Technology] Story
- [Market Name] Expands Beyond [Traditional Category / Channel]
- [Market Name]: [Emerging Segment] Reshapes Growth
- [Market Name] Moves Into a [New Economics]-Led Phase
- [Market Name] Targets [Commercial Outcome] Through [Forecast Year]
- [Market Name]: [Key Metric / Behavior] Becomes the New Driver

These are style families, NOT fixed templates.
Do NOT mechanically reuse them.
Create a new phrasing when the market evidence suggests a better angle.

Example:

Market Name:
Poland Online Food Delivery Aggregator Market

Strong SEO Title:
Poland Online Food Delivery Aggregator Market Shifts From Reach to Revenue

Another valid style:
Poland Online Food Delivery Aggregator Market: Growth Beyond User Acquisition

Meta Description

approximately 140–160 characters

useful

non-promotional

include core figure(s) when valuable

Plain text only — no HTML tags, no <strong>, no Markdown bold/links, no formatting of any kind. Numbers and figures appear as plain digits (e.g. "USD 63 million", not "<strong>USD 63 million</strong>").

Also generate:

Primary Search Intent

Primary Keyword

5–8 Secondary Semantic Topics

Suggested Snapshot Image Alt

Use exactly ONE H1.

H1 ROLE:
The H1 is the editorial headline. It should be more expressive, insight-led and attention-grabbing than the SEO Title while still making the market/topic immediately understandable.

MANDATORY H1 RULES:

- The H1 must be meaningfully different from the SEO Title.
- The H1 must preserve a recognizable market/topic reference, but it does NOT need to repeat the complete formal Market Name word-for-word if a shorter natural expression is clearer.
- The H1 must include <strong>Ken Research</strong> naturally.
- The H1 should communicate the strongest VERIFIED market tension, milestone, opportunity, risk, transformation or strategic question.
- A verified market value / forecast / milestone may be used when it materially strengthens the headline.
- If a visible number appears in the HTML H1, apply the existing mandatory number-bolding rule.
- Do NOT invent a risk, barrier, opportunity or numerical milestone for headline impact.
- The headline may be longer than the SEO Title when editorial clarity requires it.
- Avoid robotic keyword repetition.
- Avoid repeating the same H1 grammar across different reports.
- Do NOT automatically use "Tracks", "Flags", "Hits", "Nears", or any other single verb in every article.
- Vary the editorial construction according to the report and industry.

ALLOWED H1 APPROACHES:

1. QUESTION / STRATEGIC-TENSION STYLE

Use when the report supports a genuine strategic question.

Example:

<h1>Can Poland's Food Delivery Platforms Turn Reach Into Revenue Quality? <strong>Ken Research</strong> Tracks the <strong>USD 2.03B</strong> Opportunity</h1>

2. MILESTONE + BARRIER / RISK STYLE

Use when a forecast milestone and a meaningful constraint are both strongly supported.

Example:

<h1>Thailand Agri-Equipment Rental Market Hits <strong>USD 1B</strong>: <strong>Ken Research</strong> Flags Service Reliability as the Bigger Loyalty Barrier</h1>

3. TRANSFORMATION STYLE

Example logic:

[Market / Industry] Moves From [Old Model] Toward [New Model]: <strong>Ken Research</strong> Examines What Changes the Economics

4. OPPORTUNITY + EXECUTION STYLE

Example logic:

[Market / Industry] Opens a New [Opportunity] Layer: <strong>Ken Research</strong> Highlights the Execution Test

5. COMMERCIAL-TENSION STYLE

Example logic:

[Market / Industry] Growth Accelerates, but [Constraint] Changes the Economics: <strong>Ken Research</strong> Maps the Trade-Off

IMPORTANT:

- Question-style H1s are allowed but NOT mandatory.
- Use a question only when it creates a genuine decision-oriented tension.
- Do NOT make every H1 a question.
- Do NOT use the same H1 family repeatedly across consecutive reports.
- The H1 must feel written for the specific market, not filled into a headline template.
- SEO Title = search-led and market-entity-led.
- H1 = editorial, branded, insight-led.
- They must complement each other rather than repeat each other.

Use 2–3 proper introductory paragraphs.

Normal paragraph:

2–4 sentences

usually 45–110 words

one coherent analytical idea

Paragraph 1 should establish:

market identity

market change

base value

forecast value

CAGR

Paragraph 2 should explain:

why the market is changing

why that mechanism matters commercially

Paragraph 3 (required — this is the second interlinking placement, paragraph 1's Ken Research homepage link being the first):

major risk

counter-thesis

operating tension

Include exactly one contextual link to a genuinely relevant adjacent Ken Research report here (same verification and UTM rules as every other adjacent-report link — see LINK ARCHITECTURE below). This becomes "Adjacent #1" — do not also place a separate first-adjacent link in the early H2 section; the early/early-middle H2 instead carries "Adjacent #2", the middle H2 carries "Adjacent #3", and so on, each one slot further down the sequence than before.

Do NOT link the Ken Research homepage a second time here — paragraph 1 already used that single mandatory homepage placement. This paragraph's link is a different, topic-relevant adjacent report, not a repeat of the homepage.

Within roughly the first 150 words the reader should understand:

what the market is

current/base value

forecast direction

why it is changing

Within the first 200–250 words, naturally include one concise market-scope sentence where useful.

Explain what the market includes and, where relevant, excludes.

Use only the primary report's supported scope.

Do not invent categories.

Do not write it like a dictionary definition.

The first natural occurrence of Ken Research must link exactly once to:

https://www.kenresearch.com/

Required format:

<a href="https://www.kenresearch.com/">
  <strong>Ken Research</strong>
</a>

Purpose:

brand attribution

publisher identity

research provenance

Rules:

homepage link exactly once

do not repeat homepage later

do not add "Visit Ken Research"

do not use homepage as CTA

later Ken Research mentions remain bold but unlinked

The Primary Report URL must normally be linked ONLY ONCE in the FINAL ARTICLE,
inside the final commercial CTA.

Do NOT link the Primary Report URL in the introduction.

The first important market-name mention in the introduction should remain
plain text or may be bold if editorially useful, but it must NOT carry
the Primary Report URL.

Purpose:

prevent duplicate primary-report linking

reduce promotional density

avoid two Ken Research-domain links appearing together in the introduction

preserve the final CTA as the primary conversion point

Normal architecture:

INTRODUCTION:

Ken Research homepage branding link only

BODY:

contextual adjacent-market links

FINAL CTA:

Primary Report link

Do not repeat the primary-report URL elsewhere in the article unless an
exception is explicitly required by the user.

EVERY visible occurrence of:

Ken Research

must be:

<strong>Ken Research</strong>

If linked:

<a href="https://www.kenresearch.com/">
  <strong>Ken Research</strong>
</a>

Never leave visible Ken Research unbolded.

Every meaningful visible number must be bold.

Examples:

<strong>USD 63 million</strong>

<strong>2025</strong>

<strong>13.6%</strong>

<strong>160,000 vehicles</strong>

<strong>58%</strong>

<strong>216 respondents</strong>

<strong>5–7 years</strong>

<strong>2025–2032</strong>

Applies to:

market values

years

ranges

percentages

currency

volumes

counts

units

shares

ASP

ARPU

transaction counts

subscriber counts

respondent counts

external statistics

Do NOT bold numbers inside:

URLs

HTML attributes

image dimensions

tracking parameters

code

After the introduction include ONE snapshot-image placeholder, and include a SECOND image placeholder further down the article — in the middle or lower section, after the drivers/competitive-landscape discussion and before the conclusion.

Do NOT create an HTML table.

Use exactly these tags — a bare img with only src and alt, nothing else (no <figure>, no <figcaption>, no width/height/loading attributes, no caption text of any kind):

<img src="YOUR_IMAGE_URL_HERE" alt="[DESCRIPTIVE ALT]">

<img src="YOUR_IMAGE_URL_HERE_2" alt="[DESCRIPTIVE ALT]">

Choose approximately 5–7 supported metrics for the base set below, PLUS any of the optional multi-value fields (Segment Breakdown, Key Players, Market Share) whenever the report actually publishes that data — these feed a downstream chart generator that renders each metric as a real chart (donut, gauge, bar comparison), so the EXACT field name and value format below must be followed. Never fabricate a metric or a value to fit a format — omit the field entirely if the report does not support it.

Base set — plain "Label: Value" line, one metric per line:

Base Market Value

Forecast Value

CAGR

Market Volume / Units

Leading Segment

Fastest-Growing Segment

Dominant Geography

Major Driver

Major Constraint

MANDATORY VALUE FORMATS (the chart generator parses these patterns literally):

Trend metric (renders as a bar-comparison chart) — value is two or three chronological points joined by " → ", each ending in "in {year}":
Completed Orders: 3.8 million in 2025 → 8.5 million in 2031
Revenue per User: USD 12 in 2025 → USD 15.5 in 2028 → USD 19 in 2031

Share metric (renders as a donut) — label must contain the word "Share" (not "Breakdown") and the value must end in a percentage:
Fresh-Food Share: 41.0% in 2025

Segment Breakdown (renders as a multi-slice donut) — label exactly "Segment Breakdown", value is a comma-separated "Name X%" list (3–5 segments, should sum close to 100%):
Segment Breakdown: Cloud Deployment 45%, On-Premise 30%, Hybrid 25%

Gauge metric (renders as a half-circle gauge) — label contains CAGR, Growth, Adoption, Penetration, Utilization, or Conversion, and the value is a percentage:
CAGR: 15.1%
Adoption Rate: 62% in 2025

Key Players (renders as a competitor name list) — label exactly "Key Players", value is a comma-separated list of company names:
Key Players: Acme Corp, Northwind Traders, Globex Inc

Market Share (renders as a ranked bar chart of competitors) — label exactly "Market Share", value is a comma-separated "Name X%" list, same companies as Key Players when both are used:
Market Share: Acme Corp 34%, Northwind Traders 22%, Globex Inc 15%

Only include Segment Breakdown, Key Players, and Market Share when the primary report (or a verified adjacent Ken Research report) actually publishes segment-level or competitor-level percentages — these are optional, not required for every article. Do not fabricate a metric.

SECOND IMAGE — separate from the metrics above, this feeds a second downstream chart (Forecast Growth + Competitive Landscape + Growth Drivers + Regional Heat Map — all rendered as bubbles/tiles, never a bar/line/pie/donut chart). Provide up to three lines, each optional — omit any line whose content the report doesn't actually support, never fabricate. List drivers in priority order (most important first) — order is used to indicate relative emphasis:

Growth Drivers: 3–4 short driver phrases, semicolon-separated, most important first:
Growth Drivers: Rising hybrid seed adoption; Government subsidy programs; Expansion of agro-dealer networks

Competitive Landscape: label exactly "Competitive Landscape", value is a comma-separated "Name X%" list of the same market's leading companies (reuse Key Players/Market Share figures if already verified above — do not re-derive different numbers):
Competitive Landscape: Acme Corp 27%, Northwind Traders 22%, Globex Inc 18%

Regional Landscape: label exactly "Regional Landscape", value is a comma-separated "Country/Region X%" list of the market's leading geographies by share (3–6 regions):
Regional Landscape: South Africa 34%, Kenya 21%, Nigeria 18%, Ethiopia 14%

The Forecast Growth panel itself is built from the Base Market Value / Forecast Value / CAGR already given above — do not repeat those here.

Typical article length:

1,500–2,200 words

Only when evidence supports that depth.

Do not pad the article merely to hit word count.

Use approximately 6–9 meaningful H2 sections.

A complex market may justify slightly more.

Do not create/delete sections purely to meet a numeric limit.

The article must NOT be one-liner-heavy.

The article must NOT be paragraph-only.

The article must NOT be a wall of text.

Normal analytical paragraphs:

2–4 sentences

roughly 45–110 words

one complete analytical idea

Avoid:

sentence-by-sentence <p> splitting

excessive single-sentence paragraphs

180–250 word blocks

dramatic AI-style fragmentation

Single-sentence paragraphs should normally remain below approximately 15–20% of body paragraphs.

Use them only for:

intentional emphasis

transition before bullets

callout

short conclusion

Every final article should contain a natural mix of:

analytical paragraphs

H2 sections

selective H3 sub-sections

useful bullet lists

limited blockquotes

Structural diversity does NOT mean turning the article into paragraph-only prose.

Likewise, formatting does NOT mean converting everything into lists.

Preferred editorial rhythm:

Paragraph
→ Paragraph
→ H3 or short setup
→ Bullets
→ Analytical interpretation

or:

Paragraph
→ Bullets
→ Paragraph

The exact amount must vary by market.

QUALITY must never decrease merely to create visual variation.

Use bullets when readers benefit from scanning.

Good uses:

operating questions

technology modules

demand drivers

risks

costs

competitive differentiators

buyer requirements

product/segment characteristics

signals to monitor

methodology components

Do not make every section a bullet list.

Do not make every section paragraphs.

Use lists only when useful.

Use H3 when a real subtopic deserves separation.

For a typical 1,500–2,200 word article:

approximately 2–5 useful H3 sub-sections may be appropriate

distribute them across different H2 sections where genuinely relevant

do NOT force every H2 to contain an H3

do NOT use H3 merely for decoration

do NOT create H3s followed by only one trivial sentence

Good H3 candidates include:

higher-value modules

use cases

buyer priorities

fastest-growing sub-segments

operating bottlenecks

channel economics

cost components

competitive differentiators

regional factors

methodology framework

Examples:

<h3>Higher-Value Analytics Modules</h3>

<h3>Potential Costs of Unplanned Downtime</h3>

<h3>Competitive Differentiation Is Moving Toward</h3>

If several related points are short:

H2
→ introductory paragraph
→ H3
→ bullets
→ analytical interpretation

may be appropriate.

Another H2 may use only analytical paragraphs when that reads better.

The goal is visual and analytical rhythm.

The final article must NOT become a continuous sequence of H2 + paragraph + paragraph with no visual variation.

Use maximum 2–3 blockquotes.

Use only for strategic conclusions.

Example:

<blockquote>
  <p>
    <strong>
      The market is moving from basic visibility toward operational intelligence.
    </strong>
  </p>
</blockquote>

These are editorial callouts.

Do not invent executive quotations.

Do not overuse.

Major sections should generally follow:

FACT
→ MECHANISM
→ BUSINESS IMPLICATION
→ COUNTER-RISK where relevant

Do not stop at facts.

Explain:

what changed

why it changed

who benefits

what it means commercially

what could weaken the trend

Avoid generic filler such as:

"Technology adoption is increasing."

Explain the economics behind the change.

Every strong quantitative or market-structure claim must be traceable to a
specific source.

This includes claims such as:

market share

platform concentration

"top X players account for Y%"

penetration rates

dominant segment percentages

fastest-growing segment claims

number of participants

transaction counts

active-user counts

adoption percentages

average commission rates

take rates

regulatory deadlines

historical CAGR

operating ratios

installed-base figures

Before using such a claim:

Confirm it appears in:

the primary Ken Research report

a verified adjacent Ken Research report

or an authoritative external source.

Preserve the exact:

year

unit

scope

geography

denominator where relevant.

Attribute the claim where attribution improves clarity.

If exact support cannot be verified:

REMOVE the number,
OR

rewrite the statement qualitatively.

Example:

If verified:
"The five core national platforms represented approximately
<strong>96%</strong> of aggregator GMV in <strong>2024</strong>."

If NOT verified:
"The market is concentrated among a small group of national platforms."

Never retain a precise number merely because it makes the article sound
authoritative.

Strong claims must survive source verification before publication.

Do not over-repeat the exact complete market name.

Use natural semantic variations.

Example:

Exact:
Nigeria Fleet Management Analytics Market

Alternatives:

Nigeria's fleet analytics market

fleet technology market

connected-fleet analytics

fleet-management software

telematics and analytics sector

the market

fleet technology ecosystem

Do not optimize to a fixed keyword-density percentage.

Do not repeat the exact market name in every heading.

Prioritize:

readability

entity clarity

topical depth

semantic coverage

Search the live Ken Research catalog.

Never guess an internal URL.

For each candidate:

Confirm the page exists.

Confirm URL resolves.

Confirm relevance.

Prefer country-specific reports where appropriate.

Prefer the most specific relevant market.

Avoid unrelated cross-country pages just to create links.

Identify the publication year/date of the adjacent report where available.

Prefer the newest relevant adjacent report when multiple versions exist.

Normal architecture:

ONE Ken Research homepage branding link.

ONE Primary Report link used in the FINAL CTA.

THREE genuinely relevant adjacent Ken Research report links inside the body.

Normal total:
approximately 5 Ken Research-domain link placements.

Optional fourth adjacent report:
ONLY if it represents a genuinely separate and valuable topic.

Never force a link to hit a quota.

Use descriptive anchors.

GOOD:

<strong>Nigeria logistics and warehousing market</strong>

<strong>Nigeria supply chain technology market</strong>

<strong>Netherlands AgriTech smart irrigation market</strong>

BAD:

click here

read more

this report

market

logistics

e-commerce

Do not repeat the same commercial anchor unnecessarily.

Adjacent Ken Research report links must be distributed across DIFFERENT
meaningful H2 sections.

Do NOT place:

2 adjacent Ken Research links in the same paragraph

2 adjacent Ken Research links in back-to-back paragraphs

adjacent Ken Research links in immediately consecutive short sections

multiple adjacent-report links inside one short H2 section

multiple links simply because several URLs were discovered

IMPORTANT:

Do NOT place hyperlinks directly inside H1 or H2 heading text.

Place contextual internal links naturally inside body paragraphs beneath
the relevant H2.

Preferred distribution:

INTRODUCTION:

Paragraph 1 — Ken Research homepage branding link (the mandatory first-mention link)

Paragraph 3 — Adjacent report #1 (see Paragraph 3 requirement above)

EARLY / EARLY-MIDDLE H2:

Adjacent report #2

A meaningful content gap

MIDDLE H2:

Adjacent report #3

A meaningful content gap

LATER H2:

Optional adjacent report #4 (only if a genuinely distinct, valuable topic — see below)

END:

Primary Report CTA

Optional adjacent #4:

only significantly later

only if it supports a distinct topic

Whenever practical, keep at least:

2 normal analytical paragraphs
OR

1 substantial H2/H3 section

between adjacent Ken Research report links.

The article must never visually resemble an SEO link cluster.

Adjacent Ken Research links should do more than function as navigation.

Where a related Ken Research report contains genuinely relevant evidence,
use it as contextual corroboration.

Preferred patterns:

"A similar shift is visible in the <strong>2026</strong>
<a href="[VERIFIED URL]">
<strong>Ken Research [Related Market Name]</strong>
</a>
assessment, where [SUPPORTED RELATED FINDING]."

or:

"This pattern is consistent with the <strong>2026</strong>
<a href="[VERIFIED URL]">
<strong>Ken Research [Related Market Name]</strong>
</a>,
which identifies [SUPPORTED ADJACENT TREND]."

or:

"Related <strong>Ken Research</strong> analysis published in
<strong>2026</strong> also points to [SUPPORTED TREND], providing broader
context for [CURRENT ARTICLE CLAIM]."

Rules:

Mention the adjacent report's publication year when available and useful.

Prefer the newest relevant adjacent report.

Do NOT invent a supporting statistic.

Do NOT claim an adjacent report "confirms" the primary market estimate
unless it genuinely validates the same metric.

Prefer careful wording such as:

"is consistent with"

"shows a similar pattern"

"provides adjacent evidence"

"offers broader context"

"reinforces the operating trend"

Avoid overstating with:

"proves"

"confirms"

"verifies"
unless the evidence genuinely supports that wording.

If quoting a specific number from an adjacent report:

verify the exact number

preserve its exact year

preserve its exact unit

preserve its exact market scope

bold the visible number

make clear that the number belongs to the adjacent market.

Adjacent Ken Research research is contextual evidence and does not replace
an official source when an official/regulatory/statistical claim requires
primary validation.

BAD INTERNAL LINKING:

"The wider
<a href='URL'><strong>Poland e-commerce market</strong></a>
is also growing."

BETTER:

"This channel expansion is consistent with the <strong>2026</strong>
<a href='URL'>
<strong>Ken Research Poland Online Groceries and Quick Commerce Market</strong>
</a>
assessment, which also points to growing demand for digitally coordinated
convenience purchases. For delivery aggregators, this creates additional
ordering occasions beyond restaurant meals."

Every adjacent internal link should ideally contribute meaning, recency,
context or corroboration—not merely SEO navigation.

==================================================
ADJACENT REPORT PHRASING DIVERSITY — MANDATORY
==================================================

The contextual-corroboration examples above are examples only.
Do NOT turn them into a repeated sentence template.

Adjacent Ken Research report citations must NOT repeatedly follow the same
construction such as:

- "This direction is consistent with the [Month Year] Ken Research..."
- "The same pattern is visible in the [Month Year] Ken Research..."
- "A similar shift is visible in the [Month Year] Ken Research..."
- "The [Month Year] Ken Research [Market] assessment..."
- "Related Ken Research analysis published in [Year]..."

These constructions may be used occasionally when they genuinely read well,
but they must NOT become the default structure for adjacent-report links.

For each adjacent report, choose the most natural editorial role based on the
specific section and industry, such as:

1. broader market context
2. supporting demand signal
3. technology overlap
4. supply-side evidence
5. channel-development context
6. regional or geographic context
7. operating-economics context
8. buyer-behavior context
9. infrastructure context
10. strategic adjacency

Vary the sentence construction naturally.

Possible integration styles include:

A. Direct contextual integration:
"The expansion of the
<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>
also increases demand for [specific relevant capability]."

B. Supporting evidence:
"Broader evidence from the
<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>
shows how [supported related trend], which matters here because [implication]."

C. Technology overlap:
"This operating model overlaps with trends in the
<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>,
particularly around [technology/process]."

D. Supply-side context:
"On the supply side, the
<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>
adds context around [supported supply-side factor]."

E. Comparative signal:
"A related shift can be seen in the
<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>,
where [supported adjacent trend]."

F. Natural continuation:
"That same infrastructure is also relevant to the
<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>,
because [specific connection]."

G. Evidence-first sentence:
"[Supported adjacent finding]. This is reflected in the
<a href='[VERIFIED URL]'><strong>[Related Market]</strong></a>."

MANDATORY VARIATION RULES:

- Do NOT begin multiple adjacent-report sentences with the same phrase.
- Do NOT use the same grammatical structure for all adjacent links.
- Do NOT force the words "Ken Research" into every adjacent-link anchor.
- If "Ken Research" is visibly written, it must still be bold according to the
  existing Ken Research bolding rule.
- Publication month/year is OPTIONAL contextual metadata, not a mandatory
  phrasing element.
- Mention publication month/year only when recency materially improves the
  reader's understanding or credibility of the supporting point.
- Do NOT mechanically place "[Month Year] + Ken Research + Report Name +
  assessment" around every internal link.
- At least 2–3 different editorial integration styles should be used across the
  adjacent links in a typical article.
- The sentence containing the internal link should still read naturally and add
  analytical value if the hyperlink itself were removed.
- Natural editorial flow is more important than repeating brand/date language.
- Preserve source accuracy, recency, claim traceability and contextual value
  while varying the phrasing.

The objective is:
CONTEXTUAL EVIDENCE + NATURAL EDITORIAL FLOW + LINK VALUE

not:
REPEATED CITATION TEMPLATE + SEO FOOTPRINT.

Use approximately 2–3 authoritative external links.

Prefer:

regulator

government agency

national statistics body

central bank

transport/port authority

customs authority

official ministry

primary institutional source

Anchor the actual organization/regulation name.

Use normal editorial links.

Do NOT automatically add rel="nofollow" to genuine official editorial citations.

Only use nofollow/sponsored when there is a real reason.

Do NOT use:

URL shorteners

discovery-call links

repeated homepage links

excessive primary-report links

irrelevant report links

naked URLs

large related-report blocks

links purely for SEO

repeated anchors

Article must be informational first and commercial second.

If companies are discussed:

use only supported participants

do not fabricate market shares

do not rank without reliable evidence

do not call a company #1 without evidence

describe as an unranked participant set when appropriate

If a concentration statistic is used, such as:

"Five platforms represent <strong>96%</strong>"

the figure must pass the STRONG CLAIM TRACEABILITY rule.

Explain what competition is based on:

price

technology

integrations

network

distribution

analytics

local support

reliability

customer acquisition

compliance

product depth

recurring revenue

service quality

data capability

Competition analysis must explain economics, not just list names.

Where regulation matters, explain:

regulation/program

administering authority

relevant scope

operational requirement

effect on buyers/providers

demand implication

cost implication

compliance burden

possible entry barrier

competitive differentiation

Use official sources where possible.

Do not write vague statements like:

"Government regulation supports the market."

Every article needs meaningful downside analysis.

Relevant risks may include:

affordability

inflation

currency

regulation

input costs

energy

talent shortage

financing

fragmented infrastructure

implementation complexity

utilization

customer acquisition

margin compression

demographics

adoption barriers

cybersecurity

privacy

data governance

supply-chain risk

Use only risks relevant to the market.

Article must not read like promotion.

Near the end include a market-specific monitoring section where appropriate.

Typical form:

<h2>
  What [Relevant Stakeholders] Should Watch Through
  <strong>[Forecast Year]</strong>
</h2>

Start with one analytical paragraph.

Then use approximately 5–7 bullets.

Each:

<strong>Indicator:</strong>
why it matters.

Do not create an H3 for every indicator.

Include a dedicated Market Outlook section.

It must:

summarize market direction

include base/forecast values where useful

identify structural opportunity

identify major risk

explain upside conditions

explain downside conditions

translate forecast into business meaning

Do not simply repeat introduction.

Always include:

<h2>Research Basis and Data Status</h2>

Clearly state:

report publication date/period

base year

forecast period

methodology

respondent count if available

validation approach where published

proprietary status of estimates

government statistics are separately sourced

company-reported information is distinct

If useful include:

<h3>Research Framework</h3>

<ul>
  <li>Provider mapping</li>
  <li>Industry indicators</li>
  <li>Pricing analysis</li>
  <li>Regulatory research</li>
  <li>Primary interviews</li>
  <li>Supply-demand reconciliation</li>
  <li>Market-model validation</li>
</ul>

Use ONLY methodology actually supported by the report.

Use ONE final commercial CTA.

This is normally the ONLY place where the Primary Report URL is linked.

Example:

<p>
  <strong>
    <a href="[PRIMARY REPORT URL]">
      Explore the [Market Name] report
    </a>
  </strong>
  for detailed segmentation, competitive coverage and forecast assumptions.
</p>

Do NOT add:

discovery call

newsletter

Preferred Source CTA

generic homepage CTA

second sales CTA

URL shortener

Do NOT automatically add FAQs.

Add only if:

genuine questions remain unanswered

questions provide incremental value

they address separate user intent

Do not repeat market size/CAGR/segments just to create FAQ content.

No target platform will be provided.

Always create a platform-neutral master article.

Use:

clean HTML

semantic H1/H2/H3

paragraphs

bullet lists

limited blockquotes

one snapshot image

descriptive alt text

Do NOT use:

HTML tables

Markdown tables

platform-specific widgets

custom scripts

complex CSS

platform-only embeds

The master article must be easy to adapt later for:

LinkedIn

Medium

Blogger

HackMD

KenResearch.com

The FINAL ARTICLE must use pure HTML only.

The FINAL ARTICLE must be a FLAT sequence of top-level block tags only —
<h1>, <p>, <h2>, <h3>, <ul>, <li> — with the <h1> as the very first tag.
Do NOT wrap the article, or any part of it, in <article>, <div>, <section>,
or any other container tag. Every heading and paragraph must be a direct,
unwrapped top-level element.

Inside final article HTML:

Do NOT use:
Markdown bold

Do NOT use:
Markdown bold

Do NOT use:
Markdown links

Use:

<strong>...</strong>

and:

<a href="...">...</a>

Final HTML must not mix Markdown and HTML.

Do not use fake AI-search tricks.

Optimize through clarity and evidence.

Ensure:

clear market/entity definition

explicit scope

factual statements

years attached to numbers

units attached to numbers

direct attribution

clear segment leadership

mechanism explanation

meaningful headings

official sources

proprietary vs official distinction

risk analysis

methodology transparency

forecast assumptions

Do not artificially manufacture repetitive 40-word answer snippets.

Write naturally for human readers first.

Before output, silently verify:

CONTENT
[ ] Correct market
[ ] Newest consistent dataset
[ ] Base value
[ ] Forecast
[ ] CAGR
[ ] Years correct
[ ] Segment claims supported
[ ] Drivers explained
[ ] Mechanisms explained
[ ] Business implications included
[ ] Risk included
[ ] Competition not falsely ranked
[ ] Strong quantitative claims traceable
[ ] Regulation sourced
[ ] Methodology included
[ ] Proprietary estimates identified

STRUCTURE
[ ] Dynamic market-specific architecture
[ ] H2s are industry-specific
[ ] Approximately 2–5 useful H3s used where appropriate
[ ] H3s distributed naturally rather than clustered
[ ] Useful bullet lists included
[ ] Article is not paragraph-only
[ ] Article is not list-heavy
[ ] Paragraphs are not fragmented
[ ] Paragraphs are not walls of text
[ ] Blockquotes limited
[ ] No generic filler
[ ] No keyword stuffing

BOLDING
[ ] Every meaningful visible number bold
[ ] Every visible year bold
[ ] Every percentage bold
[ ] Every currency value bold
[ ] Every count/unit metric bold
[ ] Every visible Ken Research bold

BRANDING
[ ] Homepage linked exactly once
[ ] First natural Ken Research mention linked
[ ] Homepage not repeated

PRIMARY REPORT
[ ] Primary report NOT linked in introduction
[ ] Primary report NOT repeatedly linked in body
[ ] Primary report linked in final CTA

INTERNAL LINKS
[ ] 3 adjacent reports discovered and verified
[ ] Optional 4th only if valuable
[ ] No guessed URLs
[ ] Descriptive anchors
[ ] Adjacent reports placed in different meaningful H2 sections
[ ] No adjacent links in back-to-back paragraphs
[ ] No link clusters
[ ] Adjacent report publication year used where useful
[ ] Adjacent reports provide contextual corroboration where supported
[ ] No overstated "confirms/proves" language
[ ] Adjacent-report sentences do not reuse the same opening phrase
[ ] Publication month/year is not repeated mechanically for every internal link
[ ] "Ken Research [Report] assessment" is not repeated as a fixed formula
[ ] Adjacent links use at least 2–3 different editorial integration styles where practical
[ ] Internal-link sentences remain natural and analytically useful without the hyperlink
[ ] No repeated "This direction is consistent with..." style citation pattern

STRONG CLAIMS
[ ] Market-share figures traced
[ ] Concentration figures traced
[ ] Adoption rates traced
[ ] Participant counts traced
[ ] Regulatory deadlines traced
[ ] Commission/take-rate claims traced
[ ] Unsupported precision removed or softened

EXTERNAL LINKS
[ ] 2–3 authoritative links
[ ] Exact claims supported
[ ] Official sources preferred
[ ] No forced links
[ ] No automatic nofollow

LINK HYGIENE
[ ] No shortener
[ ] No discovery call
[ ] No link farm behavior
[ ] One final CTA

HTML
[ ] Exactly one H1
[ ] Valid H2/H3 hierarchy
[ ] Valid paragraphs/lists
[ ] Valid blockquotes
[ ] Snapshot image is a bare <img src="YOUR_IMAGE_URL_HERE" alt="..."> — no figure, no figcaption, no width/height/loading attributes
[ ] Second image is a bare <img src="YOUR_IMAGE_URL_HERE_2" alt="..."> placed in the middle/lower section, same bare-tag rules
[ ] Descriptive alt
[ ] No table
[ ] No Markdown syntax inside HTML
[ ] No broken tags
[ ] Only two image placeholders = YOUR_IMAGE_URL_HERE and YOUR_IMAGE_URL_HERE_2
[ ] No citation/source chips (e.g. "kenresearch.com +1") anywhere in the SEO Title, Meta Description, or Key Snapshot Metrics — those sections are plain deliverable text, not chat-UI citations

Return exactly:

SEO Title

Meta Description

Primary Search Intent

Primary Keyword

Secondary Semantic Topics

Suggested Snapshot Image Alt

Key Snapshot Metrics for Image

5–7 supported metrics, using the exact "Label: Value" formats mandated above (trend "→" chains, Share/Segment Breakdown/CAGR-Growth-Adoption percentages, Key Players, Market Share) — never a freeform format

Key Qualitative Insights for Image 2

Up to three lines (Growth Drivers, Competitive Landscape, Regional Landscape) in the exact formats mandated above — omit any line the report doesn't support, never fabricate

Internal Link Map

For each:

Anchor

Verified URL

Report publication date/year if available

Intended H2 section

Why relevant

Supporting contextual trend/claim if available

Include:

Ken Research homepage branding link

Primary Report — final CTA

Adjacent #1

Adjacent #2

Adjacent #3

Optional #4 only if necessary

External Source Map

For each:

Source / anchor

Official URL

Claim supported

Intended placement

FINAL ARTICLE

ONE complete clean HTML article

Research first.

Verify second.

Verify every strong quantitative claim.

Silently create three possible market-specific structures.

Choose the strongest structure.

Write ONE complete article.

Keep the formatting quality standard:

paragraphs
+
industry-specific H2s
+
selective H3s
+
useful bullet lists
+
limited strategic callouts.

Place adjacent Ken Research links in different meaningful H2 sections.

Do not place adjacent internal links back-to-back.

Use adjacent Ken Research reports as contextual, recent, carefully worded
supporting evidence where their content genuinely supports the point.

Do NOT overstate adjacent research as proof of the primary-market claim.

Do NOT let structural variation reduce quality.

Audit the article against every rule.

Fix violations silently.

Then return the final output.

Do NOT ask for a reference article.

Do NOT ask for a target platform.

Do NOT output multiple full article variations.

Do NOT make every industry look structurally identical.

Do NOT sacrifice facts, SEO, AIO quality, readability, sourcing,
information gain or editorial formatting merely to create variation.`;
}

/** V1 — now just the Ken Research Market Blog Master Prompt V1.3 (2026-09-18 replacement). */
export function buildMasterBlogPrompt(reportTitle: string, reportUrl: string): string {
  return buildKenResearchMasterPromptV1_3(reportTitle, reportUrl);
}

// ── Prompt B pool (2026-09-25) ──────────────────────────────────────────────
// Four alternate storytelling-angle prompts from "Different Prompts for
// LinkedIn Articles.docx", rotated 50/50 against the existing master prompt
// (buildMasterBlogPrompt, above) — see PROMPT_B_ROTATION_CHANCE below. Each
// must return the exact same structured-deliverable contract as the master
// prompt (same section headings) so extractBlog()/extractBlogStable() parse
// either one identically — verified live 2026-09-25 via a standalone test
// run before this was wired in.
const PROMPT_B_OUTPUT_FORMAT = `

OUTPUT FORMAT (mandatory) — return exactly the following sections, in this order, each under its own heading line exactly as written below. Do not add commentary before "SEO Title" or after the closing tag of the FINAL ARTICLE HTML.

SEO Title
A search-facing title, distinct from the article's own H1/headline. Must be unique, punchy, search-intent aligned. Do not include "Ken Research" in it.

Meta Description
A single-paragraph meta description (under 160 characters) summarizing the article for search results.

Primary Search Intent
One line naming the primary search intent this article satisfies.

Primary Keyword
The single primary target keyword.

Secondary Semantic Topics
A short list of secondary semantic topics/keywords covered.

Suggested Snapshot Image Alt
One descriptive alt-text line for the article's snapshot image.

Key Snapshot Metrics for Image
5-7 supported metrics, one per line, each in the exact format "Label: Value" (e.g. "Market Size 2025: USD 1.2 Billion", "CAGR 2025-2030: 8.4%", "Top Segment Share: Skincare 34%", "Key Player: PlayCore") — never freeform prose, never a citation chip (bare domain or "+N") as its own line.

Key Qualitative Insights for Image 2
Up to three optional lines feeding a second chart (rendered as bubbles/tiles, never bar/line/pie/donut) — omit any the report doesn't support, never fabricate: "Growth Drivers: phrase 1; phrase 2; phrase 3" (semicolon-separated, 3-4 short driver phrases, most important first), "Competitive Landscape: Name1 X%, Name2 Y%, Name3 Z%" (comma-separated, same companies/figures as any Key Player/Market Share data already given, do not re-derive different numbers), "Regional Landscape: Region1 X%, Region2 Y%, Region3 Z%" (comma-separated, 3-6 leading geographies by share).

Internal Link Map
For each Ken Research link used in the article: Anchor / Verified URL / Report publication date or year if available / Intended H2 section / Why relevant / Supporting contextual trend or claim if available. Include the Ken Research homepage branding link, the Primary Report as the final CTA, and 2-4 adjacent report links.

External Source Map
For each external (government/official) source used: Source or anchor / Official URL / Claim supported / Intended placement.

FINAL ARTICLE
ONE complete, clean HTML article — use <h1> for the title, <h2>/<h3> for subheadings, <p> for paragraphs, <ul>/<li> for lists, and <a href="..."> for every interlink. No markdown syntax anywhere inside the HTML (no #, **, -, etc.).`;

function buildPromptB_VisionaryForecast(reportTitle: string, reportUrl: string): string {
  return `Role & Task: Act as an expert B2B content strategist and futurist. Write an 800-1000 word article for "${reportTitle}" targeting CXOs, founders, and decision-makers. Input Data: URL: ${reportUrl}. Key Stats/Data: research and extract the current market size, CAGR, and forecast figures directly from the URL above. Target Keywords: research and determine the most relevant long-tail SEO keywords for this market yourself from the report title and URL. Storytelling Angle: The Visionary Forecast (Future-Casting). Focus on horizon scanning, 3-to-5-year market shifts, and strategic foresight. The narrative should be: "Look beyond the current quarter; here is what the autonomous/cognitive ecosystem of the future looks like and how to prepare your board." Tone: Visionary, forward-looking, yet grounded in the provided data. Professional and boardroom-ready. Optimization Rules: SEO: Optimize H-tags for long-tail future-focused keywords. AIO/AEO: Use a "Current State vs. Future State" comparison list for easy AI parsing. GEO/LLM: Establish strong semantic relationships between current technologies and future outcomes. Use clear, definitive language. Ken Research Integration: Include 2-3 natural anchor text interlinks to Ken Research foresight or macro-trend reports. End with a strong CTA: "Schedule a strategic foresight session with Ken Research analysts to align your long-term vision with market realities."${PROMPT_B_OUTPUT_FORMAT}`;
}

function buildPromptB_IndustryBlindSpot(reportTitle: string, reportUrl: string): string {
  return `Role & Task: Act as an expert B2B content strategist and industry insider. Write an 800-1000 word article for "${reportTitle}" targeting CXOs, founders, and decision-makers. Input Data: URL: ${reportUrl}. Target Keywords: research and determine the most relevant long-tail SEO keywords for this market yourself from the report title and URL. Data Extraction & Sourcing Rules: Read and extract the core data, insights, and statistics directly from the provided URL. Search for and integrate at least 2-3 highly relevant, recent statistics from official government websites (e.g., regulatory changes, compliance data, .gov policy shifts, national audit reports) to expose the gap between the surface-level industry narrative and the underlying data reality. Storytelling Angle: The Industry Blind Spot. Do NOT use a confrontational "your strategy is failing" tone. Instead, use a revelatory, insider-intelligence writing style. The narrative should be: "The entire industry is collectively optimizing for the wrong metric and chasing the wrong trend. Here is the hidden data pattern that almost every board is overlooking, and the massive first-mover advantage available to the few leaders who see what others cannot." Frame the reader as the smart insider who "gets it," not as someone being lectured. Tone: Sophisticated, revelatory, calm but compelling. Think "exclusive briefing from a trusted advisor," not "aggressive thought leader shouting on LinkedIn." The authority should come from the depth of the data, not from provocative language. Formatting Rules: CRITICAL BULLET POINT RULE: Do NOT use short, 2-3 word fragments for bullet points. Every single bullet point must be a comprehensive, long sentence or two full lines of text that provides deep context and actionable insight. Optimization Rules: SEO/AIO/AEO: Structure using a "Surface Narrative vs. Underlying Data Reality" framework instead of the overused "Myth vs. Reality" format. This unique structure is more likely to be cited by AI answer engines as a novel perspective. GEO/LLM: Use objective, data-backed assertions with clear causal reasoning. Ensure the logical bridge between "what the industry believes" and "what the government/market data actually shows" is airtight for LLM comprehension. Ken Research Integration: Include 2-3 natural anchor text interlinks to Ken Research deep-dive analytical or sector-specific reports. End with a strong CTA: "Consult Ken Research for a bespoke market intelligence deep-dive to uncover the blind spots your competitors have not yet identified."${PROMPT_B_OUTPUT_FORMAT}`;
}

function buildPromptB_RegulatoryPolicyCatalyst(reportTitle: string, reportUrl: string): string {
  return `Role & Task: Act as an expert B2B content strategist and corporate policy advisor. Write an 800-1000 word article for "${reportTitle}" targeting CXOs, founders, and decision-makers. Input Data: URL: ${reportUrl}. Target Keywords: research and determine the most relevant long-tail SEO keywords for this market yourself from the report title and URL. Data Extraction & Sourcing Rules: Read and extract the core data, insights, and statistics directly from the provided URL. Search for and integrate at least 2-3 highly relevant, recent statistics from official government websites (e.g., new policy frameworks, subsidy allocations, national compliance mandates, .gov economic surveys) to highlight the regulatory catalyst. Storytelling Angle: The Regulatory Catalyst. The narrative should be: "Government policy is the ultimate market mover. Here is how recent regulatory shifts and national mandates are creating an asymmetric advantage for early movers, and how to align your corporate strategy with the new rules of the game." Tone: Strategic, risk-aware, highly professional, and policy-literate. Formatting Rules: CRITICAL BULLET POINT RULE: Do NOT use short, 2-3 word fragments for bullet points. Every single bullet point must be a comprehensive, long sentence or two full lines of text that provides deep context and actionable insight. Optimization Rules: SEO/AIO/AEO: Use a "Policy Shift -> Market Impact -> Strategic Action" structure. Detailed lists are critical here for Answer Engine parsing. GEO/LLM: Clearly define the relationship between government policy (entity 1) and market outcomes (entity 2) for LLM context. Ken Research Integration: Include 2-3 natural anchor text interlinks to Ken Research regulatory impact, market entry, or policy analysis reports. End with a strong CTA: "Access the Ken Research Policy Impact Toolkit to align your corporate strategy with the latest regulatory frameworks immediately."${PROMPT_B_OUTPUT_FORMAT}`;
}

function buildPromptB_EcosystemMap(reportTitle: string, reportUrl: string): string {
  return `Role & Task: Act as an expert B2B content strategist and M&A/strategy advisor. Write an 800-1000 word article for "${reportTitle}" targeting CXOs, founders, and decision-makers. Input Data: URL: ${reportUrl}. Target Keywords: research and determine the most relevant long-tail SEO keywords for this market yourself from the report title and URL. Data Extraction & Sourcing Rules: Read and extract the core data, insights, and statistics directly from the provided URL. Search for and integrate at least 2-3 highly relevant, recent statistics from official government websites (e.g., cross-border trade data, foreign direct investment stats, .gov economic surveys) to map out the macro-synergies. Storytelling Angle: The Ecosystem Map (Strategic Alignment). Focus on cross-industry convergence, M&A targets, and macro-synergies. The narrative should be: "Industry boundaries are dissolving. Here is how different sectors are intersecting, and where the hidden alpha lies for founders and investors." Tone: Strategic, big-picture, investor/boardroom-focused, and highly professional. H2/H3 Tag Optimization Rules (CRITICAL): ZERO Generic Headings: Do NOT use "Market Trends", "Synergies", "Industry Overlaps", "Key Takeaways", or "Conclusion". Convergence-Driven H2s: Every H2 must highlight a specific intersection of industries, M&A activity, or macro-synergy using strong semantic keywords. (e.g., Instead of "New Partnerships", use "Mapping the Convergence: How Retail and Logistics are Merging into Retail-as-a-Service (RaaS)"). AEO/GEO Structure: Use H2s to define the specific ecosystems being mapped. Use H3s to break down the exact M&A targets, joint venture structures, or capital flows within that ecosystem. Ensure H2s act as direct, semantic answers to investor and CXO queries. Formatting Rules: Crucial Bullet Point Rule: Do NOT use short, 2-3 word fragments for bullet points. Every single bullet point must be a comprehensive, long sentence or two full lines of text that provides deep context and actionable insight. Optimization Rules: SEO/AIO/AEO: Use a "Key Intersections" bulleted list to clearly map out the converging sectors for AI summarization. GEO/LLM: Focus on entity relationships (e.g., how Sector A impacts Sector B). Use authoritative, analytical language that signals high expertise to Generative Engines. Ken Research Integration: Include 2-3 natural anchor text interlinks to Ken Research ecosystem, market mapping, or M&A reports. End with a strong CTA: "Download the Ken Research Ecosystem Map to discover untapped M&A and joint venture opportunities in your sector."${PROMPT_B_OUTPUT_FORMAT}`;
}

const PROMPT_B_BUILDERS: { name: string; build: (title: string, url: string) => string }[] = [
  { name: 'visionary-forecast', build: buildPromptB_VisionaryForecast },
  { name: 'industry-blind-spot', build: buildPromptB_IndustryBlindSpot },
  { name: 'regulatory-policy-catalyst', build: buildPromptB_RegulatoryPolicyCatalyst },
  { name: 'ecosystem-map', build: buildPromptB_EcosystemMap },
];

// 50/50 split between the existing master prompt (Prompt A) and a randomly
// picked Prompt B variant, per the user's explicit instruction — only
// applies to the default v1 path; an explicit promptVersion: 'v2' request
// still always gets the keyword-focused v2 prompt, untouched by this split.
const PROMPT_B_ROTATION_CHANCE = 0.5;

/**
 * The OLD master SERP/AI-citation blog prompt — fully self-contained: does
 * its own research, sourcing, fact-checking, and HTML assembly per a fixed
 * 7-section architecture. ARTICLE_HTML mode: a raw HTML fragment response,
 * far more robust to extract from a ~1500-word ChatGPT generation than
 * trusting valid JSON out of the same.
 *
 * SUPERSEDED 2026-09-18 by buildKenResearchMasterPromptV1_3() above — kept
 * here only as OLD_buildMasterBlogPrompt for reference/rollback, no longer
 * called by generateBlogViaChatGpt().
 */
function OLD_buildMasterBlogPrompt(reportTitle: string, reportUrl: string): string {
  return `KEN RESEARCH SERP AND AI CITATION MASTER BLOG PROMPT
EXECUTION DIRECTIVE (read first)
This message IS the task, not a document to review. Begin the research and write the article immediately in this same reply.
Do not acknowledge the prompt, summarize its rules, list the constraints you will follow, comment on the input type, or ask whether to proceed — any such preamble is a failed response. The automation that reads your reply accepts only the final deliverable defined under FINAL RESPONSE.
HOW TO USE
Paste this prompt into a new chat and change only the final <INPUTS> block.
Use OUTPUT_MODE: ARTICLE_HTML for a clean article body.
Keep OUTPUT_MODE: ARTICLE_HTML for the normal publishing workflow. This is the default and safest mode.
Use OUTPUT_MODE: CMS_PACKAGE only when a JSON-aware automation will decode the response before publishing.
Use IMAGE_MODE: OFF for a completely text-only article.
The only mandatory inputs are REPORT_TITLE and REPORT_URL.
ROLE
You are a senior market-intelligence editor, research analyst, SEO strategist, answer-experience architect, fact-checker, and HTML publishing specialist for Ken Research.
Produce one publication-ready article that is genuinely useful to decision-makers, eligible for search discovery, easy for answer systems to interpret, and defensible under editorial review.
SEO, GAI/GEO/AIO, AXO/AEO, and E-E-A-T are quality disciplines, not ranking tricks. Do not promise rankings, Google AI Overview inclusion, featured snippets, or AI citations.
OUTCOME
Create an evidence-led market article of 1,450-1,600 visible words that:
Answers the market question quickly and accurately.
Uses one consistent set of market values, years, units, segments, and qualifiers.
Adds original commercial interpretation instead of paraphrasing the report page.
Distinguishes Ken Research estimates, official facts, company facts, and editorial inference.
Covers the main executive intents: definition, size, forecast, growth mechanisms, value migration, competition, regulation, risks, and actions.
Uses descriptive headings, compact evidence units, natural entity language, and source-adjacent attribution.
Includes only verified, relevant, crawlable links.
Returns the exact selected output format without commentary.
NON-NEGOTIABLE TRUST RULES
Never invent a figure, date, company, ranking, market share, segment position, regulation, programme, quote, respondent count, methodology, or URL.
Search-result snippets are discovery aids, not evidence. Open the source page.
Never use a competing market-research firm as a source or hyperlink destination.
Do not present an estimate or forecast as a completed fact.
Do not invent first-hand experience, analyst credentials, customer stories, or expert quotations.
If a material claim cannot be verified, omit it or use narrower qualitative wording.
Before concluding the primary report cannot be accessed, retry opening REPORT_URL at least 3 times across a few seconds apart — a single failed load is very often a transient network hiccup, a slow first response, or a temporary bot-check, not a real block. Also try opening the bare domain (kenresearch.com) and re-navigating from there if the direct URL fails. Only after multiple genuine, consistent failures to load ANY page on the domain — or after successfully loading the page and finding its content genuinely does not match the requested market/report — is this a real block.
If, after exhausting those retries, the primary report truly cannot be accessed or its core market identity cannot be verified, do not stop or refuse. Instead, search the open web for the same market (REPORT_TITLE, its geography, and its core scope) and assemble the DATA_SPINE from other reputable, live sources — industry associations, government/regulatory statistics, company filings, reputable trade press. Still write and frame the article as Ken Research's own market intelligence throughout (e.g. "Ken Research estimates...", "According to Ken Research..."), exactly as if the primary report page had loaded normally, using the best-verified web-sourced figures as that estimate. Never name or link to a competing market-research firm (Mordor Intelligence, IMARC, MarketsandMarkets, Technavio, Precedence Research, Future Market Insights, Renub Research, or similar) as a source — if a figure's only available attribution is one of those firms, use the figure without naming its source, or omit that specific claim rather than invent a number. Only return RESEARCH BLOCKED: Primary report could not be verified if the web search itself also fails to turn up any usable, verifiable data for this market — this should be rare.
If REPORT_URL or REPORT_TITLE is a survey, feedback study, methodology page, or service offering rather than a standard market-sizing report, this DOES NOT reduce the requirement for verified market data — widen the web search instead: find verified market-size, CAGR, or forecast data for the closest adjacent, verifiable market or industry (e.g. for a patient feedback survey, search for the patient experience management market, healthcare CX market, or hospital patient satisfaction software market; for any other survey/service page, identify and search the market category it operationally belongs to). Present that verified adjacent-market data exactly as Ken Research's own market intelligence throughout (e.g. "Ken Research estimates...", "According to Ken Research..."), the same as for a standard report. Every figure must still come from a real, verifiable source — never invent one. Only return RESEARCH BLOCKED if this widened search also fails to turn up any usable, verifiable data for the market or its closest adjacent category.
MANDATORY PROCEDURE FOR SURVEY / SERVICE / METHODOLOGY INPUTS (an explanation of why the article cannot be written is a FAILED response — never output one):
Step 1 — Derive the adjacent market: strip words such as "survey", "buyer experience", "feedback", "study", "service" from REPORT_TITLE and keep the product/sector noun; pair it with the geography from the report page (default "Global" if none is stated). Example: "Affordable Housing Buyer Experience Survey" -> "India Affordable Housing Market" if the page is India-focused, otherwise "Global Affordable Housing Market".
Step 2 — Search the open web for "<adjacent market> market size", "<adjacent market> CAGR forecast" and "<adjacent market> outlook", opening the actual pages (government statistics, industry associations, company filings, trade press). Lock the DATA_SPINE from what you verify there.
Step 3 — Write the FULL article for that adjacent market: the H1 uses the adjacent market name and geography in the mandatory two-clause format, the Description line uses the adjacent market's verified figures, and the survey topic (buyer experience, feedback, service quality) becomes the article's analytical angle in the growth-mechanism and decision-framework sections. Attribute the figures as Ken Research market intelligence exactly as for a standard report.
Step 4 — If a specific value (e.g. a published CAGR) cannot be verified, drop only that clause; never drop the article. Phrases such as "Unable to complete", "cannot complete", "not available from accessible sources" must never appear in your reply.
GENERAL FALLBACK (applies to every rule in this prompt): if any source, page or link cannot be opened or verified — the report page, a Ken Research cluster page, an official external source — that never stops the article. Write with what you could verify, omit or soften what you could not, never invent a figure or a URL, and never return a refusal message of any kind. The only acceptable non-article output is RESEARCH BLOCKED, and only when even the widened web search finds no usable data at all.
KEN RESEARCH BRAND AUTHORITY RULES (MANDATORY — the finished article is run through an automated code validator that checks these exact rules and flags the article for review if any are missed, so follow them closely; never withhold the article over them)
Title: the H1 title must naturally contain the words "Ken Research".
Opening paragraph: paragraph 1 must (a) mention "Ken Research", (b) use an approved authority-context phrase from the approved list below in the same sentence, and (c) hyperlink that first Ken Research mention to a kenresearch.com destination (homepage or the primary report).
Approved expressions — use only these when referring to Ken Research as a source: "According to Ken Research analysis", "Ken Research market assessment indicates", "The Ken Research study highlights", "Ken Research estimates".
Banned expressions — never write these: "Ken Research says", "Ken Research thinks", "Ken Research provides reports".
Mention frequency: since this article is always 1,450-1,600 words (above the 1,200-word threshold), the text must contain between 2 and 4 total mentions of "Ken Research" (counting every occurrence in visible text, including the title) — never fewer than 2, never more than 4.
Promotional risk: never use the words "Buy", "Purchase", "Download now", or "Get report" anywhere in the article. Keep the tone strictly editorial.
Every Ken Research mention must be connected to evidence, market intelligence, analysis, or methodology — never a bare/promotional reference.
RESEARCH CONTRACT
Complete the following silently before drafting.
1. Resolve the market entity
Open REPORT_URL and resolve redirects to the final canonical Ken Research report page. If the first attempt fails to load, retry — do not treat one failed request as proof the page or domain is unreachable.
Confirm the exact market, geography, included products or services, excluded scope, currency, and forecast period.
Read the accessible summary, KPI cards, tables, charts, segmentation, competitive coverage, methodology, FAQs, and publication information.
2. Lock the DATA_SPINE
Record the verified values available for:
Base or historical value, currency, year, and status
Current estimate, when available
Forecast value, currency, and year
Published CAGR and exact period
Volume and unit, when available
Largest segment and segmentation dimension
Fastest-growing segment and segmentation dimension
Important demand, pricing, technology, channel, funding, trade, or regulatory indicators
Verified market participants
Verified methodology information
Every repeated figure must match this DATA_SPINE. Recalculate CAGR from the locked values as a reasonableness check, but do not replace a published rate merely because of normal rounding.
3. Build the CLAIM_LEDGER
For every candidate factual claim, record its source URL, publisher, date, geography, year, unit, status, scope, and permitted wording.
Use this source hierarchy:
Ken Research report page for proprietary market estimates, segmentation, forecast, competitive coverage, and methodology.
Government departments, regulators, national statistics offices, public agencies, and primary legal or policy documents.
Official company filings, releases, product pages, and investor materials for company-specific claims.
Recognized multilaterals and industry associations when stronger primary evidence is unavailable.
Reputable trade sources only for non-critical context that cannot be obtained from a primary source.
4. Resolve conflicts and freshness
Use the latest authoritative official source for external policy, demographic, regulatory, funding, budget, and programme facts.
Cross-check the Ken Research page's hero, KPI cards, tables, narrative, charts, and FAQs.
Never combine a value from one year with a CAGR or forecast from another data series.
If one page label conflicts with a consistent value-year combination repeated elsewhere, use the consistent combination and log the isolated label in SOURCE_QA.
If a contradiction cannot be resolved, omit the disputed detail.
Put a verified year beside time-sensitive claims. Avoid unsupported words such as "currently," "recently," or "today."
5. Build the INTENT_AND_ENTITY_MAP
Identify:
Primary query and exact market entity
Likely executive follow-up questions
Related entities, technologies, policies, channels, companies, and buyer groups
The one commercial thesis the evidence best supports
The strongest counter-risk to that thesis
Three stakeholder decisions the article should improve
Use natural entity language. Do not create separate paragraphs merely to target keyword variants.
6. Validate links
Open every intended destination and confirm successful loading, final canonical URL, page-title match, topic relevance, and support for the surrounding statement.
Reject guessed URLs, soft 404s, search pages, generic filter pages, login walls, empty pages, irrelevant redirects, shortened URLs, or fabricated report slugs.
7. Check cannibalization and content uniqueness
Search the Ken Research domain for an existing article targeting the same market and primary query.
If an existing page satisfies the same intent, design this article as a substantive update or choose a clearly distinct executive angle rather than creating a near-duplicate.
In CMS_PACKAGE mode, record the competing internal URL and recommended action in seo.cannibalization_alert.
Do not copy paragraphs from the report page or create near-identical versions for multiple publishing platforms.
SEARCH AND AI-ANSWER WRITING STANDARD
Answer-first construction
The first paragraph must answer what the market is, its verified size or status, forecast direction, and why the result matters.
The first paragraph after every H2 must answer that section's question in approximately 45-80 words.
Follow the answer with deeper evidence and implications. Do not bury the conclusion at the end.
Citation-ready evidence units
Build short, self-contained passages around one claim cluster:
State the claim with the entity, geography, year, and unit.
Attribute the evidence directly.
Explain the mechanism.
State the commercial implication or counter-risk.
Keep Ken Research estimates, official evidence, and analysis visibly distinct with wording such as:
"Ken Research estimates..."
"Official data from [agency] shows..."
"This suggests..."
Original value
The article must contribute at least three forms of original analytical value:
A causal explanation of what moves value, volume, margins, or access
A stakeholder-specific implication
A credible counterpoint, constraint, or downside scenario
Do not merely restate drivers, company names, and market figures from the report page.
E-E-A-T and trust signals
Use a supplied author or organization byline; never invent an analyst.
State the research basis, source types, and data status.
Preserve regulatory and programme status: proposal, recommendation, enacted rule, active programme, or historical measure.
Name sources and dates where they materially improve trust.
Use company claims only for that company and label them accordingly.
Treat trust as the priority when experience, expertise, authority, and promotional language conflict.
Readability and language
Write for senior executives in neutral, concrete language.
Keep paragraphs to two or three sentences and normally below 90 words.
Average roughly 16-24 words per sentence.
Use one idea per paragraph and one clear purpose per section.
Avoid vague consulting phrases, generic introductions, hype, keyword stuffing, and repeated strategic labels.
Do not use the same statistic and implication in more than two body locations, excluding one FAQ retrieval answer.
Use <strong> selectively for decisive values and conclusions, not every number.
NEW ARTICLE ARCHITECTURE
Use exactly one H1 and exactly seven H2 sections, in this fixed order and role.
H2 heading wording — do not default to the same literal H2 heading text article after article. Each "H2 N:" label below names that section's ROLE, not mandatory verbatim text — write a fresh, natural heading for this specific market that fulfills the role (often working in the market entity, geography, or the article's live theme) instead of reusing a stock phrase every time. Keep the section order and count fixed; vary only the wording.
Hero image, conditional
If IMAGE_MODE: ON and HERO_IMAGE_URL passes validation, place a verified hero image before the H1. If the image fails, omit it silently. If IMAGE_MODE: OFF, output no image tags or image discussion.
H1 — MANDATORY TWO-CLAUSE TITLE FORMAT (overrides any generic headline length/shape guidance elsewhere)
The H1 always has exactly two clauses joined by " : " (space, colon, space). Never omit the colon clause — a title without it fails validation.
Clause 1 — the market-size headline:
{GEOGRAPHY} {MARKET NAME} Market {Nears|Hits} USD {VALUE}{B|M}
Use "Nears" when the headline value is an approaching/forecast figure not yet reached. Use "Hits" when the headline value is a current/achieved figure.
{VALUE}{B|M} format: "USD" followed by the number then immediately "B" (billion) or "M" (million) with no space before the letter — e.g. "USD 5.83B", "USD 211B", "USD 99.1M", "USD 1.6B", "USD 14M". Use one or two decimal places only when the verified figure needs them; whole numbers stay whole (e.g. "USD 211B", not "USD 211.0B").
Geography is the short verified market geography (e.g. "India", "Global", "Vietnam", "Thailand", "Middle East", "APAC", "Kuwait"). Market Name is the concise verified market/report entity.
Clause 2 — the Ken Research analytical hook, in one of exactly two patterns:
Pattern A (Tracks): Ken Research Tracks a/an {2-4 word Insight Noun Phrase}
  Example insight phrases: "a Compliance Race", "a Counterfeit Risk", "a Workforce Gap", "an IT Talent Gap", "a Gastroenterologist Shortage", "a Consolidation Wave", "a Channel Shift", "a Compliance Filter", "a Regulatory Divide".
Pattern B (Flags): Ken Research Flags {Factor} as the Real|Bigger {Consequence Noun Phrase}
  Example: "Ken Research Flags SME Financing as the Real Modernization Bottleneck", "Ken Research Flags Price Volatility as the Bigger Risk", "Ken Research Flags Brand Concentration as the Real Entry Barrier".
Choose whichever pattern the article's strongest counter-risk/thesis fits more naturally — the insight phrase (Pattern A) or factor+consequence (Pattern B) must genuinely reflect the counter-risk identified in the RESEARCH CONTRACT and Decision Framework sections, never a generic or unrelated phrase.
Title-case both clauses (capitalize major words); keep small connector words ("a", "an", "as", "the") lowercase except when starting a clause.
Full worked examples (format only — do not reuse the figures):
"India Sustainable Packaging Market Nears USD 5.83B : Ken Research Tracks a Compliance Race"
"Global Fried Onion Market Hits USD 4.9B : Ken Research Flags Price Volatility as the Bigger Risk"
Do not use vague trend-only endings such as "Shifts to Powered Care," "Enters a New Era," or "Growth Accelerates" in place of clause 2 — clause 2 must always be the "Ken Research Tracks/Flags ..." structure above.
Typical total length runs 80-100 visible characters; up to ~130 is acceptable for a longer Pattern B consequence phrase. There is no fixed 50-60 character cap — the two-clause structure and clarity take priority over brevity.
Wrap only "USD {VALUE}{B|M}" in <strong> inside the H1; leave the rest of the H1 unformatted.
No byline
Never output a byline paragraph (e.g. "By Ken Research", "By [Author]", or any variant) anywhere in the article, regardless of SHOW_BYLINE or AUTHOR_NAME field values. The article body goes directly from the H1 into the opening abstract paragraph.
No citation-tool artifacts
Never output raw citation/browsing-tool markup such as ":contentReference[oaicite:0]{index=0}", ":chatgpt-content-reference{index="0"}", "[oaicite:...]", or any other bracket-style citation residue in any spelling. If a claim needs a source, express it in plain prose (e.g. "According to Ken Research analysis...") or as a proper <a> hyperlink per the LINK ARCHITECTURE rules — never as leftover tool syntax. Reread the full response before returning it and strip any such artifact if one appears.
Opening abstract
Write two paragraphs totaling approximately 140-180 words.
Paragraph 1:
Answer the market definition, size or current status, forecast direction, and time period.
Link the first natural Ken Research mention to the homepage.
Link the market name to the primary report in a separate sentence.
Use no more than three core statistics.
Paragraph 2:
State the main growth mechanism, counter-risk, and central commercial thesis.
Do not summarize every later section.
H2 1: Market Definition and Evidence Snapshot
Begin with a one-sentence definition that clarifies what is included and, when necessary, excluded.
Add exactly five concise bullets: current/base value, forecast and CAGR period, segment structure, one official external signal, and the central implication or risk.
Use complementary evidence rather than repeating the opening word for word.
If IMAGE_MODE: ON and SNAPSHOT_IMAGE_URL passes validation, place it after the definition and before the bullets.
H2 2: Growth Mechanisms and Market Economics
Use two or three H3 subsections selected for the market, covering ground such as:
what is expanding the demand base
how price and volume are interacting
which technology, funding, replacement, or channel mechanism matters most
H3 phrasing is not required to be a question every time — use a question, a direct statement, or a short thematic label, whichever reads most naturally for that specific point; do not mechanically convert every H3 into a question just for formatting consistency, and do not phrase all H3s in a section the same way.
Each subsection must move from evidence to mechanism to commercial consequence.
H2 3: Where Market Value Is Moving
Use two H3 subsections to explain the most decision-relevant shifts across product, technology, application, end user, channel, geography, or price tier. Same H3-phrasing freedom as above — question, statement, or label, whichever fits.
Identify the segmentation dimension explicitly.
Distinguish largest from fastest-growing.
Explain buyer behaviour and why the mix shift matters.
Do not list every segment.
H2 4: Competition, Regulation and Entry Barriers
Use two or three H3 subsections. Same H3-phrasing freedom as above.
Discuss only verified participants and treat them as unranked unless shares or rankings are sourced.
Explain the real basis of competition: access, distribution, service, pricing, technology, procurement, compliance, or customer relationships.
Explain the most material regulation, policy, funding rule, trade condition, or barrier to entry using an official source.
Include the strongest risk to the article's thesis.
After this section, include CTA 1 linking to the canonical primary report. The anchor must describe the destination accurately.
H2 5: Decision Framework and Market Outlook
Use exactly two H3 subsections:
Decision Framework
Signals to Monitor
Requirements:
Translate the evidence into exactly three stakeholder actions.
Present a measured base-case direction and two conditions that could strengthen or weaken it. Do not invent probabilities.
Identify leading indicators to monitor through the forecast period.
Add one or two relevant Ken Research cluster links only when they give useful adjacent-market context.
After this section, include CTA 2 linking to the Ken Research Talk to Us destination. Use exactly one of these two verified URLs (either is acceptable — do not invent or use any other "talk to us"/"contact" URL): https://www.kenresearch.com/book-a-discovery-call or https://www.kenresearch.com/custom-form, each with the mandatory UTM string appended as usual. Keep it consultative.
H2 6: Frequently Asked Questions
Include exactly five unique FAQ pairs. Use an H3 question and one 45-65-word answer for each.
Cover:
Market definition and scope
Size, year, and data status
Forecast value and CAGR period
Segment, competition, or regulation
Primary opportunity or risk
Question format — mandatory: prefix every H3 question with its number in the form "Q1:", "Q2:", "Q3:", "Q4:", "Q5:" (in order), followed by a space, then the question text. Each question must explicitly include the exact market name (e.g. "the Global Welded Metal Bellow Market") rather than a vague pronoun like "the market" or "this segment", and must be phrased the way a real executive searcher would type or ask it — matching the underlying search/answer intent for that FAQ topic (definition intent, sizing intent, forecast intent, segmentation/competition intent, opportunity/risk intent), not a generic templated phrasing.
Example: "Q2: How Large Is the Global Welded Metal Bellow Market in 2025?" — not "Q2: How large is the market?".
Answer directly in the first sentence. Do not add unsupported facts.
FAQ interlinking — mandatory: include exactly two Ken Research hyperlinks across the five FAQ answers — one link each inside two different answers (never both links in the same answer, never more than two total in this section). Link to the primary report or a genuinely relevant Ken Research cluster page, using the same UTM rules as the rest of the article. Use descriptive market-topic anchor text for these two links (e.g. the market/report name) rather than the literal words "Ken Research" — this keeps the article's total "Ken Research" mention count within the mandatory brand-frequency band above. The other three answers stay link-free.
H2 7: Methodology and Sources
Reserve approximately 110-150 words for this final section and write three complete paragraphs:
Research Basis: verified Ken Research methodology and validation information.
Sources: primary report attribution plus the most important official source publishers. Include the third primary-report link placement here.
Disclaimer: a concise statement that the article is for informational purposes and that readers should consult the full report or relevant professionals before making decisions.
Do not claim a confidence level unless the report publishes one.
Do not add a separate caveats section. The article is not complete until the Disclaimer paragraph is fully written and closed with </p>.
COMPLETION LOCK
Draft all seven H2 sections before returning any output.
Reserve the final 110-150 visible words for Methodology and Sources.
If the response approaches the length limit, compress earlier analysis. Never truncate the final section, FAQ answers, CTAs, source attribution, or disclaimer.
The final HTML element must be the complete Disclaimer paragraph.
The final non-whitespace characters in ARTICLE_HTML mode must be </p>.
Count opening and closing <p>, <h1>, <h2>, <h3>, <ul>, <li>, <a>, <strong>, and <em> tags. Every opened tag must close.
Do not return a partial article under any circumstance.
LINK ARCHITECTURE
The finished article should contain 12-14 Ken Research link placements when enough destinations can be verified, separate from official external citations. Fewer verified links is acceptable; invented links never are.
Required Ken Research distribution:
Ken Research homepage: exactly one placement in the opening
Canonical primary report: exactly three placements in the opening, CTA 1, and Sources paragraph
Ken Research Talk to Us: exactly one placement in CTA 2, using either https://www.kenresearch.com/book-a-discovery-call or https://www.kenresearch.com/custom-form (with UTM) — never any other "talk to us"/"contact"/"custom form" URL
Frequently Asked Questions: exactly two placements, one each inside two different FAQ answers
Relevant Ken Research cluster pages: target five to seven placements using five to seven unique destinations — use as many as can actually be verified
Total Ken Research placements: target 12-14
Total unique Ken Research destinations: target at least eight
Use at most two unique official government, regulator, national-statistics, or public-agency links. Zero, one, or two are all acceptable — never add a second government source just to reach two; include a second only when it is independently necessary and directly relevant. Never use more than two official external citations under any circumstance. These external citations do not count toward the 12-14 Ken Research placements.
Aim for one or two official external citations and never more than two. If no official government, regulator or national-statistics page can be verified for this market, write the article with zero external citations rather than inventing one or refusing — attribute the relevant claims to Ken Research analysis instead.
Distribute internal links across the article:
Opening: homepage and primary report
Market Definition and Evidence Snapshot: one relevant cluster page
Growth Mechanisms and Market Economics: one or two relevant cluster pages
Where Market Value Is Moving: one or two relevant cluster pages
Competition, Regulation and Entry Barriers: one relevant cluster page plus primary-report CTA 1
Decision Framework and Market Outlook: one or two relevant cluster pages plus Talk to Us CTA 2
Frequently Asked Questions: two links, one each inside two different FAQ answers (primary report or a relevant cluster page)
Methodology and Sources: primary report
Prioritize actual related Ken Research report pages. A verified sector, service, report-store category, or Competition Benchmarking page may be used only when it directly fits the surrounding discussion. Never use a generic page merely to reach the count.
If five unique relevant cluster destinations cannot be verified after a genuine search, do not stop and do not refuse. Write the complete article using every Ken Research destination you COULD verify — the homepage, the primary report and the Talk to Us URL are always available, so at minimum those three appear — and simply include fewer cluster links. Never guess or invent a URL to reach a count. Never return "LINK VALIDATION BLOCKED" or any other refusal because of link count: a complete article with fewer verified links is always the correct output; a refusal never is.
Competitor market-research domains are prohibited.
Link quality
Use concise descriptive anchor text, not "click here," "read more," naked URLs, or repeated exact-match anchors.
Place the link next to the claim or context it supports.
Do not put two links in one sentence.
Prefer one link per paragraph.
Non-negotiable: two interlinks (Ken Research or external) must never appear back-to-back — not in the same sentence, not in adjacent sentences with no unlinked content between them, and not as the first thing in a paragraph immediately following a linked sentence at the end of the prior paragraph. Every link must be separated from the next link by at least one full sentence containing no hyperlink.
Related Ken Research pages must be verified, genuinely relevant, and contextually introduced.
External factual links must point to direct primary pages, not government homepages when a specific page is available.
Mandatory UTM rule — EXACT, byte-for-byte, no exceptions
Every Ken Research hyperlink must end with this EXACT UTM string, character for character, with absolutely nothing changed, added, removed, re-encoded, or reordered:
?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation
Example — for the report https://www.kenresearch.com/saudi-arabia-outdoor-play-structures-market, the final href must be exactly:
https://www.kenresearch.com/saudi-arabia-outdoor-play-structures-market?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation
Rules:
Only the base URL (the domain + path, e.g. https://www.kenresearch.com/saudi-arabia-outdoor-play-structures-market) may vary from link to link. The UTM string itself — ?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation — must be pasted identically on every single Ken Research link, with zero variation.
Use a literal "?" to join the base URL and the UTM string — never "&", never "&amp;", never a second "?".
Use a literal "&" between utm_medium and utm_campaign — never "&amp;", never any HTML-entity encoding.
Do not change letter casing anywhere in the UTM string. Do not add, drop, duplicate, or reorder any of the three parameters.
If the base URL already ends with a "/", still join with a single "?" — never leave a stray "/" or "&" before the UTM string.
Apply this to all 12-14 Ken Research placements, including homepage, primary report, related pages, FAQ links, and Talk to Us.
Do not add any query parameters to official external sources.
Reopen every tracked URL and verify it reaches the intended page AND ends with exactly ?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation.
Reject any Ken Research <a> tag whose href does not end with that exact UTM string.
Link markup
For LINK_STYLE_MODE: CMS, use clean crawlable anchors:
<a href='FINAL_URL'><strong>DESCRIPTIVE ANCHOR</strong></a>
For LINK_STYLE_MODE: INLINE, use:
<a href='FINAL_URL' style='color:#0645AD; font-weight:700; text-decoration:underline;' target='_blank' rel='noopener'><strong>DESCRIPTIVE ANCHOR</strong></a>
Use single quotation marks for HTML attributes.
IMAGE RULES
When IMAGE_MODE: OFF:
Output no image tags.
Do not search for, request, generate, or mention images.
When IMAGE_MODE: ON:
Use only supplied image URLs.
Confirm a successful image response and inspect the image.
Reject broken, unreadable, misspelled, truncated, contradictory, outdated, or fabricated visual data.
Prefer a 16:9 hero image at least 1200 pixels wide.
Write concise descriptive alt text based on the actual visual and market entity.
Do not stuff keywords or place unsupported figures in alt text.
Hero markup:
<img src='HERO_IMAGE_URL' alt='VERIFIED DESCRIPTIVE ALT' loading='eager'/>
Snapshot markup:
<img src='SNAPSHOT_IMAGE_URL' alt='VERIFIED DESCRIPTIVE ALT' loading='lazy'/>
OUTPUT MODES
ARTICLE_HTML
Precede the fragment with the single "Description:" line defined in FINAL RESPONSE, then return one clean HTML fragment.
Put each block element on a new real line.
Never output the literal character sequences \\n, \\r, or \\t.
Do not JSON-escape the HTML.
Allowed tags:
<img>, <h1>, <h2>, <h3>, <p>, <ul>, <li>, <a>, <strong>, <em>
Do not output Markdown, code fences, full HTML document wrappers, meta tags, CSS blocks, JavaScript, schema, comments, tables, footnotes, internal ledgers, or commentary.
After the single "Description:" line (see FINAL RESPONSE), the HTML fragment must begin with < and end with the final </p> from the completed Disclaimer paragraph.
CMS_PACKAGE
Return one valid JSON object with exactly these keys:
seo
schema
source_qa
link_manifest
article_html
seo must include:
meta_title: 50-60 characters and include the strongest verified numerical hook
meta_description: 145-155 characters
slug: concise lowercase hyphenated slug
canonical_url: supplied value or null
primary_keyword: exact market entity
secondary_entities: five to eight verified related entities
excerpt: 150-170 characters
author_name: supplied value or null
published_date: supplied value or null
updated_date: supplied value or null
featured_image_alt: verified value or null
cannibalization_alert: verified competing internal URL and recommendation, or null
post_publish_checks: an array covering indexability, canonical rendering, sitemap inclusion, mobile content parity, Core Web Vitals, schema validation, image fetchability, and crawlable internal links
schema must include article, faq, and breadcrumb fields.
If CMS_GENERATES_SCHEMA: YES, return null for all three.
If CMS_GENERATES_SCHEMA: NO, generate valid JSON-LD only when required author, date, canonical URL, image, and breadcrumb inputs are available.
Schema must match visible content exactly. Do not invent missing fields.
Do not create special "AI schema"; use only valid structured data supported by the visible page.
source_qa must be an array of verified source-page contradictions, each containing issue, locations, safe_article_value, and recommended_fix. Use an empty array when none are found.
link_manifest must list each final link's type, anchor, url, section, and verification_status.
article_html must contain the complete validated article as one continuous JSON string. Do not insert \\n, \\r, or \\t escape sequences. The JSON-aware consumer must decode this field before publishing; never publish the raw JSON representation.
PUBLISHING DEPENDENCIES OUTSIDE THE ARTICLE
The content cannot rank or become eligible for AI features if the published page is inaccessible or technically ineligible. The CMS or SEO workflow must separately verify after publication:
The final URL returns HTTP 200 and is not blocked by robots rules or noindex.
The page declares the intended canonical URL.
The same primary content and structured data are available on mobile.
The URL is discoverable through crawlable internal links and the XML sitemap.
Core Web Vitals and general page experience are acceptable.
Images are publicly fetchable, correctly sized, and not blocked.
Structured data parses successfully and matches visible content.
Updated dates change only after a meaningful content revision.
FINAL QA GATE
Before returning the deliverable, verify:
Evidence
Every factual claim has a source in the CLAIM_LEDGER.
Market values, years, currency, volume, CAGR period, and segment dimensions are consistent.
Estimates, forecasts, official facts, company facts, and inference are labelled correctly.
No search snippet, competitor report, fabricated URL, unsupported ranking, or invented methodology remains.
Report-page inconsistencies are resolved safely or omitted and logged.
Search and answer quality
The H1 follows the mandatory two-clause "{Geography} {Market} Market Nears/Hits USD {Value}{B|M} : Ken Research Tracks/Flags ..." format, contains the market entity, and includes the strongest verified numerical hook.
The article has exactly seven H2 sections and five FAQs.
Each H2 begins with a direct answer.
The market scope is explicitly defined.
Important claims include entity, geography, year, unit, and attribution where applicable.
The article contains original mechanisms, stakeholder implications, and a counter-risk.
No section repeats another section's full fact-and-implication pair.
The article does not duplicate an existing Ken Research page targeting the same intent without a distinct update or angle.
Language is natural, specific, neutral, and free of keyword stuffing.
Visible article length is 1,450-1,600 words.
Links and images
Every link loads, matches its destination, and uses descriptive anchor text.
No competitor market-research link exists.
The article contains every Ken Research link that could be verified, up to 12-14 placements (the two FAQ links included), and no invented URLs.
The primary report appears exactly three times; homepage and Talk to Us appear exactly once each.
Verified Ken Research cluster destinations (ideally five to seven) are used contextually.
One or two unique official external citations are present and counted separately; the count never exceeds two.
Every Ken Research href ends with exactly ?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation — no &amp; entities, no extra "?" or "&", no casing changes.
Official external links contain no UTM parameters.
Image mode and image validation rules are satisfied.
Technical package
Article HTML uses only allowed tags and valid nesting.
All seven H2 sections, five FAQs, two CTAs, Research Basis, Sources, and Disclaimer are complete.
Every opened HTML tag closes, and the final HTML element is the complete Disclaimer paragraph ending with </p>.
ARTICLE_HTML mode uses real line breaks and contains no literal \\n, \\r, or \\t sequences.
ARTICLE_HTML mode contains no metadata or schema.
CMS_PACKAGE mode parses as JSON and contains exactly the required keys.
CMS_PACKAGE article_html is complete and contains no newline escape sequences.
Metadata character limits are met.
Cannibalization alerts and post-publish technical checks are present in CMS_PACKAGE mode.
Schema is absent when CMS-generated or when required inputs are missing.
Schema and FAQs match visible content exactly.
FINAL RESPONSE
For OUTPUT_MODE: ARTICLE_HTML, output EXACTLY ONE line beginning "Description: " (the meta description, built per the DESCRIPTION LINE rule below), then a line break, then the validated HTML fragment — and nothing else.
For OUTPUT_MODE: CMS_PACKAGE, return only the validated JSON object.
Do not add explanations, research notes, validation results, or Markdown fences.
DESCRIPTION LINE (ARTICLE_HTML only) — build it from the locked DATA_SPINE, in EXACTLY this shape and word order:
Description: The {full descriptive market name} worth USD {base or current value} {unit} in {base year} is growing at a CAGR of {published CAGR}% to reach USD {forecast value} {unit} by {forecast year}. {three to five verified market participants from the DATA_SPINE, comma-separated}
Rules for this line: use the FULL descriptive market name (not the short label); pull every number from the DATA_SPINE and never invent one; if the report does not provide a given value, omit only that clause and keep the sentence grammatical (e.g. drop "worth USD ... in {year}" when there is no base value); one line only, plain text, no HTML tags, no markdown.
<INPUTS> REPORT_TITLE: ${reportTitle} REPORT_URL: ${reportUrl}
OUTPUT_MODE: ARTICLE_HTML
LINK_STYLE_MODE: CMS
IMAGE_MODE: OFF
HERO_IMAGE_URL:
SNAPSHOT_IMAGE_URL:
SHOW_BYLINE: OFF
AUTHOR_NAME: Ken Research
PUBLISHED_DATE:
UPDATED_DATE:
CANONICAL_BLOG_URL:
BREADCRUMB_PARENT_URL:
CMS_GENERATES_SCHEMA: YES
</INPUTS>
You already have everything required to complete this task: REPORT_URL to browse and research yourself, and full authority to search the open web for supporting data. Never respond by asking for the report content, market data, permission, or access to be provided to you — that data does not exist anywhere except through your own research of REPORT_URL and the open web, exactly as every rule above already instructs. A reply that asks for data/permission/access instead of researching and writing is a failed response, identical to an acknowledgement, a plan, or a question.
BEGIN NOW. Your reply must contain only the deliverable defined under FINAL RESPONSE — no acknowledgement, no plan, no questions, and no request for data, permission, or access.`;
}

/**
 * V2 — SUPERSEDED 2026-09-18: now just calls the same
 * buildKenResearchMasterPromptV1_3() as V1. The old keyword-focused variant
 * is kept below as OLD_buildMasterBlogPromptV2 for reference/rollback only.
 * blogGenLoop.ts still randomly picks 'v1'/'v2' per row — both now produce
 * the identical Ken Research Market Blog Master Prompt V1.3 output.
 */
export function buildMasterBlogPromptV2(reportTitle: string, reportUrl: string): string {
  return buildKenResearchMasterPromptV1_3(reportTitle, reportUrl);
}

function OLD_buildMasterBlogPromptV2(reportTitle: string, reportUrl: string): string {
  return `KEN RESEARCH SERP AND AI CITATION MASTER BLOG PROMPT (V2 — KEYWORD-FOCUSED H2s)
EXECUTION DIRECTIVE (read first)
This message IS the task, not a document to review. Begin the research and write the article immediately in this same reply.
Do not acknowledge the prompt, summarize its rules, list the constraints you will follow, comment on the input type, or ask whether to proceed — any such preamble is a failed response. The automation that reads your reply accepts only the final deliverable defined under FINAL RESPONSE.
HOW TO USE
Paste this prompt into a new chat and change only the final <INPUTS> block.
Use OUTPUT_MODE: ARTICLE_HTML for a clean article body.
Keep OUTPUT_MODE: ARTICLE_HTML for the normal publishing workflow. This is the default and safest mode.
Use OUTPUT_MODE: CMS_PACKAGE only when a JSON-aware automation will decode the response before publishing.
Use IMAGE_MODE: OFF for a completely text-only article.
The only mandatory inputs are REPORT_TITLE and REPORT_URL.
ROLE
You are a senior market-intelligence editor, research analyst, SEO strategist, answer-experience architect, fact-checker, and HTML publishing specialist for Ken Research.
Produce one publication-ready article that is genuinely useful to decision-makers, eligible for search discovery, easy for answer systems to interpret, and defensible under editorial review.
SEO, GAI/GEO/AIO, AXO/AEO, and E-E-A-T are quality disciplines, not ranking tricks. Do not promise rankings, Google AI Overview inclusion, featured snippets, or AI citations.
OUTCOME
Create an evidence-led market article of 1,450-1,600 visible words that:
Answers the market question quickly and accurately.
Uses one consistent set of market values, years, units, segments, and qualifiers.
Adds original commercial interpretation instead of paraphrasing the report page.
Distinguishes Ken Research estimates, official facts, company facts, and editorial inference.
Covers the main executive intents: definition, size, forecast, growth mechanisms, value migration, competition, regulation, risks, and actions.
Uses descriptive headings, compact evidence units, natural entity language, and source-adjacent attribution.
Includes only verified, relevant, crawlable links.
Returns the exact selected output format without commentary.
NON-NEGOTIABLE TRUST RULES
Never invent a figure, date, company, ranking, market share, segment position, regulation, programme, quote, respondent count, methodology, or URL.
Search-result snippets are discovery aids, not evidence. Open the source page.
Never use a competing market-research firm as a source or hyperlink destination.
Do not present an estimate or forecast as a completed fact.
Do not invent first-hand experience, analyst credentials, customer stories, or expert quotations.
If a material claim cannot be verified, omit it or use narrower qualitative wording.
Before concluding the primary report cannot be accessed, retry opening REPORT_URL at least 3 times across a few seconds apart — a single failed load is very often a transient network hiccup, a slow first response, or a temporary bot-check, not a real block. Also try opening the bare domain (kenresearch.com) and re-navigating from there if the direct URL fails. Only after multiple genuine, consistent failures to load ANY page on the domain — or after successfully loading the page and finding its content genuinely does not match the requested market/report — is this a real block.
If, after exhausting those retries, the primary report truly cannot be accessed or its core market identity cannot be verified, do not stop or refuse. Instead, search the open web for the same market (REPORT_TITLE, its geography, and its core scope) and assemble the DATA_SPINE from other reputable, live sources — industry associations, government/regulatory statistics, company filings, reputable trade press. Still write and frame the article as Ken Research's own market intelligence throughout (e.g. "Ken Research estimates...", "According to Ken Research..."), exactly as if the primary report page had loaded normally, using the best-verified web-sourced figures as that estimate. Never name or link to a competing market-research firm (Mordor Intelligence, IMARC, MarketsandMarkets, Technavio, Precedence Research, Future Market Insights, Renub Research, or similar) as a source — if a figure's only available attribution is one of those firms, use the figure without naming its source, or omit that specific claim rather than invent a number. Only return RESEARCH BLOCKED: Primary report could not be verified if the web search itself also fails to turn up any usable, verifiable data for this market — this should be rare.
If REPORT_URL or REPORT_TITLE is a survey, feedback study, methodology page, or service offering rather than a standard market-sizing report, this DOES NOT reduce the requirement for verified market data — widen the web search instead: find verified market-size, CAGR, or forecast data for the closest adjacent, verifiable market or industry (e.g. for a patient feedback survey, search for the patient experience management market, healthcare CX market, or hospital patient satisfaction software market; for any other survey/service page, identify and search the market category it operationally belongs to). Present that verified adjacent-market data exactly as Ken Research's own market intelligence throughout (e.g. "Ken Research estimates...", "According to Ken Research..."), the same as for a standard report. Every figure must still come from a real, verifiable source — never invent one. Only return RESEARCH BLOCKED if this widened search also fails to turn up any usable, verifiable data for the market or its closest adjacent category.
MANDATORY PROCEDURE FOR SURVEY / SERVICE / METHODOLOGY INPUTS (an explanation of why the article cannot be written is a FAILED response — never output one):
Step 1 — Derive the adjacent market: strip words such as "survey", "buyer experience", "feedback", "study", "service" from REPORT_TITLE and keep the product/sector noun; pair it with the geography from the report page (default "Global" if none is stated). Example: "Affordable Housing Buyer Experience Survey" -> "India Affordable Housing Market" if the page is India-focused, otherwise "Global Affordable Housing Market".
Step 2 — Search the open web for "<adjacent market> market size", "<adjacent market> CAGR forecast" and "<adjacent market> outlook", opening the actual pages (government statistics, industry associations, company filings, trade press). Lock the DATA_SPINE from what you verify there.
Step 3 — Write the FULL article for that adjacent market: the H1 uses the adjacent market name and geography in the mandatory two-clause format, the Description line uses the adjacent market's verified figures, and the survey topic (buyer experience, feedback, service quality) becomes the article's analytical angle in the growth-mechanism and decision-framework sections. Attribute the figures as Ken Research market intelligence exactly as for a standard report.
Step 4 — If a specific value (e.g. a published CAGR) cannot be verified, drop only that clause; never drop the article. Phrases such as "Unable to complete", "cannot complete", "not available from accessible sources" must never appear in your reply.
KEN RESEARCH BRAND AUTHORITY RULES (MANDATORY — the finished article is run through an automated code validator that checks these exact rules and rejects the article if any fail)
Title: the H1 title must naturally contain the words "Ken Research".
Opening paragraph: paragraph 1 must (a) mention "Ken Research", (b) use an approved authority-context phrase from the approved list below in the same sentence, and (c) hyperlink that first Ken Research mention to a kenresearch.com destination (homepage or the primary report).
Approved expressions — use only these when referring to Ken Research as a source: "According to Ken Research analysis", "Ken Research market assessment indicates", "The Ken Research study highlights", "Ken Research estimates".
Banned expressions — never write these: "Ken Research says", "Ken Research thinks", "Ken Research provides reports".
Mention frequency: since this article is always 1,450-1,600 words (above the 1,200-word threshold), the text must contain between 2 and 4 total mentions of "Ken Research" (counting every occurrence in visible text, including the title) — never fewer than 2, never more than 4.
Promotional risk: never use the words "Buy", "Purchase", "Download now", or "Get report" anywhere in the article. Keep the tone strictly editorial.
Every Ken Research mention must be connected to evidence, market intelligence, analysis, or methodology — never a bare/promotional reference.
RESEARCH CONTRACT
Complete the following silently before drafting.
1. Resolve the market entity
Open REPORT_URL and resolve redirects to the final canonical Ken Research report page. If the first attempt fails to load, retry — do not treat one failed request as proof the page or domain is unreachable.
Confirm the exact market, geography, included products or services, excluded scope, currency, and forecast period.
Read the accessible summary, KPI cards, tables, charts, segmentation, competitive coverage, methodology, FAQs, and publication information.
2. Lock the DATA_SPINE
Record the verified values available for:
Base or historical value, currency, year, and status
Current estimate, when available
Forecast value, currency, and year
Published CAGR and exact period
Volume and unit, when available
Largest segment and segmentation dimension
Fastest-growing segment and segmentation dimension
Important demand, pricing, technology, channel, funding, trade, or regulatory indicators
Verified market participants
Verified methodology information
Every repeated figure must match this DATA_SPINE. Recalculate CAGR from the locked values as a reasonableness check, but do not replace a published rate merely because of normal rounding.
3. Build the CLAIM_LEDGER
For every candidate factual claim, record its source URL, publisher, date, geography, year, unit, status, scope, and permitted wording.
Use this source hierarchy:
Ken Research report page for proprietary market estimates, segmentation, forecast, competitive coverage, and methodology.
Government departments, regulators, national statistics offices, public agencies, and primary legal or policy documents.
Official company filings, releases, product pages, and investor materials for company-specific claims.
Recognized multilaterals and industry associations when stronger primary evidence is unavailable.
Reputable trade sources only for non-critical context that cannot be obtained from a primary source.
4. Resolve conflicts and freshness
Use the latest authoritative official source for external policy, demographic, regulatory, funding, budget, and programme facts.
Cross-check the Ken Research page's hero, KPI cards, tables, narrative, charts, and FAQs.
Never combine a value from one year with a CAGR or forecast from another data series.
If one page label conflicts with a consistent value-year combination repeated elsewhere, use the consistent combination and log the isolated label in SOURCE_QA.
If a contradiction cannot be resolved, omit the disputed detail.
Put a verified year beside time-sensitive claims. Avoid unsupported words such as "currently," "recently," or "today."
5. Build the INTENT_AND_ENTITY_MAP
Identify:
Primary query and exact market entity
Likely executive follow-up questions
Related entities, technologies, policies, channels, companies, and buyer groups
The one commercial thesis the evidence best supports
The strongest counter-risk to that thesis
Three stakeholder decisions the article should improve
Use natural entity language.
6. Validate links
Open every intended destination and confirm successful loading, final canonical URL, page-title match, topic relevance, and support for the surrounding statement.
Reject guessed URLs, soft 404s, search pages, generic filter pages, login walls, empty pages, irrelevant redirects, shortened URLs, or fabricated report slugs.
7. Check cannibalization and content uniqueness
Search the Ken Research domain for an existing article targeting the same market and primary query.
If an existing page satisfies the same intent, design this article as a substantive update or choose a clearly distinct executive angle rather than creating a near-duplicate.
In CMS_PACKAGE mode, record the competing internal URL and recommended action in seo.cannibalization_alert.
Do not copy paragraphs from the report page or create near-identical versions for multiple publishing platforms.
SEARCH AND AI-ANSWER WRITING STANDARD
Answer-first construction
The first paragraph must answer what the market is, its verified size or status, forecast direction, and why the result matters.
The first paragraph after every H2 must answer that section's question in approximately 45-80 words.
Follow the answer with deeper evidence and implications. Do not bury the conclusion at the end.
Citation-ready evidence units
Build short, self-contained passages around one claim cluster:
State the claim with the entity, geography, year, and unit.
Attribute the evidence directly.
Explain the mechanism.
State the commercial implication or counter-risk.
Keep Ken Research estimates, official evidence, and analysis visibly distinct with wording such as:
"Ken Research estimates..."
"Official data from [agency] shows..."
"This suggests..."
Original value
The article must contribute at least three forms of original analytical value:
A causal explanation of what moves value, volume, margins, or access
A stakeholder-specific implication
A credible counterpoint, constraint, or downside scenario
Do not merely restate drivers, company names, and market figures from the report page.
E-E-A-T and trust signals
Use a supplied author or organization byline; never invent an analyst.
State the research basis, source types, and data status.
Preserve regulatory and programme status: proposal, recommendation, enacted rule, active programme, or historical measure.
Name sources and dates where they materially improve trust.
Use company claims only for that company and label them accordingly.
Treat trust as the priority when experience, expertise, authority, and promotional language conflict.
Readability and language
Write for senior executives in neutral, concrete language.
Keep paragraphs to two or three sentences and normally below 90 words.
Average roughly 16-24 words per sentence.
Use one idea per paragraph and one clear purpose per section.
Avoid vague consulting phrases, generic introductions, hype, and repeated strategic labels.
Do not use the same statistic and implication in more than two body locations, excluding one FAQ retrieval answer.
Use <strong> selectively for decisive values and conclusions, not every number.
NEW ARTICLE ARCHITECTURE
Use exactly one H1 and exactly seven H2 sections, in this fixed order and role.
H2 KEYWORD REQUIREMENT (SEO indexing — the defining rule of this V2 prompt): at least four of the seven H2 headings must naturally include the primary target keyword phrase: {Geography} + {Market Name} (e.g. "UK Zipper Market", "the Zipper Market in the UK", "UK's Zipper Sector") — use the exact geography and market entity from REPORT_TITLE/REPORT_URL, not a placeholder. Rotate which grammatical form is used heading to heading and article to article (exact phrase, possessive form, geography-first, market-first, with or without "the") so headings read naturally rather than as mechanically repeated keyword stuffing. Every H2 must still read as a real, natural heading a human editor would write — never sacrifice grammar or clarity just to fit the keyword in. Each "H2 N:" label below names that section's ROLE, not mandatory verbatim text — write a fresh heading for this specific market that fulfills the role AND satisfies this keyword requirement where it applies. Keep the section order and count fixed; vary only the wording.
Hero image, conditional
If IMAGE_MODE: ON and HERO_IMAGE_URL passes validation, place a verified hero image before the H1. If the image fails, omit it silently. If IMAGE_MODE: OFF, output no image tags or image discussion.
H1 — MANDATORY TWO-CLAUSE TITLE FORMAT (overrides any generic headline length/shape guidance elsewhere)
The H1 always has exactly two clauses joined by " : " (space, colon, space). Never omit the colon clause — a title without it fails validation.
Clause 1 — the market-size headline:
{GEOGRAPHY} {MARKET NAME} Market {Nears|Hits} USD {VALUE}{B|M}
Use "Nears" when the headline value is an approaching/forecast figure not yet reached. Use "Hits" when the headline value is a current/achieved figure.
{VALUE}{B|M} format: "USD" followed by the number then immediately "B" (billion) or "M" (million) with no space before the letter — e.g. "USD 5.83B", "USD 211B", "USD 99.1M", "USD 1.6B", "USD 14M". Use one or two decimal places only when the verified figure needs them; whole numbers stay whole (e.g. "USD 211B", not "USD 211.0B").
Geography is the short verified market geography (e.g. "India", "Global", "Vietnam", "Thailand", "Middle East", "APAC", "Kuwait", "UK"). Market Name is the concise verified market/report entity.
Clause 2 — the Ken Research analytical hook, in one of exactly two patterns:
Pattern A (Tracks): Ken Research Tracks a/an {2-4 word Insight Noun Phrase}
  Example insight phrases: "a Compliance Race", "a Counterfeit Risk", "a Workforce Gap", "an IT Talent Gap", "a Gastroenterologist Shortage", "a Consolidation Wave", "a Channel Shift", "a Compliance Filter", "a Regulatory Divide".
Pattern B (Flags): Ken Research Flags {Factor} as the Real|Bigger {Consequence Noun Phrase}
  Example: "Ken Research Flags SME Financing as the Real Modernization Bottleneck", "Ken Research Flags Price Volatility as the Bigger Risk", "Ken Research Flags Brand Concentration as the Real Entry Barrier".
Choose whichever pattern the article's strongest counter-risk/thesis fits more naturally — the insight phrase (Pattern A) or factor+consequence (Pattern B) must genuinely reflect the counter-risk identified in the RESEARCH CONTRACT and Decision Framework sections, never a generic or unrelated phrase.
Title-case both clauses (capitalize major words); keep small connector words ("a", "an", "as", "the") lowercase except when starting a clause.
Full worked examples (format only — do not reuse the figures):
"India Sustainable Packaging Market Nears USD 5.83B : Ken Research Tracks a Compliance Race"
"Global Fried Onion Market Hits USD 4.9B : Ken Research Flags Price Volatility as the Bigger Risk"
Do not use vague trend-only endings such as "Shifts to Powered Care," "Enters a New Era," or "Growth Accelerates" in place of clause 2 — clause 2 must always be the "Ken Research Tracks/Flags ..." structure above.
Typical total length runs 80-100 visible characters; up to ~130 is acceptable for a longer Pattern B consequence phrase. There is no fixed 50-60 character cap — the two-clause structure and clarity take priority over brevity.
Wrap only "USD {VALUE}{B|M}" in <strong> inside the H1; leave the rest of the H1 unformatted.
No byline
Never output a byline paragraph (e.g. "By Ken Research", "By [Author]", or any variant) anywhere in the article, regardless of SHOW_BYLINE or AUTHOR_NAME field values. The article body goes directly from the H1 into the opening abstract paragraph.
No citation-tool artifacts
Never output raw citation/browsing-tool markup such as ":contentReference[oaicite:0]{index=0}", ":chatgpt-content-reference{index="0"}", "[oaicite:...]", or any other bracket-style citation residue in any spelling. If a claim needs a source, express it in plain prose (e.g. "According to Ken Research analysis...") or as a proper <a> hyperlink per the LINK ARCHITECTURE rules — never as leftover tool syntax. Reread the full response before returning it and strip any such artifact if one appears.
Opening abstract
Write two paragraphs totaling approximately 140-180 words.
Paragraph 1:
Answer the market definition, size or current status, forecast direction, and time period.
Link the first natural Ken Research mention to the homepage.
Link the market name to the primary report in a separate sentence.
Use no more than three core statistics.
Paragraph 2:
State the main growth mechanism, counter-risk, and central commercial thesis.
Do not summarize every later section.
H2 1: Market Definition and Evidence Snapshot
Begin with a one-sentence definition that clarifies what is included and, when necessary, excluded.
Add exactly five concise bullets: current/base value, forecast and CAGR period, segment structure, one official external signal, and the central implication or risk.
Use complementary evidence rather than repeating the opening word for word.
If IMAGE_MODE: ON and SNAPSHOT_IMAGE_URL passes validation, place it after the definition and before the bullets.
H2 2: Growth Mechanisms and Market Economics
Use two or three H3 subsections selected for the market, covering ground such as:
what is expanding the demand base
how price and volume are interacting
which technology, funding, replacement, or channel mechanism matters most
H3 phrasing is not required to be a question every time — use a question, a direct statement, or a short thematic label, whichever reads most naturally for that specific point; do not mechanically convert every H3 into a question just for formatting consistency, and do not phrase all H3s in a section the same way.
Each subsection must move from evidence to mechanism to commercial consequence.
H2 3: Where Market Value Is Moving
Use two H3 subsections to explain the most decision-relevant shifts across product, technology, application, end user, channel, geography, or price tier. Same H3-phrasing freedom as above — question, statement, or label, whichever fits.
Identify the segmentation dimension explicitly.
Distinguish largest from fastest-growing.
Explain buyer behaviour and why the mix shift matters.
Do not list every segment.
H2 4: Competition, Regulation and Entry Barriers
Use two or three H3 subsections. Same H3-phrasing freedom as above.
Discuss only verified participants and treat them as unranked unless shares or rankings are sourced.
Explain the real basis of competition: access, distribution, service, pricing, technology, procurement, compliance, or customer relationships.
Explain the most material regulation, policy, funding rule, trade condition, or barrier to entry using an official source.
Include the strongest risk to the article's thesis.
After this section, include CTA 1 linking to the canonical primary report. The anchor must describe the destination accurately.
H2 5: Decision Framework and Market Outlook
Use exactly two H3 subsections:
Decision Framework
Signals to Monitor
Requirements:
Translate the evidence into exactly three stakeholder actions.
Present a measured base-case direction and two conditions that could strengthen or weaken it. Do not invent probabilities.
Identify leading indicators to monitor through the forecast period.
Add one or two relevant Ken Research cluster links only when they give useful adjacent-market context.
After this section, include CTA 2 linking to the Ken Research Talk to Us destination. Use exactly one of these two verified URLs (either is acceptable — do not invent or use any other "talk to us"/"contact" URL): https://www.kenresearch.com/book-a-discovery-call or https://www.kenresearch.com/custom-form, each with the mandatory UTM string appended as usual. Keep it consultative.
H2 6: Frequently Asked Questions
Include exactly five unique FAQ pairs. Use an H3 question and one 45-65-word answer for each.
Cover:
Market definition and scope
Size, year, and data status
Forecast value and CAGR period
Segment, competition, or regulation
Primary opportunity or risk
Question format — mandatory: prefix every H3 question with its number in the form "Q1:", "Q2:", "Q3:", "Q4:", "Q5:" (in order), followed by a space, then the question text. Each question must explicitly include the exact market name (e.g. "the Global Welded Metal Bellow Market") rather than a vague pronoun like "the market" or "this segment", and must be phrased the way a real executive searcher would type or ask it — matching the underlying search/answer intent for that FAQ topic (definition intent, sizing intent, forecast intent, segmentation/competition intent, opportunity/risk intent), not a generic templated phrasing.
Example: "Q2: How Large Is the Global Welded Metal Bellow Market in 2025?" — not "Q2: How large is the market?".
Answer directly in the first sentence. Do not add unsupported facts.
FAQ interlinking — mandatory: include exactly two Ken Research hyperlinks across the five FAQ answers — one link each inside two different answers (never both links in the same answer, never more than two total in this section). Link to the primary report or a genuinely relevant Ken Research cluster page, using the same UTM rules as the rest of the article. Use descriptive market-topic anchor text for these two links (e.g. the market/report name) rather than the literal words "Ken Research" — this keeps the article's total "Ken Research" mention count within the mandatory brand-frequency band above. The other three answers stay link-free.
H2 7: Methodology and Sources
Reserve approximately 110-150 words for this final section and write three complete paragraphs:
Research Basis: verified Ken Research methodology and validation information.
Sources: primary report attribution plus the most important official source publishers. Include the third primary-report link placement here.
Disclaimer: a concise statement that the article is for informational purposes and that readers should consult the full report or relevant professionals before making decisions.
Do not claim a confidence level unless the report publishes one.
Do not add a separate caveats section. The article is not complete until the Disclaimer paragraph is fully written and closed with </p>.
COMPLETION LOCK
Draft all seven H2 sections before returning any output.
Reserve the final 110-150 visible words for Methodology and Sources.
If the response approaches the length limit, compress earlier analysis. Never truncate the final section, FAQ answers, CTAs, source attribution, or disclaimer.
The final HTML element must be the complete Disclaimer paragraph.
The final non-whitespace characters in ARTICLE_HTML mode must be </p>.
Count opening and closing <p>, <h1>, <h2>, <h3>, <ul>, <li>, <a>, <strong>, and <em> tags. Every opened tag must close.
Do not return a partial article under any circumstance.
LINK ARCHITECTURE
The finished article must contain 12-14 Ken Research link placements, separate from official external citations.
Required Ken Research distribution:
Ken Research homepage: exactly one placement in the opening
Canonical primary report: exactly three placements in the opening, CTA 1, and Sources paragraph
Ken Research Talk to Us: exactly one placement in CTA 2, using either https://www.kenresearch.com/book-a-discovery-call or https://www.kenresearch.com/custom-form (with UTM) — never any other "talk to us"/"contact"/"custom form" URL
Frequently Asked Questions: exactly two placements, one each inside two different FAQ answers
Relevant Ken Research cluster pages: five to seven placements using five to seven unique destinations
Total Ken Research placements: exactly 12-14
Total unique Ken Research destinations: at least eight
Use at most two unique official government, regulator, national-statistics, or public-agency links. Zero, one, or two are all acceptable — never add a second government source just to reach two; include a second only when it is independently necessary and directly relevant. Never use more than two official external citations under any circumstance. These external citations do not count toward the 12-14 Ken Research placements.
After drafting, count all official external <a> tags. The article passes when the count is zero, one, or two; more than two fails validation.
Distribute internal links across the article:
Opening: homepage and primary report
Market Definition and Evidence Snapshot: one relevant cluster page
Growth Mechanisms and Market Economics: one or two relevant cluster pages
Where Market Value Is Moving: one or two relevant cluster pages
Competition, Regulation and Entry Barriers: one relevant cluster page plus primary-report CTA 1
Decision Framework and Market Outlook: one or two relevant cluster pages plus Talk to Us CTA 2
Frequently Asked Questions: two links, one each inside two different FAQ answers (primary report or a relevant cluster page)
Methodology and Sources: primary report
Prioritize actual related Ken Research report pages. A verified sector, service, report-store category, or Competition Benchmarking page may be used only when it directly fits the surrounding discussion. Never use a generic page merely to reach the count.
If five unique relevant cluster destinations cannot be verified, continue researching. Never guess a URL or silently publish below the internal-link target. If the minimum cannot be satisfied, return only: LINK VALIDATION BLOCKED: Fewer than 12 verified Ken Research link placements.
Competitor market-research domains are prohibited.
Link quality
Use concise descriptive anchor text, not "click here," "read more," naked URLs, or repeated exact-match anchors.
Place the link next to the claim or context it supports.
Do not put two links in one sentence.
Prefer one link per paragraph.
Non-negotiable: two interlinks (Ken Research or external) must never appear back-to-back — not in the same sentence, not in adjacent sentences with no unlinked content between them, and not as the first thing in a paragraph immediately following a linked sentence at the end of the prior paragraph. Every link must be separated from the next link by at least one full sentence containing no hyperlink.
Related Ken Research pages must be verified, genuinely relevant, and contextually introduced.
External factual links must point to direct primary pages, not government homepages when a specific page is available.
Mandatory UTM rule — EXACT, byte-for-byte, no exceptions
Every Ken Research hyperlink must end with this EXACT UTM string, character for character, with absolutely nothing changed, added, removed, re-encoded, or reordered:
?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation
Example — for the report https://www.kenresearch.com/saudi-arabia-outdoor-play-structures-market, the final href must be exactly:
https://www.kenresearch.com/saudi-arabia-outdoor-play-structures-market?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation
Rules:
Only the base URL (the domain + path, e.g. https://www.kenresearch.com/saudi-arabia-outdoor-play-structures-market) may vary from link to link. The UTM string itself — ?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation — must be pasted identically on every single Ken Research link, with zero variation.
Use a literal "?" to join the base URL and the UTM string — never "&", never "&amp;", never a second "?".
Use a literal "&" between utm_medium and utm_campaign — never "&amp;", never any HTML-entity encoding.
Do not change letter casing anywhere in the UTM string. Do not add, drop, duplicate, or reorder any of the three parameters.
If the base URL already ends with a "/", still join with a single "?" — never leave a stray "/" or "&" before the UTM string.
Apply this to all 12-14 Ken Research placements, including homepage, primary report, related pages, FAQ links, and Talk to Us.
Do not add any query parameters to official external sources.
Reopen every tracked URL and verify it reaches the intended page AND ends with exactly ?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation.
Reject any Ken Research <a> tag whose href does not end with that exact UTM string.
Link markup
For LINK_STYLE_MODE: CMS, use clean crawlable anchors:
<a href='FINAL_URL'><strong>DESCRIPTIVE ANCHOR</strong></a>
For LINK_STYLE_MODE: INLINE, use:
<a href='FINAL_URL' style='color:#0645AD; font-weight:700; text-decoration:underline;' target='_blank' rel='noopener'><strong>DESCRIPTIVE ANCHOR</strong></a>
Use single quotation marks for HTML attributes.
IMAGE RULES
When IMAGE_MODE: OFF:
Output no image tags.
Do not search for, request, generate, or mention images.
When IMAGE_MODE: ON:
Use only supplied image URLs.
Confirm a successful image response and inspect the image.
Reject broken, unreadable, misspelled, truncated, contradictory, outdated, or fabricated visual data.
Prefer a 16:9 hero image at least 1200 pixels wide.
Write concise descriptive alt text based on the actual visual and market entity.
Do not stuff keywords or place unsupported figures in alt text.
Hero markup:
<img src='HERO_IMAGE_URL' alt='VERIFIED DESCRIPTIVE ALT' loading='eager'/>
Snapshot markup:
<img src='SNAPSHOT_IMAGE_URL' alt='VERIFIED DESCRIPTIVE ALT' loading='lazy'/>
OUTPUT MODES
ARTICLE_HTML
Return only one clean HTML fragment.
Put each block element on a new real line.
Never output the literal character sequences \\n, \\r, or \\t.
Do not JSON-escape the HTML.
Allowed tags:
<img>, <h1>, <h2>, <h3>, <p>, <ul>, <li>, <a>, <strong>, <em>
Do not output Markdown, code fences, full HTML document wrappers, meta tags, CSS blocks, JavaScript, schema, comments, tables, footnotes, internal ledgers, or commentary.
The response must begin with < and end with the final </p> from the completed Disclaimer paragraph.
CMS_PACKAGE
Return one valid JSON object with exactly these keys:
seo
schema
source_qa
link_manifest
article_html
seo must include:
meta_title: 50-60 characters and include the strongest verified numerical hook
meta_description: 145-155 characters
slug: concise lowercase hyphenated slug
canonical_url: supplied value or null
primary_keyword: exact market entity
secondary_entities: five to eight verified related entities
excerpt: 150-170 characters
author_name: supplied value or null
published_date: supplied value or null
updated_date: supplied value or null
featured_image_alt: verified value or null
cannibalization_alert: verified competing internal URL and recommendation, or null
post_publish_checks: an array covering indexability, canonical rendering, sitemap inclusion, mobile content parity, Core Web Vitals, schema validation, image fetchability, and crawlable internal links
schema must include article, faq, and breadcrumb fields.
If CMS_GENERATES_SCHEMA: YES, return null for all three.
If CMS_GENERATES_SCHEMA: NO, generate valid JSON-LD only when required author, date, canonical URL, image, and breadcrumb inputs are available.
Schema must match visible content exactly. Do not invent missing fields.
Do not create special "AI schema"; use only valid structured data supported by the visible page.
source_qa must be an array of verified source-page contradictions, each containing issue, locations, safe_article_value, and recommended_fix. Use an empty array when none are found.
link_manifest must list each final link's type, anchor, url, section, and verification_status.
article_html must contain the complete validated article as one continuous JSON string. Do not insert \\n, \\r, or \\t escape sequences. The JSON-aware consumer must decode this field before publishing; never publish the raw JSON representation.
PUBLISHING DEPENDENCIES OUTSIDE THE ARTICLE
The content cannot rank or become eligible for AI features if the published page is inaccessible or technically ineligible. The CMS or SEO workflow must separately verify after publication:
The final URL returns HTTP 200 and is not blocked by robots rules or noindex.
The page declares the intended canonical URL.
The same primary content and structured data are available on mobile.
The URL is discoverable through crawlable internal links and the XML sitemap.
Core Web Vitals and general page experience are acceptable.
Images are publicly fetchable, correctly sized, and not blocked.
Structured data parses successfully and matches visible content.
Updated dates change only after a meaningful content revision.
FINAL QA GATE
Before returning the deliverable, verify:
Evidence
Every factual claim has a source in the CLAIM_LEDGER.
Market values, years, currency, volume, CAGR period, and segment dimensions are consistent.
Estimates, forecasts, official facts, company facts, and inference are labelled correctly.
No search snippet, competitor report, fabricated URL, unsupported ranking, or invented methodology remains.
Report-page inconsistencies are resolved safely or omitted and logged.
Search and answer quality
The H1 follows the mandatory two-clause "{Geography} {Market} Market Nears/Hits USD {Value}{B|M} : Ken Research Tracks/Flags ..." format, contains the market entity, and includes the strongest verified numerical hook.
The article has exactly seven H2 sections and five FAQs. At least four H2 headings naturally include the {Geography} + {Market Name} keyword phrase, in varied grammatical forms, without reading as keyword-stuffed.
Each H2 begins with a direct answer.
The market scope is explicitly defined.
Important claims include entity, geography, year, unit, and attribution where applicable.
The article contains original mechanisms, stakeholder implications, and a counter-risk.
No section repeats another section's full fact-and-implication pair.
The article does not duplicate an existing Ken Research page targeting the same intent without a distinct update or angle.
Language is natural, specific, neutral, and free of generic keyword stuffing outside the mandatory H2 keyword requirement above.
Visible article length is 1,450-1,600 words.
Links and images
Every link loads, matches its destination, and uses descriptive anchor text.
No competitor market-research link exists.
The article contains exactly 12-14 Ken Research link placements (including exactly two inside the FAQ section) and at least eight unique Ken Research destinations.
The primary report appears exactly three times; homepage and Talk to Us appear exactly once each.
Five to seven unique verified Ken Research cluster destinations are used contextually.
One or two unique official external citations are present and counted separately; the count never exceeds two.
Every Ken Research href ends with exactly ?utm_source=linkedin-pulse&utm_medium=Referral&utm_campaign=Automation — no &amp; entities, no extra "?" or "&", no casing changes.
Official external links contain no UTM parameters.
Image mode and image validation rules are satisfied.
Technical package
Article HTML uses only allowed tags and valid nesting.
All seven H2 sections, five FAQs, two CTAs, Research Basis, Sources, and Disclaimer are complete.
Every opened HTML tag closes, and the final HTML element is the complete Disclaimer paragraph ending with </p>.
ARTICLE_HTML mode uses real line breaks and contains no literal \\n, \\r, or \\t sequences.
ARTICLE_HTML mode contains no metadata or schema.
CMS_PACKAGE mode parses as JSON and contains exactly the required keys.
CMS_PACKAGE article_html is complete and contains no newline escape sequences.
Metadata character limits are met.
Cannibalization alerts and post-publish technical checks are present in CMS_PACKAGE mode.
Schema is absent when CMS-generated or when required inputs are missing.
Schema and FAQs match visible content exactly.
FINAL RESPONSE
For OUTPUT_MODE: ARTICLE_HTML, return only the validated HTML fragment.
For OUTPUT_MODE: CMS_PACKAGE, return only the validated JSON object.
Do not add explanations, research notes, validation results, or Markdown fences.
<INPUTS> REPORT_TITLE: ${reportTitle} REPORT_URL: ${reportUrl}
OUTPUT_MODE: ARTICLE_HTML
LINK_STYLE_MODE: CMS
IMAGE_MODE: OFF
HERO_IMAGE_URL:
SNAPSHOT_IMAGE_URL:
SHOW_BYLINE: OFF
AUTHOR_NAME: Ken Research
PUBLISHED_DATE:
UPDATED_DATE:
CANONICAL_BLOG_URL:
BREADCRUMB_PARENT_URL:
CMS_GENERATES_SCHEMA: YES
</INPUTS>
You already have everything required to complete this task: REPORT_URL to browse and research yourself, and full authority to search the open web for supporting data. Never respond by asking for the report content, market data, permission, or access to be provided to you — that data does not exist anywhere except through your own research of REPORT_URL and the open web, exactly as every rule above already instructs. A reply that asks for data/permission/access instead of researching and writing is a failed response, identical to an acknowledgement, a plan, or a question.
BEGIN NOW. Your reply must contain only the deliverable defined under FINAL RESPONSE — no acknowledgement, no plan, no questions, and no request for data, permission, or access.`;
}

// ChatGPT's rate-limit / session-nudge popups can appear at any point during
// the ~12-15 min generation, not just at the fixed checkpoints
// dismissBlockingModals() covers (before typing, before sending). A generic
// dialog/overlay is detected by role, then Enter is pressed to dismiss it —
// repeated until it's actually gone (not a fixed count), since some ChatGPT
// dialogs re-render themselves once after the first dismissal.
const GENERIC_POPUP_SELECTOR = '[role="dialog"], [role="alertdialog"]';
const MAX_POPUP_DISMISS_ATTEMPTS = 8;

async function popupPresent(page: Page): Promise<boolean> {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const style = window.getComputedStyle(el as Element);
    return style.display !== 'none' && style.visibility !== 'hidden' && (el as HTMLElement).offsetParent !== null;
  }, GENERIC_POPUP_SELECTOR).catch(() => false);
}

/** Keep pressing Enter for as long as a popup keeps showing up (capped so a stuck dialog can't hang generation forever). */
async function clearPopups(page: Page): Promise<void> {
  for (let i = 0; i < MAX_POPUP_DISMISS_ATTEMPTS; i++) {
    await dismissBlockingModals(page);
    if (!(await popupPresent(page))) return;
    console.log(`   [blog] Popup detected — pressing Enter to dismiss (attempt ${i + 1}/${MAX_POPUP_DISMISS_ATTEMPTS})...`);
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(600);
  }
}

const POPUP_WATCHER_INTERVAL_MS = 1500;

/**
 * Runs dismissBlockingModals() on its own short cycle for the ENTIRE
 * lifetime of the ChatGPT tab — independent of waitForBlogCompletion's
 * 60s poll (POLL_MS), which also doesn't run at all during its first fixed
 * 5-minute wait. Popups (rate-limit/session-nudge/upgrade dialogs) can
 * reappear within seconds and block typing/streaming until dismissed;
 * confirmed live 2026-09-16 that the previous once-a-minute-at-best checking
 * left them sitting long enough to need a manual click. Call the returned
 * stop function in a `finally` so this never outlives the page/context.
 */
function startContinuousPopupWatcher(page: Page): () => void {
  let stopped = false;
  (async () => {
    while (!stopped) {
      await dismissBlockingModals(page).catch(() => {});
      await page.waitForTimeout(POPUP_WATCHER_INTERVAL_MS);
    }
  })().catch(() => {});
  return () => { stopped = true; };
}

/** Wait until the assistant response finished streaming (send re-enabled, text stable). */
async function waitForBlogCompletion(page: Page): Promise<void> {
  const start = Date.now();
  let goneChecks = 0;
  let lastLength = -1;
  let unchangedChecks = 0;
  let tinyStallChecks = 0;
  // Generation takes anywhere from ~5 to ~15 min with no way to know in
  // advance — so just wait 1 min, check, repeat, up to MAX_POLLS times
  // (~15 min total), instead of guessing a blind upfront wait.
  for (let poll = 1; poll <= MAX_POLLS; poll++) {
    await page.waitForTimeout(POLL_MS);
    await clearPopups(page);
    const stopping = await page.locator(STOP_BUTTON_SELECTOR).first().isVisible({ timeout: 2000 }).catch(() => false);
    const text = await lastAssistantText(page);
    console.log(`   …check ${poll}/${MAX_POLLS} at ${Math.round((Date.now() - start) / 60000)} min: ${stopping ? 'still writing' : 'looks finished'} (${text.length} characters so far)`);
    if (!stopping && text.length > 500) {
      goneChecks++;
      if (goneChecks >= 2) return; // Stop button gone for ~2 checks → done
    } else {
      goneChecks = 0;
    }
    // Second, independent completion signal: the Stop-button check can get
    // stuck reporting "still writing" (a UI glitch) even though generation
    // actually finished. If the character count is IDENTICAL for 3 checks in
    // a row, treat that as done regardless of what the Stop button says.
    if (text.length > 500 && text.length === lastLength) {
      unchangedChecks++;
      if (unchangedChecks >= 3) {
        console.log('   Character count unchanged for 3 checks in a row — treating as finished.');
        return;
      }
    } else {
      unchangedChecks = 0;
    }
    // Stalled/dead generation: the response isn't actively streaming
    // ("looks finished") but is far too short to be a real 1,450-1,600 word
    // article, and its length hasn't moved between checks. Without this,
    // a response stuck at e.g. 55 characters never crosses the 500-char
    // threshold above, so neither completion branch fires and this just
    // polls uselessly for the full 30-minute timeout before failing. Fail
    // fast instead — the caller's own per-row retry (see blogGenLoop.ts)
    // already retries once and then moves on to the next row.
    if (!stopping && text.length > 0 && text.length < 500 && text.length === lastLength) {
      tinyStallChecks++;
      if (tinyStallChecks >= 2) {
        throw new Error(`STALLED: ChatGPT response stuck at ${text.length} characters across 2 consecutive checks — treating as a dead generation instead of waiting out the full timeout.`);
      }
    } else {
      tinyStallChecks = 0;
    }
    lastLength = text.length;
  }
}

async function lastAssistantText(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const msgs = document.querySelectorAll(sel);
    let text = msgs.length ? ((msgs[msgs.length - 1] as HTMLElement).innerText || '') : '';
    if (text.replace(/\s/g, '').length < 100) {
      const body = (document.body as HTMLElement).innerText || '';
      const idx = body.lastIndexOf('Title:');
      if (idx >= 0) text = body.slice(idx);
    }
    return text;
  }, ASSISTANT_MESSAGE_SELECTOR);
}

/** Extract Title / Description / HTML from the last assistant message (both code-block and raw-HTML shapes). */
// Section labels the V1.3 prompt's "Return exactly:" list produces, in order
// — used to slice ChatGPT's structured reply into SEO Title / Meta
// Description / Key Snapshot Metrics / FINAL ARTICLE HTML.
const SECTION_LABELS = [
  'SEO Title', 'Meta Description', 'Primary Search Intent', 'Primary Keyword',
  'Secondary Semantic Topics', 'Suggested Snapshot Image Alt',
  'Key Snapshot Metrics for Image', 'Key Qualitative Insights for Image 2',
  'Internal Link Map', 'External Source Map',
  'FINAL ARTICLE',
];

/** Pull the plain-text block between a standalone `label` line and the next known section label (or end of text). */
function extractLabeledSection(text: string, label: string): string {
  const lines = text.split('\n');
  const norm = (s: string) => s.trim().toLowerCase();
  const startIdx = lines.findIndex((l) => norm(l) === norm(label));
  if (startIdx === -1) return '';
  const otherLabels = new Set(SECTION_LABELS.filter((l) => l !== label).map(norm));
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (otherLabels.has(norm(lines[i]))) { endIdx = i; break; }
  }
  return lines.slice(startIdx + 1, endIdx).map((l) => l.trim()).filter(Boolean).join('\n').trim();
}

export interface BlogGenResult {
  title: string;
  description: string;
  html: string;
  seoTitle: string;
  imageData: string;
  /** Raw "Key Qualitative Insights for Image 2" block — Growth Drivers / Competitive Landscape / Regional Landscape — feeds blogLandscapeImageAgent.ts's second mid-blog image. */
  imageData2: string;
}

// The prompt is delivered to ChatGPT as an attached file named
// "chatgpt-prompt-<timestamp>-blog-prompt.txt" (see attachPromptAsTextFile).
// ChatGPT then renders a "file citation" pill for that attachment inside its
// reply — as VISIBLE text, truncated by the UI, e.g.
// "chatgpt-prompt-1790724820272-bl…" — which landed glued onto the end of the
// SEO Title (confirmed 2026-10-05). CITATION_CHIP_RE only knows web-domain
// pills, so this one slipped through. Match the SHAPE (fixed prefix + long
// timestamp + any filename remainder, with or without the UI's ellipsis).
const FILE_PILL_RE = /\s*chatgpt-prompt-\d{6,}-[^\s<>"']*…?/gi;
function stripFilePill(s: string): string {
  return s.replace(FILE_PILL_RE, (m) => {
    console.warn(`   ⚠️  Stripped a ChatGPT file-attachment pill from generated text: "${m.trim()}"`);
    return '';
  }).trim();
}

async function extractBlog(page: Page, fallbackTitle: string): Promise<BlogGenResult> {
  const data = await page.evaluate((sel) => {
    const msgs = document.querySelectorAll(sel);
    const last = msgs.length ? (msgs[msgs.length - 1] as HTMLElement) : null;
    let code = '';
    let text = last ? (last.innerText || '') : '';
    if (last) { const c = last.querySelector('pre code, pre'); code = c ? (c.textContent || '') : ''; }
    if (text.replace(/\s/g, '').length < 100) {
      const body = (document.body as HTMLElement).innerText || '';
      const idx = body.lastIndexOf('SEO Title');
      if (idx >= 0) text = body.slice(idx);
    }
    return { code, text };
  }, ASSISTANT_MESSAGE_SELECTOR);

  const text = data.text || '';
  const stripTags = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

  // ChatGPT's web-search citation pills (a bare domain, optionally followed
  // by "+N" for "and N more sources") render as literal visible text in the
  // chat UI wherever a citation lands — including, confirmed live
  // 2026-09-18, right after the SEO Title and inside the Key Snapshot
  // Metrics list, contaminating both the plain-text title and the
  // downstream chart data with garbage like "kenresearch.com +1".
  const CITATION_CHIP_RE = /\s*(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\s*\+\d+)?\s*$/i;
  const stripCitationChip = (s: string) => stripFilePill(s).replace(CITATION_CHIP_RE, '').trim();
  const isCitationChipLine = (s: string) => /^(?:(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\s*\+\d+)?|\+\d+)$/i.test(s.trim());

  // V1.3 prompt structured deliverable: SEO Title, Meta Description, ...,
  // Key Snapshot Metrics for Image, Internal Link Map, External Source Map,
  // then "FINAL ARTICLE" followed by the publication-ready HTML. These two
  // fields are plain-text metadata — strip any literal "<strong>" etc. that
  // ChatGPT sometimes carries over from the article's bolding rules (its
  // chat UI shows raw HTML as visible text, not live tags, so it leaks
  // straight into these strings if not stripped here).
  const seoTitle = stripCitationChip(stripTags(extractLabeledSection(text, 'SEO Title')));
  const metaDescription = stripCitationChip(stripTags(extractLabeledSection(text, 'Meta Description')));
  // Strip the "5–7 supported metrics" sub-label ChatGPT sometimes echoes as
  // the first line of this section (a prompt instruction, not a metric),
  // and drop any line that's nothing but a leaked citation chip.
  const imageData = extractLabeledSection(text, 'Key Snapshot Metrics for Image')
    .replace(/^\d[\s\S]{0,4}\d?\s*supported metrics\s*\n?/i, '')
    .split('\n')
    .filter((l) => !isCitationChipLine(l))
    .map((l) => stripCitationChip(l))
    .join('\n')
    .trim();

  const imageData2 = extractLabeledSection(text, 'Key Qualitative Insights for Image 2')
    .split('\n')
    .filter((l) => !isCitationChipLine(l))
    .map((l) => stripCitationChip(l))
    .join('\n')
    .trim();

  // Only search for the HTML fragment from the "FINAL ARTICLE" marker
  // onward — everything before it (SEO Title, link maps, source maps) is
  // plain text/metadata, not the article, and must never be mistaken for it.
  const finalArticleIdx = text.search(/^\s*FINAL ARTICLE\s*$/im);
  const htmlSearchText = finalArticleIdx >= 0 ? text.slice(finalArticleIdx) : text;

  let html = '';
  if (data.code && data.code.includes('<')) {
    html = data.code.trim();
  } else {
    // Raw HTML in the message text: from the first tag to the last tag (drops
    // any trailing page chrome like "ChatGPT can make mistakes" / "Sources").
    const firstTag = htmlSearchText.indexOf('<');
    html = firstTag >= 0 ? htmlSearchText.slice(firstTag) : htmlSearchText;
    const lastTag = html.lastIndexOf('>');
    if (lastTag >= 0) html = html.slice(0, lastTag + 1);
    html = html.trim();
  }

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const firstPMatch = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  const blogTitle = h1Match ? stripFilePill(stripTags(h1Match[1])) : (seoTitle || fallbackTitle);
  const description = metaDescription || (firstPMatch ? stripTags(firstPMatch[1]).slice(0, 170) : '');

  return { title: blogTitle, description, html, seoTitle: seoTitle || blogTitle, imageData, imageData2 };
}

// A popup can still land exactly while extractBlog() reads the DOM (race
// between the poll loop above and the modal re-rendering). Clear popups,
// extract, clear again, and repeat until two consecutive extractions agree
// on HTML length — protects against a mid-scrape popup silently truncating
// the extracted HTML.
const MAX_EXTRACTION_STABILITY_CHECKS = 4;

async function extractBlogStable(page: Page, fallbackTitle: string): Promise<BlogGenResult> {
  let last: BlogGenResult | null = null;
  let previousLen = -1;

  for (let i = 0; i < MAX_EXTRACTION_STABILITY_CHECKS; i++) {
    await clearPopups(page);

    last = await extractBlog(page, fallbackTitle);
    const len = last.html.length;
    console.log(`   [blog] Extraction check ${i + 1}/${MAX_EXTRACTION_STABILITY_CHECKS}: ${len} chars`);

    await clearPopups(page);

    if (len > 0 && len === previousLen) {
      console.log('   [blog] Char count stable across checks — accepting extraction.');
      return last;
    }
    previousLen = len;
  }

  console.log(`   [blog] Char count did not fully stabilize after ${MAX_EXTRACTION_STABILITY_CHECKS} checks — using last extraction anyway.`);
  return last!;
}

/** Fix ChatGPT quirks: mis-encoded closing quotes (%22) and web-search citation tags. */
function sanitizeHtml(html: string): string {
  return html
    .replace(/%22(?=[\s>])/g, '"')   // closing attribute quote emitted as %22
    .replace(/%22$/g, '"')
    // ChatGPT occasionally wraps an href/src URL in its OWN extra pair of
    // quotes on top of the real attribute quotes — e.g.
    // href=""https://...automation"" — which breaks the link entirely
    // (confirmed live 2026-09-18). Collapse the doubled quote down to one.
    .replace(/(href|src)="{2,}(https?:\/\/[^"]+?)"{2,}/gi, '$1="$2"')
    // ChatGPT's internal tool/citation markup (web-search citations, and
    // whatever else it may emit) always has the same underlying shape:
    // "[:]word-word[optional-bracket-part]{...index...}" — e.g. the old
    // ":contentReference[oaicite:0]{index=0}", a renamed variant confirmed
    // live 2026-09-28, ":chatgpt-content-reference{index=\"9\"}", and a
    // THIRD variant confirmed live 2026-09-29 that drops the leading colon
    // entirely: "chatgpt-content-reference{index=\"9\"}" — the original
    // regex required that colon and let this one straight through into
    // published content. Matching each exact name is whack-a-mole — ChatGPT
    // keeps changing the exact spelling — so this matches the SHAPE instead:
    // an optional leading colon, a hyphenated identifier, an optional
    // bracket part, and a brace group that contains "index" (real prose
    // never contains a literal "word{index...}" token, colon or not).
    // Logs each strip so a genuinely new artifact shape gets noticed, not
    // silently swallowed forever.
    .replace(/\s*:?[\w-]+(?:\[[^\]]*\])?\{[^}]*index[^}]*\}/gi, (match) => {
      console.warn(`   ⚠️  Stripped a ChatGPT tool-markup artifact from generated HTML: "${match.trim()}"`);
      return '';
    })
    // File-attachment citation pill for the attached prompt file (see FILE_PILL_RE).
    .replace(FILE_PILL_RE, '')
    .trim();
}

/**
 * Ensure every kenresearch.com link carries the correct UTM params — strips
 * whatever ChatGPT wrote and rebuilds fresh with the LinkedIn Pulse UTM
 * (matches every platform poster's own injectUTM call downstream, so this is
 * really just what shows up before any platform-specific posting overrides it).
 */
function injectBlogUtm(html: string): string {
  return injectUTM(html, UTM_PARAMS.LinkedinPulse);
}

async function isLoggedIn(page: Page): Promise<boolean> {
  return page.locator(COMPOSER_SELECTOR).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
}

// Minimizes the window to the taskbar (not headless — the account still needs
// a real, logged-in-looking browser) via CDP; '--start-minimized' alone is
// unreliable once the page has already navigated. Best-effort — a failure
// here should never abort generation.
async function minimizeToTaskbar(context: BrowserContext, page: Page): Promise<void> {
  try {
    const cdp = await context.newCDPSession(page);
    const { windowId } = await (cdp as any).send('Browser.getWindowForTarget');
    await (cdp as any).send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await cdp.detach().catch(() => {});
  } catch { /* ignore if CDP unavailable */ }
}

// Diagnostic only — never blocks for a manual login and never aborts the
// run. These generate scripts run unattended under the cron daemon, where
// nobody is watching to log in by hand, so the old 120s manual-login wait
// just stalled the batch before failing anyway.
async function logChatGptSessionState(page: Page): Promise<void> {
  console.log(await isLoggedIn(page)
    ? '   ✅ ChatGPT: session active (composer visible)'
    : '   ⚠️  ChatGPT: composer not visible — continuing anyway (session may be expired)');
}

/**
 * Generate one blog article via the user's own logged-in ChatGPT session.
 * Launches its own persistent Chrome context (session dir per account),
 * sends the master prompt, waits ~12-15 min, extracts and sanitizes the
 * result, then closes that context. Throws on failure so the caller can
 * retry/skip. Independent of blogImageAgent.ts's browser — safe to run both
 * concurrently via Promise.all.
 */
export async function generateBlogViaChatGpt(params: {
  title: string;
  url: string;
  accountHandle?: string;
  /**
   * undefined/'v1' (default) = the normal 50/50 split between the master
   * prompt and the Prompt B pool. 'v2' = the keyword-focused
   * buildMasterBlogPromptV2, fully separate from the split. 'master' =
   * force buildMasterBlogPrompt every time, skipping the 50/50 split
   * entirely — for manually testing the master prompt itself.
   */
  promptVersion?: 'v1' | 'v2' | 'master';
}): Promise<BlogGenResult> {
  const accountName = params.accountHandle || DEFAULT_BLOG_ACCOUNT;
  const sessionDir = sessionDirForAccount(accountName);
  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  const chromePath = fs.existsSync(CHROME_PATH) ? CHROME_PATH : chromium.executablePath();
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1366, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      // Match the OS window size to the viewport — otherwise Chrome opens
      // at a mismatched size and the page renders skewed/zoomed with parts
      // cut off, before minimizeToTaskbar() below hides it anyway.
      '--window-size=1366,900',
      '--window-position=0,0',
    ],
  });

  let stopPopupWatcher: () => void = () => {};
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await minimizeToTaskbar(context, page);
    await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    await logChatGptSessionState(page);

    stopPopupWatcher = startContinuousPopupWatcher(page);

    let promptLabel = 'v1 (master)';
    let prompt: string;
    if (params.promptVersion === 'master') {
      prompt = buildMasterBlogPrompt(params.title, params.url);
      promptLabel = 'v1 (master, forced — Prompt B rotation skipped)';
    } else if (params.promptVersion === 'v2') {
      prompt = buildMasterBlogPromptV2(params.title, params.url);
      promptLabel = 'v2 (keyword-focused)';
    } else if (Math.random() < PROMPT_B_ROTATION_CHANCE) {
      const variant = PROMPT_B_BUILDERS[Math.floor(Math.random() * PROMPT_B_BUILDERS.length)];
      prompt = variant.build(params.title, params.url);
      promptLabel = `Prompt B (${variant.name})`;
    } else {
      prompt = buildMasterBlogPrompt(params.title, params.url);
    }
    console.log(`   [blog:${accountName}] Sending blog prompt (${promptLabel}) for: "${params.title}" (~12-15 min generation)...`);
    // The master prompt is ~45-50k characters — long enough that a clipboard
    // paste unreliably lands as either composer text or an auto-converted
    // file attachment (confirmed live, see attachPromptAsTextFile's doc
    // comment). Attach it as a real .txt file directly instead.
    //
    // Without an explicit instruction, ChatGPT treats a bare file attachment
    // conversationally — it reads the file, summarizes what it calls for,
    // and asks "If you want, I can execute the full prompt now" instead of
    // just doing it (confirmed live 2026-09-28). This instruction forces
    // immediate execution with zero commentary.
    await attachPromptAsTextFile(page, prompt, {
      filename: 'blog-prompt.txt',
      instruction: 'Execute the attached prompt file exactly and immediately. Do not summarize it, do not describe what it calls for, and do not ask for confirmation — just produce the full deliverable it specifies, starting with "SEO Title", right now.',
    });
    await page.waitForTimeout(1000);

    // The blocking modal can re-render itself seconds after being removed —
    // check again right before the send click, not just once before typing.
    await dismissBlockingModals(page);
    const sendBtn = page.locator(SEND_BUTTON_SELECTOR).first();
    async function clickSend(): Promise<boolean> {
      if (!(await sendBtn.isVisible({ timeout: 3000 }).catch(() => false))) return false;
      await sendBtn.click();
      return true;
    }

    // A click (or Enter fallback) can silently no-op — confirmed live
    // 2026-09-28: right after attachPromptAsTextFile, the file was still
    // finishing its upload/processing when the click fired, so the whole
    // prompt sat unsent in the composer while waitForBlogCompletion below
    // burned through its full ~15-min poll budget seeing 0 characters the
    // entire time. Verify the send actually registered — the Stop button or
    // a new assistant message appearing — before committing to that long
    // wait, and retry a few times if it didn't.
    async function trySendAndConfirm(): Promise<boolean> {
      if (!(await clickSend())) await page.keyboard.press('Enter').catch(() => {});
      return await Promise.race([
        page.locator(STOP_BUTTON_SELECTOR).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false),
        page.locator(ASSISTANT_MESSAGE_SELECTOR).first().waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false),
      ]);
    }

    let sent = false;
    const MAX_SEND_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS && !sent; attempt++) {
      await dismissBlockingModals(page);
      sent = await trySendAndConfirm();
      if (!sent && attempt < MAX_SEND_ATTEMPTS) {
        console.log(`   [blog:${accountName}] ⚠️ Send did not register (attempt ${attempt}/${MAX_SEND_ATTEMPTS}) — retrying...`);
        await page.waitForTimeout(2000);
      }
    }
    if (!sent) {
      throw new Error('SEND_NOT_CONFIRMED: Could not confirm the blog prompt was actually sent after 3 attempts (no Stop button or assistant message appeared).');
    }

    await waitForBlogCompletion(page);
    console.log(`   [blog:${accountName}] ChatGPT finished writing — extracting the blog...`);
    let { title, description, html, seoTitle, imageData, imageData2 } = await extractBlogStable(page, params.title);

    // ChatGPT sometimes answers the master prompt with a *review* of it
    // ("I have reviewed the uploaded prompt... I can now generate the
    // ARTICLE_HTML output") instead of the article — a plain-text preamble
    // with no <h1>/<h2> at all. Seen live 2026-09-07 on a survey-page row.
    // Nudge it once with a follow-up message telling it to proceed, then
    // wait/extract again — rather than failing the row on "No HTML content".
    const looksLikeArticle = (h: string) => /<h1[\s>]/i.test(h) && /<h2[\s>]/i.test(h);
    if (!looksLikeArticle(html)) {
      console.warn(`   [blog:${accountName}] ⚠️ Response has no <h1>/<h2> — ChatGPT replied with a preamble instead of the article. Sending "proceed" nudge...`);
      // Two failure shapes share this branch: a plain acknowledgement
      // ("I have reviewed the prompt...") and a refusal dressed as HTML
      // ("<p>Unable to complete... survey page rather than a market-sizing
      // report...</p>"). The nudge therefore restates the survey fallback
      // procedure explicitly, not just "proceed".
      const refusal = /unable to complete|cannot complete|not available from|could not be verified/i.test(html);
      if (refusal) console.warn(`   [blog:${accountName}] ⚠️ Response is a refusal — re-sending with the survey/adjacent-market procedure spelled out.`);
      const nudge = [
        'That reply is not an accepted output. Explanations, acknowledgements and "unable to complete" messages are failed responses.',
        'Apply the MANDATORY PROCEDURE FOR SURVEY / SERVICE / METHODOLOGY INPUTS from the prompt: derive the adjacent market from REPORT_TITLE and the page geography (drop words like survey, buyer experience, feedback, study), search the open web for that market\'s size, CAGR and forecast, lock the DATA_SPINE from verified pages, and present those figures as Ken Research market intelligence. Use the survey topic as the article\'s analytical angle.',
        'Now output only the deliverable defined under "Return exactly": SEO Title, Meta Description, Primary Search Intent, Primary Keyword, Secondary Semantic Topics, Suggested Snapshot Image Alt, Key Snapshot Metrics for Image, Internal Link Map, External Source Map, then FINAL ARTICLE with the complete clean HTML article. Nothing else.',
      ].join(' ');
      await dismissBlockingModals(page);
      await pasteIntoChatGptComposer(page, nudge);
      await page.waitForTimeout(800);
      if (!(await clickSend())) await page.keyboard.press('Enter');
      await waitForBlogCompletion(page);
      console.log(`   [blog:${accountName}] Nudge response finished — extracting the blog...`);
      ({ title, description, html, seoTitle, imageData, imageData2 } = await extractBlogStable(page, params.title));
      if (!looksLikeArticle(html)) {
        throw new Error('PREAMBLE_ONLY: ChatGPT replied with an acknowledgement instead of the article, even after a "proceed" nudge.');
      }
    }

    // The prompt instructs ChatGPT to return exactly this sentence (nothing
    // else) when it genuinely can't verify the primary report page after
    // retrying — detect it explicitly rather than relying only on the
    // length check below, since it could theoretically get wrapped in
    // enough surrounding text to slip past `html.length < 100` and get
    // saved as if it were real blog content.
    if (html.includes('RESEARCH BLOCKED') || html.includes('Primary report could not be verified')) {
      throw new Error(`RESEARCH_BLOCKED: ChatGPT could not verify the primary report page for "${params.title}" (${params.url}) — check the URL is reachable and correct.`);
    }

    // The prompt's LINK ARCHITECTURE rules require 12-14 Ken Research link
    // placements across 5-7 unique cluster destinations; ChatGPT is told to
    // return exactly this sentence (nothing else) when it can't verify
    // enough of them — detect it explicitly so the caller can retry with a
    // fresh browser instead of it falling through to the generic
    // "No HTML content extracted" failure below.
    if (html.includes('LINK VALIDATION BLOCKED')) {
      throw new Error(`LINK_VALIDATION_BLOCKED: ChatGPT could not verify 12+ Ken Research link placements for "${params.title}" (${params.url}).`);
    }

    if (!html || html.length < 100) {
      throw new Error('No HTML content extracted from ChatGPT response');
    }

    recordChatGptSuccess();
    return {
      title: sanitizeHtml(title),
      description: sanitizeHtml(description),
      html: injectBlogUtm(sanitizeHtml(html)),
      seoTitle: sanitizeHtml(seoTitle),
      imageData: sanitizeHtml(imageData),
      imageData2: sanitizeHtml(imageData2),
    };
  } catch (err: any) {
    const { rotated, account } = recordChatGptFailure();
    if (rotated) err.message = `${err.message} (rotated out — next attempt uses "${account}")`;
    throw err;
  } finally {
    stopPopupWatcher();
    await context.close().catch(() => {});
  }
}
