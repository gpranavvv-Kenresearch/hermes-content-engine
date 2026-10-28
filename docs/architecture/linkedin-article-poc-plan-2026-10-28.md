# LinkedIn Article POC: ready plan and prompt draft (28 Oct 2026)

Audience: the user (Hinglish speaker) and any agent building this. Companion to `platform-content-plan-2026-10-28.md`. Nothing here is built. The prompt in section 5 is a draft awaiting approval.

## 1. Goal of the POC

Write LinkedIn **native articles** (not feed posts) that (a) get indexed by Google, (b) get cited by AI answer engines, (c) send B2B readers to Ken Research report pages. Prove it on LinkedIn first, then copy the approach to Medium, HackMD, Reddit.

Row sourcing, quotas (15/25/30/15) and "fewer rows than quota" are **not our concern**: the user manages the rows. Do not design around them.

## 2. What the research says (second pass, 28 Oct)

Reliability: official LinkedIn help pages are solid. Everything else is vendor blogs or snippets; treat as directional.

Official LinkedIn (help a6244140, a521719, 130533):
- Manage > SEO settings: **SEO title** replaces the title on Google (cut at 60 characters); **SEO description** replaces the first lines on Google (140-160 characters).
- Cover image JPG/PNG/WEBP, best 1920x1080. No tables in the editor. Desktop browser only.
- No canonical option exists (third-party claim, consistent with the editor). So the article must be a **genuinely rewritten piece**, not the blog text pasted.
- Professional Community Policies prohibit false information. Never publish a number that is not in the evidence.

AI-citation findings (Semrush study of 325k prompts; MarketingProfs chart; PromiseClick):
- Articles of 500-2,000 words are cited most. Native articles beat feed posts for citation.
- **Listicles and side-by-side comparisons are the most cited B2B format; all 24 most-cited articles had bulleted or numbered lists.** Since tables are not supported, use bullet lists and "Option A versus Option B" bullet pairs.
- 54-64% of cited content is advice or knowledge, not promotion. About 95% is original.
- Articles and feed posts grew from 26.9% to 34.9% of LinkedIn citations (Nov 2025 to Feb 2026) while profile-page citations fell from 33.9% to 14.5%. A good article matters more than a good profile.
- Perplexity cites company pages; ChatGPT Search and Google AI Mode lean to individuals. Publishing from personal profiles (as the user plans) fits two of three engines.
- Recently updated content is cited more. Put the year and "as of <month year>" in the piece.

Not confirmed anywhere: whether Google ranks LinkedIn articles on page 1 for market-report keywords, and whether article links carry a reach penalty. The POC itself is the test (see section 7).

What already ranks for market-research keywords on LinkedIn: templated vendor syndication (market name + CAGR + dollar figure + year, 450-900 words, some with "XX%" placeholders). Ken's edge: original analysis with a named analyst, a clear answer, a decision angle, and verified government sources.

## 3. Personas (the 15 accounts)

LinkedIn profile pages return HTTP 999 to the fetch tool, so **no profile was read**. Facts that can be said from the list alone:
- 15 links, 14 look like personal profiles (Aniket Sanduja appears twice with different IDs; one is probably a duplicate or second account), one is a **post URL** (`feed/update/urn:li:activity:7516768327185137664`), not a profile. Remove or replace it.
- Profiles look like Ken Research team members, not senior public experts. Whatever their titles are, the article voice must stay truthful.

Persona rules for the prompt (no invented credentials):
- Voice is "we / our analysis at **Ken Research**", with the author's name and role supplied from a persona field, never made up. Do not write "20 years of experience", "as a CFO", or any personal anecdote.
- A persona record per account, filled by the user (or pasted from each profile): name, current title, vertical focus (for example agriculture, fintech, auto, FMCG), country focus. Used for two things only: the byline line at the end and matching topic to account so each account builds a coherent subject area. A profile that posts on one vertical is cited more than one that posts on everything.
- Suggested mapping: one or two verticals per account, 1 article per account per day at 15 accounts. Avoid the same article text on two accounts.
- Account hygiene (user's side, outside the engine): complete headline "Market Research Analyst at Ken Research", about section that names the verticals, profile photo, company page linked as employer. Share each article to the company page too. Cheap and raises trust.

To finish this section I need, per account: name, title, vertical. The user can paste a short table, or open the profiles in the browser pane and I read them.

## 4. Article shape (what changes versus the Ken blog)

| Item | Ken blog (V1.3) | LinkedIn article |
|---|---|---|
| Voice | Brand | Named analyst, "our analysis", Ken Research bold in the first evidence sentence |
| Length | long-form | 900-1,500 words |
| Opening | intro | direct answer in first two sentences: size, CAGR, main driver |
| Headings | per structure | 3-5 H2s phrased as questions, each with one data point |
| Lists | optional | required: at least one bullet or numbered list and one side-by-side comparison in bullets |
| Tables | banned | banned |
| Links | exactly 9 | 5-7 (see 6) |
| Close | report CTA | "What to watch" + one discussion question + one soft report line |
| Extras | none | SEO title, SEO description, share-post caption, first-comment text |
| Bold | numbers + brand | brand bold; numbers bold sparingly (max about 8) |
| Em dashes | none | none |

Hard rules carried over: no invented figures, no invented URLs, links only to Ken Research and government sites, every URL opened and verified before it is used.

## 5. Prompt draft (platform-scoped, own file: `browser-generation/prompts/platform-content/linkedin-article.txt`)

Placeholders `{{REPORT_TITLE}}`, `{{REPORT_URL}}`, `{{EVIDENCE}}`, `{{ANALYST_NAME}}`, `{{ANALYST_ROLE}}`, `{{VERTICAL}}`, `{{GOV_LINKS}}` (list of already-verified government URLs), `{{ADJACENT_LINKS}}`.

```
You are writing one LinkedIn native article for a B2B reader (strategy, investment, procurement or product teams) who is deciding something about this market. The article must be useful without clicking anything, original, and checkable.

REPORT: {{REPORT_TITLE}}
REPORT URL: {{REPORT_URL}}
AUTHOR: {{ANALYST_NAME}}, {{ANALYST_ROLE}} at Ken Research (focus: {{VERTICAL}})
EVIDENCE (the only source of facts about this report):
{{EVIDENCE}}
VERIFIED GOVERNMENT LINKS YOU MAY USE: {{GOV_LINKS}}
VERIFIED ADJACENT KEN LINKS: {{ADJACENT_LINKS}}

FACT RULES
- Use only figures that appear in EVIDENCE or in a verified government link. Never invent a number, source, ranking or quote.
- You may derive simple arithmetic; label it "our calculation".
- If a fact is missing, leave it out. Never write placeholders such as XX%.
- Do not invent personal experience, titles, client stories or years of experience for the author.
- State the base year and forecast year of every figure. Add "as of <month year>".

STRUCTURE
1. TITLE: under 100 characters. Keyword first, a question or claim, with one number and the year. No brand in the title. No clickbait.
2. SEO TITLE: at most 60 characters. SEO DESCRIPTION: 140 to 160 characters, with the market keyword and one number.
3. ARTICLE, 900 to 1,500 words, plain text with markdown headings, no tables, no em dashes:
   - First two sentences: the direct answer (market size, growth, main driver).
   - First evidence sentence attributes the finding to **Ken Research** (bold).
   - 3 to 5 H2 headings written as questions a buyer would ask. Under each, one data point and one plain-language implication.
   - At least one bullet list of drivers or risks, and one side-by-side comparison written as paired bullets (Option A: ... / Option B: ...).
   - A short "What to watch" section with 2 to 3 bullets.
   - One closing discussion question that invites a specific practical experience, obstacle or first check. No "which matters most" menus.
   - One soft line pointing to the full report.
4. SHARE POST: 2 to 3 sentences for the feed, one number, no link.
5. FIRST COMMENT: one sentence plus the report URL and one extra statistic.

LINKS (5 to 7 total, each used once, none invented)
- 1 report URL ({{REPORT_URL}}), placed after the first evidence section, not in the first paragraph.
- 1 Ken Research homepage link in the closing line.
- 2 to 3 government links from the verified list, attached to the exact claim they support.
- 1 adjacent Ken link only if it fits; otherwise none.

STYLE
- Short paragraphs of one to three sentences. Plain words. No hype words (revolutionary, game-changing, unlock, landscape).
- Bold only **Ken Research** and at most 8 key numbers.
- Do not start two headings with the same word.

OUTPUT, in this order, with these labels:
TITLE
SEO TITLE
SEO DESCRIPTION
ARTICLE
DISCUSSION QUESTION
SHARE POST
FIRST COMMENT
SELF-CHECK (word count, link count, every figure traced to EVIDENCE or a government link: yes/no)
```

## 6. Decisions I recommend (user to confirm)

1. **Links: 5-7**, not 9. Nine links on a third-party platform look like spam; articles tolerate links better than feed posts, but there is no evidence for 9. Report link + homepage + 2-3 government + optional adjacent.
2. Publish from **personal profiles**, then also share to the company page.
3. Wait for the Ken blog version to be indexed before posting the LinkedIn version where possible (there is no canonical on LinkedIn). The LinkedIn text is a rewrite, never the same words.
4. Nothing goes into the engine until a sample is approved.

## 7. How we will know it works (POC scorecard, check after about 20 articles)

- Indexed: `site:linkedin.com/pulse "<exact title>"` in Google.
- Rank: exact title and the market keyword; position recorded.
- AI citation: ask ChatGPT Search, Perplexity and Google AI Mode the question the article answers; note whether it is cited.
- Clicks and leads: UTM on the report link (`utm_source=linkedin&utm_medium=article&utm_campaign=<account>`), and form fills or enquiries tied to those UTMs.
- Kill or change rule: if after 20 articles none are indexed and none get clicks, change the format before scaling.

## 8. Build order after approval

1. User approves section 5 prompt and section 6 decisions, supplies the persona table.
2. Add `platform-supervisor/` module (separate, blog engine untouched): LinkedIn tab bootstrapper (A = URL, B = Title, then status, account, article, SEO title, SEO description, share post, first comment, generated at, notes), prompt file, parser for the labelled output, measurements (word count, link count and domain allow-list, no tables, no em dashes, brand bold, no placeholders), Hermes role file, runner with checkpoint, `platform:sample` that writes nothing to the Sheet.
3. Show 2-3 local samples. Only then enable Sheet writes.

## 9. Open items

- Persona table for the 15 accounts (name, title, vertical).
- Replace the post URL in the account list with a profile URL; confirm whether the two Aniket Sanduja links are two real accounts.
- Approve 5-7 links.
