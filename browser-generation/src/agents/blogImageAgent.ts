/**
 * blogImageAgent.ts — generate a market-report cover image via ChatGPT
 * (DALL-E 3), driving the user's own logged-in ChatGPT session, then upload
 * it to Google Drive for a public, hotlinkable URL (utils/googleDriveUpload.ts).
 *
 * Two selectable, fully self-contained prompts (each does its own market
 * research, color/industry selection, and layout) — pick with promptChoice
 * '1' | '2' (default '1').
 *
 * Usage:
 *   const url = await generateBlogCoverImage({
 *     marketName: 'India Cold Storage Market',
 *     reportUrl: 'https://www.kenresearch.com/industry-reports/india-cold-storage-market',
 *   });
 */

import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { sessionDirForAccount } from '../config/chatGptAccountTracker.js';
import { killChromeForProfile } from '../utils/killChrome.js';
import { pasteIntoChatGptComposer, dismissBlockingModals } from '../utils/chatgptComposer.js';
import { recordChatGptFailure, recordChatGptSuccess } from '../config/chatGptAccountTracker.js';
import { uploadFileToGoogleDrive } from '../utils/googleDriveUpload.js';

// Matches both the old #prompt-textarea id and the new UI's bare
// div.ProseMirror composer (no id) — see the comment on the canonical
// definition in src/browser/chatgpt/login.ts for the full explanation.
const COMPOSER_SELECTOR = '#prompt-textarea, div[contenteditable="true"].ProseMirror';
// Matches both the old data-message-author-role attribute and the new UI's
// div[data-markdown-text-style="assistant-message"] — see the comment on
// blogGenAgent.ts's copy of this constant for the full explanation.
const ASSISTANT_MESSAGE_SELECTOR = '[data-message-author-role="assistant"], [data-markdown-text-style="assistant-message"]';

// Dedicated account for cover-IMAGE generation — kept separate from
// blogGenAgent.ts's default account so the two always run in separate
// Chrome profiles/windows and can run concurrently.
const DEFAULT_IMAGE_ACCOUNT = 'account2';
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const TMP_DIR = path.resolve('generated_images');
const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label*="Send"]',
];

// ── Image prompt 1 — research-heavy, structured "canvas architecture" layout.
// Self-contained: does its own research, color selection, and layout — no
// local sector/color logic needed.
function imagePrompt1(name: string, reportUrl: string): string {
  return `Act as a senior market researcher and premium editorial data-visualization designer.
Your task is to independently research the supplied market, validate its most important statistics, select an industry-appropriate visual identity, and create a production-ready market-intelligence cover image.
USER INPUT
Market/Report Title: "${name}"
Primary Report URL: "${reportUrl}"
Current Year: Use the actual current year.
Do not ask the user to supply market values, CAGR, forecast figures, statistics, colors, or visual concepts. Research and select them yourself.
PHASE 1: MARKET RESEARCH
Before generating the image, search the internet and verify the market information.
Research in this priority order:
Open and analyze the exact Primary Report URL.
Use official government departments, regulators, statistical agencies, and ministries.
Use recognized multilateral organizations such as the World Bank, WHO, OECD, IEA, ITU, FAO, UN agencies, or regional authorities where relevant.
Use credible industry associations, public company filings, and authoritative sector publications.
Avoid using competing market-research-company pages when the supplied report or official sources provide the required data.
Find and validate the following:
Correct market name and geographic scope
Base year
Base-year market value
Forecast year
Forecast market value
Forecast CAGR
Leading product, technology, application, channel, or segment
One verified market-share or adoption statistic
Two or three additional quantitative market indicators
One important qualitative trend if a reliable numerical statistic is unavailable
Possible supporting indicators include:
Unit shipments
User or subscriber count
Online channel share
Production volume
Installed capacity
Average selling price
Technology adoption
Import or export value
Regulatory target
Infrastructure coverage
Premium-product adoption
Digital penetration
Regional contribution
DATA-VALIDATION RULES
Never fabricate a market value, CAGR, percentage, year, unit, currency, or forecast.
Never mix global data with country- or region-specific data.
Never mix adjacent markets unless the distinction is clearly disclosed.
Keep market definitions, geography, currency, base year, and forecast period consistent.
Give priority to the exact supplied report when credible sources show different market estimates.
Recalculate the CAGR when base and forecast values are available:
CAGR = ((Forecast Value ÷ Base Value) ^ (1 ÷ Number of Years) − 1) × 100
If the recalculated CAGR materially conflicts with the published CAGR, use the published figure only when the report clearly defines a different forecast period.
Do not create intermediate annual market values unless they are published by a source.
If only the base and forecast values are available, label only those two endpoints on the chart.
Do not present estimated or interpolated values as published facts.
If a reliable market valuation cannot be found, use verified adoption, shipment, capacity, penetration, or regulatory statistics instead.
When reliable numerical data is unavailable, use concise qualitative language rather than inventing a number.
RESEARCH OUTPUT
Before generating the image, provide a concise validation table containing:
Metric
Selected value
Year
Source name
Direct source URL
Keep this research table outside the image. Do not display source URLs or citations inside the final cover.
PHASE 2: INDUSTRY AND COLOR SELECTION
Identify the market's primary industry and select the color palette yourself.
Choose one dominant accent color and one supporting accent color that match the industry's visual language.
Suggested direction:
Healthcare, medical devices, pharmaceuticals: crimson, medical red, cyan, or clinical blue
Banking, fintech, insurance: electric blue, violet, cyan, or deep emerald
Renewable energy and sustainability: emerald, teal, or clean green
Oil, gas, mining, and heavy industry: amber, copper, orange, or steel blue
Automotive and mobility: electric blue, orange, or metallic cyan
Consumer electronics, ICT, and software: violet, indigo, blue, or neon cyan
Food, agriculture, and natural products: green, olive, gold, or warm amber
Logistics, warehousing, and supply chain: navy, cyan, teal, or orange
Construction and infrastructure: amber, safety orange, yellow, or steel blue
Luxury, beauty, hospitality, and travel: magenta, burgundy, gold, or rose
Aerospace and defense: steel blue, graphite, cyan, or restrained red
Education and professional services: blue, indigo, or turquoise
These are guidelines, not fixed assignments. Select the palette that best represents the specific market.
Color requirements:
State the selected industry and hexadecimal color codes in the research summary.
Use a dark near-black background.
Maintain strong contrast between text and background.
Use the dominant accent for figures, chart lines, icons, and highlights.
Use the supporting accent sparingly for depth.
Avoid oversaturation and excessive neon effects.
Do not automatically use purple for every market.
PHASE 3: IMAGE GENERATION
Create a premium 16:9 landscape market-intelligence cover.
Generate at 2048×1152 pixels in high quality. The composition must remain suitable for export at 1920×1080.
VISUAL STANDARD
The cover should resemble a sophisticated editorial intelligence visual from Bloomberg Intelligence, Bain, McKinsey, or a premium financial publication.
It must feel:
Authoritative
Data-driven
Cinematic
Contemporary
Photorealistic
Executive-grade
Suitable for LinkedIn, report promotion, and corporate publishing
Follow the canvas architecture and layout rules below directly — do not copy products, text, statistics, maps, branding, or exact designs from any outside source.
CANVAS ARCHITECTURE
Left information zone: approximately 38–42%.
Center and right hero zone: approximately 58–62%.
Maintain a minimum 6% safe margin on every side.
Create a clear reading sequence:
Market title
Base-year valuation
CAGR and forecast
Supporting market insight
Hero visual
Forecast chart
Bottom indicator panel
BACKGROUND
Use a cinematic dark gradient built from near-black, charcoal, and the selected industry colors.
Add:
Subtle atmospheric haze
Restrained volumetric lighting
Fine digital texture
Soft reflections
Faint analytical gridlines
A low-opacity map or geographic outline representing the market region
The geographic map must remain subtle and must not interfere with the title.
TITLE AREA
Render the researched market title EXACTLY.
Use a bold premium geometric sans-serif typeface.
Display the title across two to four balanced lines.
Typography treatment:
Geographic region or country in white
Primary market keywords in the dominant accent color
Strong contrast
Clean spacing
No awkward word breaks
No text touching the canvas edges
Add a short horizontal accent line beneath the title.
PRIMARY VALUATION
Display:
"[VERIFIED BASE-YEAR MARKET VALUE]"

"([BASE YEAR])"
Make the market value the most prominent numerical element on the left.
Use white for the currency and the dominant accent color for the numerical value.
CAGR AND FORECAST
Add a clean growth icon and display:
"[VERIFIED CAGR]% CAGR"

"to [VERIFIED FORECAST VALUE] by [FORECAST YEAR]"
Highlight the CAGR and forecast value with the dominant accent color. Keep supporting text white.
If the CAGR or forecast value cannot be verified, remove this block and replace it with a verified market indicator.
SECONDARY MARKET INSIGHT
Display one concise, verified insight such as:
"Online channel share rising to [VALUE]% by [YEAR]"
or:
"[SEGMENT] accounts for [VALUE]% of demand"
or another relevant verified indicator.
Use one simple sector-relevant outline icon.
Keep this insight under 12 words wherever possible.
HERO VISUAL
Independently determine the most relevant hero scene for the market.
Show two to four high-quality visual elements representing the market ecosystem.
Examples:
Products or equipment
Relevant infrastructure
Digital devices and interfaces
Industrial machinery
Healthcare technology
Vehicles and mobility systems
Renewable-energy infrastructure
Consumer goods
Agricultural environments
Logistics facilities
Place the primary hero object near the center-right. Use smaller supporting objects to create depth and market context.
Hero requirements:
Photorealistic
Generic and unbranded
Realistic materials and proportions
Cinematic rim lighting
Controlled depth of field
Subtle reflections
Industry-relevant environment
No copied commercial-product design
DATA-VISUALIZATION LAYER
Integrate a premium upward-trending line or area chart in the upper-right background.
Chart requirements:
Use the selected dominant accent color.
Include a subtle glow.
Use restrained gridlines.
Include circular markers only when meaningful.
Keep the chart visually behind the hero subject.
Do not let the chart cross through important text.
Label only verified values.
If only base and forecast values are known, show only those endpoint labels.
Never invent intermediate annual figures.
At the final data point, display:
"[VERIFIED FORECAST VALUE]"

"[FORECAST YEAR]"
If no reliable forecast value exists, use a qualitative trend visualization without numerical labels.
BOTTOM INTELLIGENCE PANEL
Add a semi-transparent dark glass panel across the lower-left or lower-middle area.
Panel styling:
Rounded corners
Thin border using the dominant accent
Subtle internal glow
Clean vertical dividers
High text contrast
Include a maximum of three verified indicators.
Recommended structure:
Indicator 1:

"[SHORT LABEL]"

"[CURRENT VALUE] → [FORECAST VALUE]"
Indicator 2:

"[SHORT LABEL]"

"[CURRENT VALUE] → [FORECAST VALUE]"
Indicator 3:

"[SHORT LABEL]"

"[VERIFIED VALUE OR SHORT TREND]"
Use a simple outline icon for each indicator.
Do not use paragraphs, citations, disclaimers, or tiny typography inside this panel.
TEXT-CONTROL RULES
Render only the approved title and verified data selected during research.
Preserve spelling, currency, decimals, units, percentages, and years exactly.
Do not paraphrase the report title.
Do not add random text.
Do not repeat a statistic unnecessarily.
Do not invent company names.
Keep text short enough to remain readable on mobile devices.
Use no more than approximately 65–75 words across the entire cover.
Prefer three accurate statistics over many unreadable statistics.
BRANDING RESTRICTIONS
No Ken Research name unless explicitly requested
No company names
No logos
No monograms
No trademarks
No watermarks
No branded products
No copied user interfaces
No competitor branding
FINAL QUALITY CONTROL
After generating the image, inspect it carefully.
Verify:
The market title is spelled correctly.
The geographic region is correct.
All figures match the research table.
Currency units are correct.
CAGR and forecast years are correct.
No fabricated values appear.
Text is legible and correctly placed.
No text is clipped.
No random characters appear.
No logo or brand name appears.
The map matches the market geography.
The color palette suits the industry.
The hero visual accurately represents the market.
The layout remains readable at LinkedIn-feed size.
The chart does not imply unsupported annual figures.
If any title, number, percentage, unit, or year is incorrect or unreadable, repair or regenerate the image before presenting the final result.
NEGATIVE PROMPT
No fabricated statistics, incorrect market values, conflicting forecast years, fake citations, competitor data presented as primary data, random text, spelling mistakes, tiny paragraphs, clipped typography, duplicate objects, distorted products, inaccurate maps, irrelevant hero visuals, logos, company names, trademarks, watermarks, cluttered dashboards, excessive neon, oversaturated colors, cartoon graphics, cheap stock-photo aesthetics, low resolution, weak contrast, or generic template appearance.
FINAL RESPONSE
Return:
The research validation table with direct source links.
The identified industry.
The selected dominant and supporting colors with hexadecimal codes.
The completed 16:9 cover image.
Do not stop after research. Proceed directly to image generation once the selected statistics have been validated.`;
}

// ── Image prompt 2 — immersive editorial/cinematic layout, single continuous
// scene rather than a structured left/right split.
function imagePrompt2(name: string, reportUrl: string): string {
  return `Act as an elite market-intelligence researcher, creative director, and editorial data-visualization designer.
Create one visually striking, production-ready 16:9 market-intelligence cover for:
MARKET TITLE: "${name}"
REPORT URL: "${reportUrl}"
REFERENCE STYLE: Use this image only as a benchmark for premium quality and data-rich storytelling—not as a layout that must be copied:
https://lh3.googleusercontent.com/d/13G9f9b25YxH3UUniIzHYaBBK3zPo3Dzf
Complete the research, creative direction, color selection, composition, and image generation as one continuous task. Do not stop to present a research table, design plan, or intermediate output. Proceed directly to the finished image.
RESEARCH AND DATA ACCURACY
First, privately research the market using the supplied report URL as the primary source.
Identify:
Correct market title and geographic scope
Most recent reliable market value
Valuation year
Forecast market value
Forecast year
CAGR
One leading segment, channel, technology, or application
Two additional high-value quantitative market indicators
If information is missing from the report page, search reliable government sources, regulators, statistical agencies, international organizations, industry associations, and authoritative sector publications.
Do not use conflicting estimates from competitor market-research firms when the supplied report contains the required information.
Never fabricate a value, CAGR, percentage, currency, year, segment share, shipment figure, or forecast.
Do not combine statistics from different geographies or adjacent markets.
If a reliable figure cannot be verified, omit it and use a concise qualitative market trend instead.
Use no more than five major statistics in the image. Prioritize accuracy, relevance, and visual impact over information volume.
AUTONOMOUS CREATIVE DIRECTION
Identify the industry and independently choose the most appropriate visual language, hero subject, environment, lighting style, data-visualization treatment, and color palette.
Choose:
One dominant industry-appropriate accent color
One complementary supporting color
A dark cinematic background family
A high-contrast neutral color for typography
Do not automatically use purple, red, or blue for every market.
The selected palette should feel psychologically and commercially appropriate for the industry:
Healthcare should feel clinical, trusted, advanced, and human
Technology should feel intelligent, connected, and futuristic
Finance should feel secure, precise, and premium
Renewable energy should feel clean, progressive, and sustainable
Industrial markets should feel powerful, engineered, and operational
Consumer markets should feel desirable, contemporary, and energetic
Luxury markets should feel refined, exclusive, and editorial
Logistics should feel connected, efficient, and infrastructure-led
Agriculture should feel natural, productive, and innovation-driven
Automotive should feel dynamic, engineered, and performance-oriented
VISUAL CONCEPT
Create one cohesive full-bleed editorial scene—not a rigid split-screen template and not a collection of disconnected infographic boxes.
The composition should feel immersive and cinematic, with natural visual flow across the entire canvas.
Use an asymmetrical editorial layout that adapts to the market:
Position the market title within clean negative space.
Make the industry hero visual the central storytelling element.
Integrate statistics into the environment instead of placing everything inside a fixed dashboard.
Allow selected objects, charts, lighting effects, and data signals to visually connect different parts of the composition.
Maintain balance without creating an obvious 50/50 division.
Avoid repetitive "text on the left, product on the right" execution when a more compelling composition is possible.
HERO SCENE
Create a photorealistic hero scene that immediately communicates the market.
Select the most meaningful combination of:
Products
Technology
Infrastructure
Equipment
Professional users
Digital interfaces
Geographic context
Industrial environments
Consumer-use scenarios
Supply-chain elements
Use one dominant focal subject supported by two or three secondary elements.
The primary subject should have:
Realistic scale and proportions
Premium material detail
Cinematic rim lighting
Natural reflections
Controlled depth of field
Strong silhouette
Clear separation from the background
Build depth using foreground, middle-ground, and background layers.
Add restrained atmospheric elements where appropriate:
Volumetric light
Soft haze
Reflections
Subtle particles
Network signals
Energy trails
Data streams
Environmental texture
Geographic contours
These effects should enhance the subject rather than make the image excessively futuristic or artificial.
DATA STORYTELLING
Integrate data visualization organically into the hero scene.
The visualization should relate to the industry:
Technology: network paths, signal waves, connected nodes
Finance: analytical curves, secure transaction flows, digital grids
Energy: capacity curves, power flows, infrastructure networks
Logistics: routes, movement paths, warehouse or port connections
Healthcare: patient pathways, clinical signals, diagnostic interfaces
Automotive: mobility routes, telemetry, charging or traffic patterns
Consumer products: adoption curves, channel growth, product ecosystems
Industrial markets: production paths, capacity indicators, operational systems
Use one principal visualization, such as:
A luminous growth curve
A restrained area chart
A geographic data path
A network visualization
An adoption trajectory
A capacity or volume indicator
Do not add a generic chart simply to fill space.
Label only verified values. Never invent intermediate annual data points.
If only the starting and forecast values are available, show only those verified endpoints.
TYPOGRAPHY AND INFORMATION HIERARCHY
Render the exact market title prominently and verbatim:
"${name}"
Use a premium geometric sans-serif typeface with strong kerning and clean line spacing.
Break the title into two to four balanced lines. Avoid awkward single-word lines.
Create a clear hierarchy:
Market title
Primary market value
CAGR and forecast value
One high-impact market insight
Up to two supporting indicators
Make the market value the strongest numerical element.
Suggested data treatment:
"[VERIFIED MARKET VALUE]"

"[VALUATION YEAR]"
"[VERIFIED CAGR]% CAGR"

"to [VERIFIED FORECAST VALUE] by [FORECAST YEAR]"
All text must be short, bold, high-contrast, and readable at LinkedIn-feed size.
Render every required text element exactly once.
Do not display source URLs, citations, methodology, paragraphs, or disclaimers inside the image.
INTEGRATED STATISTIC CALLOUTS
Display supporting statistics as elegant editorial callouts integrated into available negative space.
They may appear as:
Minimal floating glass capsules
Large standalone numbers
Fine-line annotations
Labels connected to relevant objects
Geographic data markers
Subtle translucent overlays
Do not create a large bottom dashboard.
Do not place all statistics inside identical boxes.
Use no more than three supporting callouts. Each should contain a short label and one meaningful value.
PREMIUM ART DIRECTION
The final image should feel comparable to a high-end Bloomberg Intelligence feature, global consulting publication, institutional-investor presentation, or premium technology campaign.
Aim for:
Strong visual tension
Clear focal hierarchy
Sophisticated asymmetry
Photorealistic materials
Rich but controlled contrast
Elegant negative space
Cinematic lighting
Editorial restraint
Modern data storytelling
Premium commercial finish
The cover must remain visually engaging even when viewed without reading every statistic.
OUTPUT REQUIREMENTS
16:9 landscape
1920×1080 pixels
High-resolution rendering
Sharp, legible typography
Minimum 6% safe margin
No clipped text
No important elements touching the edges
Suitable for LinkedIn, blogs, report pages, PR distribution, and social media
STRICT RESTRICTIONS
No fabricated statistics
No incorrect currencies or years
No competitor market-research figures presented as primary data
No logos
No Ken Research branding unless explicitly requested
No company names
No trademarks
No branded products
No watermarks
No random decorative words
No stock-photo collage
No rigid corporate-template appearance
No large bottom dashboard
No excessive infographic boxes
No crowded composition
No excessive neon
No cartoon or illustration style
No distorted products, people, machinery, or infrastructure
No meaningless futuristic holograms
No repeated title or statistics
No unreadable microtext
FINAL SELF-CHECK
Before delivering the image, visually inspect it and confirm:
The title is spelled exactly as supplied.
The market geography is correct.
Every displayed statistic is verified.
Currency, units, decimals, percentages, and years are accurate.
The colors appropriately represent the industry.
The hero scene clearly communicates the market.
The statistics feel integrated into the visual story.
The image does not resemble a rigid split-screen template.
The composition remains clear at thumbnail size.
No random text, logo, brand name, or watermark appears.
No text is clipped, duplicated, misspelled, or unreadable.
If any text, number, year, currency, or layout element is incorrect, repair the image before delivering the final result.
Return only the completed market-intelligence cover image. Do not provide the research process, source table, explanation, or design rationale.`;
}

function buildImagePrompt(name: string, reportUrl: string, promptChoice: string): string {
  return promptChoice === '2' ? imagePrompt2(name, reportUrl) : imagePrompt1(name, reportUrl);
}

// ── Multi-selector image finder (waits 1 min, checks, repeats up to 15x) ──
// Generation time varies and there's no way to know it in advance, so just
// wait 1 min, check, repeat — up to MAX_POLLS times (~15 min total hard cap)
// — instead of guessing a fixed timeout.
const POLL_MS = 60 * 1000;
const MAX_POLLS = 15;
async function findGeneratedImage(page: Page): Promise<{ src: string; naturalWidth: number; naturalHeight: number }> {
  const started = Date.now();
  for (let poll = 1; poll <= MAX_POLLS; poll++) {
    await page.waitForTimeout(POLL_MS);

    const found = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const candidates = imgs.filter((img: any) => Math.max(img.naturalWidth || 0, img.naturalHeight || 0) >= 800);
      if (!candidates.length) return null;
      const target = candidates[candidates.length - 1] as any;
      return { src: target.src, naturalWidth: target.naturalWidth, naturalHeight: target.naturalHeight };
    });

    if (found && found.src) {
      console.log(`   Image found: ${found.naturalWidth}x${found.naturalHeight}`);
      return found;
    }

    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`   …check ${poll}/${MAX_POLLS} at ${elapsed}s: no image yet`);
  }
  throw new Error('Generated image not found after timeout (no img with naturalWidth/Height >= 800)');
}

// Best-effort capture of whatever text ChatGPT wrote alongside the image
// (research notes, a validation summary, etc.) — purely observational for
// now (written to New Logic!Z "Image text" so it can be reviewed over the
// next few days), never allowed to fail or block image generation itself.
async function lastAssistantText(page: Page): Promise<string> {
  return page.evaluate((sel) => {
    const msgs = document.querySelectorAll(sel);
    return msgs.length ? ((msgs[msgs.length - 1] as HTMLElement).innerText || '') : '';
  }, ASSISTANT_MESSAGE_SELECTOR).catch(() => '');
}

async function trySendClick(page: Page): Promise<boolean> {
  for (const sel of SEND_SELECTORS) {
    if (await page.locator(sel).last().isVisible({ timeout: 3000 }).catch(() => false)) {
      await page.locator(sel).last().click();
      return true;
    }
  }
  return false;
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
 * Core generation: sends the cover-image prompt to ChatGPT (DALL-E 3), waits
 * for the image, downloads it, and saves it to `outputDir` (defaults to
 * generated_images/). Returns the local path only — no upload. Launches its
 * own persistent Chrome context (session dir per account) — independent of
 * blogGenAgent.ts's browser, so the two can run at the same time via
 * Promise.all instead of fighting over one shared browser/page.
 */
async function runCoverImageGeneration(params: {
  marketName: string;
  reportUrl: string;
  promptChoice?: '1' | '2';
  accountHandle?: string;
  outputDir?: string;
}): Promise<{ localPath: string; imageText: string }> {
  const accountName = params.accountHandle || DEFAULT_IMAGE_ACCOUNT;
  const promptChoice = params.promptChoice || '1';
  const prompt = buildImagePrompt(params.marketName, params.reportUrl, promptChoice);
  const outputDir = params.outputDir || TMP_DIR;

  fs.mkdirSync(outputDir, { recursive: true });

  const sessionDir = sessionDirForAccount(accountName);
  fs.mkdirSync(sessionDir, { recursive: true });
  await killChromeForProfile(sessionDir);

  const chromePath = fs.existsSync(CHROME_PATH) ? CHROME_PATH : chromium.executablePath();
  const context = await chromium.launchPersistentContext(sessionDir, {
    headless: false,
    executablePath: chromePath,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await minimizeToTaskbar(context, page);
    await page.goto('https://chatgpt.com/new', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    await logChatGptSessionState(page);

    console.log(`   [image:${accountName}] Sending cover-image prompt for: "${params.marketName}" (up to ~15 min)...`);
    await pasteIntoChatGptComposer(page, prompt);
    await page.waitForTimeout(1000);

    await dismissBlockingModals(page);
    let sendClicked = false;
    try {
      sendClicked = await trySendClick(page);
    } catch {
      await dismissBlockingModals(page);
      await page.waitForTimeout(1000);
      sendClicked = await trySendClick(page);
    }
    if (!sendClicked) await page.keyboard.press('Enter');

    const generatedImage = await findGeneratedImage(page);

    // Stability wait — ChatGPT swaps the low-res preview for the full-res image shortly after.
    console.log('   Stability wait (30s)...');
    await page.waitForTimeout(30 * 1000);

    const finalImage = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const candidates = imgs.filter((img: any) => Math.max(img.naturalWidth || 0, img.naturalHeight || 0) >= 800);
      if (!candidates.length) return null;
      const target = candidates[candidates.length - 1] as any;
      return { src: target.src, naturalWidth: target.naturalWidth, naturalHeight: target.naturalHeight };
    });
    const imgSrc = finalImage?.src || generatedImage.src;
    if (!imgSrc) throw new Error('Could not resolve final image src after stability wait');

    // Download via browser fetch (preserves auth cookies). "Failed to
    // fetch" here is almost always a transient network blip, not a real
    // failure — confirmed live 2026-09-18 the image WAS found and stable,
    // only the fetch() call itself hiccuped. Retry the fetch in place
    // rather than closing the browser and losing the (already-generated,
    // already-found) image entirely.
    console.log('   Downloading generated image...');
    const MAX_DOWNLOAD_ATTEMPTS = 4;
    let base64Data = '';
    let downloadErr: any = null;
    for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        base64Data = await page.evaluate(async (url: string) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
          const blob = await response.blob();
          return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }, imgSrc);
        downloadErr = null;
        break;
      } catch (err: any) {
        downloadErr = err;
        console.log(`   ⚠️ Image download attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS} failed: ${err.message}`);
        if (attempt < MAX_DOWNLOAD_ATTEMPTS) await page.waitForTimeout(4000);
      }
    }
    if (downloadErr) throw downloadErr;

    const imageBuffer = Buffer.from(base64Data, 'base64');
    const publicId = `${params.marketName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 55)}-${Math.floor(Date.now() / 1000)}`;
    const localPath = path.resolve(path.join(outputDir, `${publicId}.png`));
    fs.writeFileSync(localPath, imageBuffer);
    console.log(`   Saved locally: ${localPath}`);

    const imageText = await lastAssistantText(page);

    recordChatGptSuccess();
    return { localPath, imageText };
  } catch (err: any) {
    const { rotated, account } = recordChatGptFailure();
    if (rotated) err.message = `${err.message} (rotated out — next attempt uses "${account}")`;
    throw err;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Generate a market-report cover image via ChatGPT (DALL-E 3), download it,
 * and upload to Google Drive for a public URL.
 */
export async function generateBlogCoverImage(params: {
  marketName: string;
  reportUrl: string;
  promptChoice?: '1' | '2';
  accountHandle?: string;
}): Promise<string> {
  const { localPath } = await runCoverImageGeneration(params);
  const { url } = await uploadFileToGoogleDrive(localPath);
  console.log(`   Uploaded to Google Drive: ${url}`);
  return url;
}

/**
 * Same as generateBlogCoverImage, but also returns whatever text ChatGPT
 * wrote alongside the image (research notes, a validation summary, etc.).
 * Separate export so existing generateBlogCoverImage callers (which expect
 * a plain string URL) are unaffected — only blogGenLoop.ts uses this, to
 * log the text into New Logic!Z ("Image text") for a few days of observation.
 */
export async function generateBlogCoverImageWithText(params: {
  marketName: string;
  reportUrl: string;
  promptChoice?: '1' | '2';
  accountHandle?: string;
}): Promise<{ url: string; imageText: string }> {
  const { localPath, imageText } = await runCoverImageGeneration(params);
  const { url } = await uploadFileToGoogleDrive(localPath);
  console.log(`   Uploaded to Google Drive: ${url}`);
  return { url, imageText };
}

/**
 * Generate a market-report cover image via ChatGPT (DALL-E 3) and save it to
 * local disk only — no Google Drive upload. Returns the absolute local path,
 * for flows that write the file path (not a hosted URL) back to a sheet.
 */
export async function generateCoverImageLocalOnly(params: {
  marketName: string;
  reportUrl: string;
  promptChoice?: '1' | '2';
  accountHandle?: string;
  outputDir?: string;
}): Promise<string> {
  const { localPath } = await runCoverImageGeneration(params);
  return localPath;
}
