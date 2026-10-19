/**
 * sheets.ts — Google Sheets Integration (Unified Single Tab)
 * All platforms (X, Facebook, LinkedIn) in one "insta" tab.
 *
 * Auth: Google Service Account JSON
 * Place your service account JSON at: .accounts/google-service-account.json
 * OR set GOOGLE_SERVICE_ACCOUNT_JSON env var with the JSON string
 */

import { google } from 'googleapis';
import 'dotenv/config';

// ──── History-safe helpers ──────────────────────────────────────────────────

/** Appends newVal to existing cell with ' | ' separator. Skips if newVal empty or duplicate. */
function appendValue(existing: string | undefined, newVal: string): string {
  if (!newVal) return existing ?? '';
  const trimmed = (existing ?? '').trim();
  if (!trimmed) return newVal;
  const parts = trimmed.split(' | ');
  if (parts[parts.length - 1].trim() === newVal.trim()) return trimmed;
  return `${trimmed} | ${newVal}`;
}

/** Extracts most-recent date from a possibly-appended value like "2025-01-15 | 2025-01-16". */
function latestDate(value: string): string {
  const parts = value.split(' | ');
  return (parts[parts.length - 1] ?? '').split('T')[0].trim();
}

// Sheet configuration for different platform types
const SOCIAL_SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ'; // X, FB, LI
const SOCIAL_SHEET_NAME = 'Social Media';

const BLOG_SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ'; // Medium, Dev.to, Google Sites, Linkmate, LinkedIn Pulse
const BLOG_SHEET_NAME = 'Blogs';

const ALGO_SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ'; // Algo Reports tab
const ALGO_SHEET_NAME = 'Algo Reports';

const CONTENT_POOL_SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ'; // Content Pool tab (group-batch source)
const CONTENT_POOL_SHEET_NAME = 'Content Pool';

const NEW_LOGIC_SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ'; // New Logic tab — 3-slot independent posting (Linkmate/Calisthenics/HackMD/Blogger/Notion/Dev.to/Coda/LinkedIn Pulse/WordPress)
const NEW_LOGIC_SHEET_NAME = 'New Logic';

// RSS Extraction tab — raw landing zone for every item the Tech Team RSS feed
// reports. Nothing reads from this tab automatically yet; it exists so the
// full raw feed is captured, with the Social Media / New Logic feed-in logic
// to be built against it later (see PRD_RSS_Content_Distribution.md).
const RSS_EXTRACTION_SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const RSS_EXTRACTION_SHEET_NAME = 'RSS Extraction';

// Newsletter campaign tab — manual input (3-4 report URLs + prospect emails
// per row), content generated via ChatGPT, sent via Outlook. Separate from
// the New Logic-reuse newsletter path in the "New Logic (Outlook)" section
// further down, which sends already-generated blog content instead.
const NEWSLETTER_CAMPAIGN_SHEET_ID = '1p_N3zzJbUx-7t8sjuAtbQsHaUfVmYxytQU_gDd2MGwQ';
const NEWSLETTER_CAMPAIGN_SHEET_NAME = 'Newsletter';

// Helper to get sheet config based on platform
function getSheetConfig(platform?: 'social' | 'blog' | 'pool' | 'newLogic' | 'rssExtraction' | 'newsletterCampaign'): { id: string; name: string } {
  if (platform === 'blog') {
    return { id: BLOG_SHEET_ID, name: BLOG_SHEET_NAME };
  }
  if (platform === 'pool') {
    return { id: CONTENT_POOL_SHEET_ID, name: CONTENT_POOL_SHEET_NAME };
  }
  if (platform === 'newLogic') {
    return { id: NEW_LOGIC_SHEET_ID, name: NEW_LOGIC_SHEET_NAME };
  }
  if (platform === 'rssExtraction') {
    return { id: RSS_EXTRACTION_SHEET_ID, name: RSS_EXTRACTION_SHEET_NAME };
  }
  if (platform === 'newsletterCampaign') {
    return { id: NEWSLETTER_CAMPAIGN_SHEET_ID, name: NEWSLETTER_CAMPAIGN_SHEET_NAME };
  }
  return { id: SOCIAL_SHEET_ID, name: SOCIAL_SHEET_NAME }; // default to social
}

// Backwards-compatible default (for functions that don't specify)
const SHEET_ID   = SOCIAL_SHEET_ID;
const SHEET_NAME = SOCIAL_SHEET_NAME;

export type SheetType = 'social' | 'blog' | 'pool' | 'newLogic' | 'rssExtraction';

export interface SheetRow {
  rowIndex: number;         // 1-based row index in sheet (for updates)
  sheetType?: SheetType;
  title: string;
  seedKeyword?: string;     // keyword for hashtags/SEO (e.g., "logistics", "robotics")
  descriptionTitle?: string; // alternative/meta description title for blogs
  description?: string;      // SEO description / article description
  blogSeoTitle?: string;    // "Blog SEO Title" column
  blogSeoDescription?: string; // "Blog SEO Description" column
  blogCaption?: string;     // "Blog Caption" column
  coverImageUrl?: string;   // "Cover Image URL" column
  localImagePath?: string;  // "Local Image Path" column (ChatGPT-generated blog cover, saved to local disk)
  socialPostImagePath?: string; // "Social Post Image Path" column (ChatGPT-generated text-post card, saved to local disk)
  targetUrl: string;
  marketValue: string;      // fetched from Tavily at post time (not read from sheet)
  cagr?: string;            // fetched from report page (not read from sheet)
  batch: number;
  date: string;
  name: string;             // account nickname/handle to post from
  newName?: string;         // platform-specific override (e.g. Medium uses "New Name" column)
  priority?: string;        // manual priority hint (e.g. 'high', 'low')
  lastPostedX?: string;     // last X post date
  lastPostedFb?: string;    // last FB post date
  lastPostedLi?: string;    // last LI post date
  lastPostedMedium?: string;    // last Medium post date
  lastPostedLinkmate?: string;  // last Linkmate post date
  // SEO analysis columns (written by seoAgent before posting)
  seoIndexed?: string;      // 'yes' | 'no'
  seoPage?: string;         // exact Google position e.g. '3', '55', '100+', 'N/A'
  seoKeywords?: string;     // comma-separated trending keywords
  seoRanking?: string;      // P1/P2/P3 priority based on ranking
  lastSerpCheckDate?: string; // When SERP was last checked (YYYY-MM-DD)
  priorityAssignedDate?: string; // When priority was assigned (YYYY-MM-DD)
  platforms?: string;       // 'x' | 'x,facebook' | 'x,facebook,linkedin' etc.
  // Unified content column
  blogContent?: string;     // HTML content for Medium, Linkmate, Google Sites
  // X columns
  xThread?: string;         // if non-empty → post as thread instead of single tweet
  xPost?: string;
  xPostUrl?: string;
  xStatus?: string;
  xError?: string;
  // Facebook columns
  fbPost?: string;
  fbPostUrl?: string;
  fbStatus?: string;
  fbError?: string;
  // Tumblr columns
  tumblrPost?: string;
  tumblrPostUrl?: string;
  tumblrStatus?: string;
  tumblrError?: string;
  // LinkedIn columns
  linkedinPost?: string;
  linkedinPostUrl?: string;
  linkedinStatus?: string;
  linkedinError?: string;
  // Instagram columns
  instagramPost?: string;
  instagramPostUrl?: string;
  instagramStatus?: string;
  instagramError?: string;
  instagramBatch?: string;
  lastPostedInstagram?: string;
  // Medium columns
  mediumPost?: string;
  mediumPostUrl?: string;
  mediumStatus?: string;
  mediumError?: string;
  // Linkmate columns
  linkMateContent?: string;
  linkMatePostUrl?: string;
  linkMateStatus?: string;
  linkMateError?: string;
  // Google Sites columns
  googleSitePost?: string;
  googleSitePostUrl?: string;
  googleSiteStatus?: string;
  googleSiteError?: string;
  // Batch tracking columns (written after each post)
  xBatch?: string;        // "Batch 1" ... "Batch 13"
  fbBatch?: string;       // "Batch 1" ... "Batch 5"
  tumblrBatch?: string;   // "Batch 1" ...
  lastPostedTumblr?: string;
  liBatch?: string;       // "Batch 1" ... "Batch 3"
  mediumBatch?: string;      // "Batch 1" ... Medium batches (max 1/day)
  linkmateBatch?: string;    // "Batch 1" ... Linkmate batches (max 3/day)
  googleSiteBatch?: string;  // "Batch 1" ... Google Sites batches
  lastPostedGoogleSite?: string; // last Google Sites post date
  // Dev.to columns
  devtoPostUrl?: string;
  devtoStatus?: string;
  devtoError?: string;
  devtoBatch?: string;
  lastPostedDevto?: string; // last Dev.to post date
  // LinkedIn Pulse columns
  linkedinPulsePostUrl?: string;
  linkedinPulseStatus?: string;
  linkedinPulseError?: string;
  linkedinPulseBatch?: string;
  lastPostedLinkedinPulse?: string; // last LinkedIn Pulse post date
  // Calisthenics columns
  calisthenicsPostUrl?: string;
  calisthenicsStatus?: string;
  calisthenicsError?: string;
  calisthenicsNBatch?: string;
  lastPostedCalisthenics?: string; // last Calisthenics post date
  // Substack columns
  substackPostUrl?: string;
  substackStatus?: string;
  substackError?: string;
  substackBatch?: string;
  lastPostedSubstack?: string; // last Substack post date
  // HackMD columns
  hackmdPostUrl?: string;
  hackmdStatus?: string;
  hackmdError?: string;
  hackmdBatch?: string;
  lastPostedHackmd?: string; // last HackMD post date
  // WordPress columns
  wordpressPostUrl?: string;
  wordpressStatus?: string;
  wordpressError?: string;
  wordpressBatch?: string;
  lastPostedWordpress?: string;
  // Blogger columns
  bloggerPostUrl?: string;
  bloggerStatus?: string;
  bloggerError?: string;
  bloggerBatch?: string;
  lastPostedBlogger?: string;
  // Patreon columns
  patreonPostUrl?: string;
  patreonStatus?: string;
  patreonError?: string;
  patreonBatch?: string;
  lastPostedPatreon?: string;
  // Notion columns
  notionPostUrl?: string;
  notionStatus?: string;
  notionError?: string;
  notionBatch?: string;
  lastPostedNotion?: string;
  // Note columns
  notePostUrl?: string;
  noteStatus?: string;
  noteError?: string;
  noteBatch?: string;
  lastPostedNote?: string;
  vcruPostUrl?: string;
  vcruStatus?: string;
  vcruError?: string;
  vcruBatch?: string;
  lastPostedVcru?: string;
  // Naver columns
  naverPostUrl?: string;
  naverStatus?: string;
  naverError?: string;
  naverBatch?: string;
  lastPostedNaver?: string;
  // Velog columns
  velogPostUrl?: string;
  velogStatus?: string;
  velogError?: string;
  velogBatch?: string;
  lastPostedVelog?: string;
  // Coda columns
  codaPostUrl?: string;
  codaStatus?: string;
  codaError?: string;
  codaBatch?: string;
  lastPostedCoda?: string;
  // Paragraph columns
  paragraphPostUrl?: string;
  paragraphStatus?: string;
  paragraphError?: string;
  paragraphBatch?: string;
  lastPostedParagraph?: string;
  // Instapaper columns
  instapaperUrl?: string;
  instapaperNote?: string;
  instapaperStatus?: string;
  instapaperError?: string;
  instapaperBatch?: string;
  lastPostedInstapaper?: string;
  // Raindrop columns
  raindropUrl?: string;
  raindropNote?: string;
  raindropStatus?: string;
  raindropError?: string;
  raindropBatch?: string;
  lastPostedRaindrop?: string;
  // Pearltrees columns
  pearltreesUrl?: string;
  pearltreesStatus?: string;
  pearltreesError?: string;
  pearltreesBatch?: string;
  lastPostedPearltrees?: string;
  // PdfHost columns
  pdfhostUrl?: string;
  pdfhostStatus?: string;
  pdfhostError?: string;
  pdfhostBatch?: string;
  lastPostedPdfhost?: string;
  // 4shared columns
  fourSharedUrl?: string;
  fourSharedStatus?: string;
  fourSharedError?: string;
  fourSharedBatch?: string;
  lastPostedFourShared?: string;
  // Scribd columns
  scribdUrl?: string;
  scribdStatus?: string;
  scribdError?: string;
  scribdBatch?: string;
  lastPostedScribd?: string;
  // Mastodon columns
  mastodonPost?: string;
  mastodonPostUrl?: string;
  mastodonStatus?: string;
  mastodonError?: string;
  mastodonBatch?: string;
  lastPostedMastodon?: string;
  // Generated file paths
  pdfPath?: string;
  pptxPath?: string;
  // Carousel / media
  imagesUrl?: string;
  sevenSlide?: string; // "7Slide" column — local PDF path from the 7-slide storyline carousel (li-carousel-storyline/)
  // Content Pool group-batch columns
  groupAssigned?: string;   // 'Group1' | 'Group2' | 'Group3' | 'Group4' | 'Group1b' | ... (blank = unclaimed)
  claimedAt?: string;       // ISO timestamp when claimed by a group batch
}

// Backwards-compatible alias used by facebookPostingAgent and linkedinPostingAgent
export type SocialSheetRow = SheetRow;

// ──── Retry wrapper for quota errors ─────────────────────────────────────
// Retries on "Quota exceeded" / "Resource has been exhausted" with exponential backoff.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function withRetry<T = any>(fn: () => Promise<T>, label = 'Sheets'): Promise<T> {
  const MAX_RETRIES = 5;
  let delay = 5000;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      const isQuota =
        msg.includes('Quota exceeded') ||
        msg.includes('Resource has been exhausted') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('rateLimitExceeded') ||
        msg.includes('userRateLimitExceeded');
      if (isQuota && attempt < MAX_RETRIES) {
        const jitter = Math.random() * 1000;
        const wait = delay + jitter;
        console.warn(`   ⚠️  ${label} quota — waiting ${Math.round(wait / 1000)}s then retrying (${attempt + 1}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, wait));
        delay = Math.min(delay * 2, 60_000);
      } else {
        throw err;
      }
    }
  }
  throw new Error(`${label}: max retries exceeded`);
}

// ──── Auth ──────────────────────────────────────────────────────────────

async function getSheetsClient() {
  let credentials: object;

  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else {
    const fs = (await import('fs')).default;
    const raw = fs.readFileSync('.accounts/google-service-account.json', 'utf8');
    credentials = JSON.parse(raw);
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

// ──── Column map (0-indexed, header-row-driven) ──────────────────────────

interface ColMap {
  [key: string]: number;
}

async function getColumnMap(sheets: any, sheetId: string = SHEET_ID, sheetName: string = SHEET_NAME): Promise<ColMap> {
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${sheetName}!1:1`,
  }), 'getColumnMap');
  const headers: string[] = res.data.values?.[0] ?? [];
  const map: ColMap = {};
  headers.forEach((h, i) => {
    const trimmed = h.trim();
    map[trimmed] = i;
    map[trimmed.toLowerCase()] = i;
  });
  return map;
}

// ──── Helper: pick first defined column index from multiple name variants ────

function col(colMap: ColMap, ...names: string[]): number | undefined {
  for (const n of names) {
    if (colMap[n] !== undefined) return colMap[n];
    if (colMap[n.toLowerCase()] !== undefined) return colMap[n.toLowerCase()];
  }
  return undefined;
}

// ──── Read rows for a batch (picks rows where column M is empty) ──────────

export async function getTodaysBatchRows(batch: number): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getTodaysBatchRows');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowBatch = Number(row[col(colMap, 'batch') ?? -1] ?? -1);

    if (rowBatch !== batch) continue;

    // Skip rows that already have an X Status (already posted/attempted)
    const xStatusVal = row[col(colMap, 'X Status', 'x status') ?? -1] ?? '';
    if (xStatusVal.trim()) continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  if (results.length === 0) {
    const origHeaders = Object.keys(colMap).filter(k => k === k.trim() && k !== k.toLowerCase());
    console.log(`   ⚠️  Sheet headers found: ${origHeaders.join(', ')}`);
  }
  console.log(`   📄 Found ${results.length} rows for batch ${batch}`);
  return results;
}

// ──── Map raw sheet row to SheetRow interface ───────────────────────────

function mapRow(row: string[], colMap: ColMap, rowIndex: number, sheetType: SheetType = 'social'): SheetRow {
  const g = (colMap: ColMap, ...names: string[]) => {
    const idx = col(colMap, ...names);
    return idx !== undefined ? (row[idx] ?? '') : '';
  };

  return {
    rowIndex,
    sheetType,
    title:            g(colMap, 'Blog Title', 'blog title', 'Title', 'title', 'Main Title', 'Report Title', 'report title'),
    seedKeyword:      g(colMap, 'Seed Keyword', 'seed keyword', 'seedKeyword'),
    descriptionTitle: g(colMap, 'Blog SEO Title', 'blog seo title', 'Title', 'title', 'Main Title'),
    description:      g(colMap, 'Blog Description', 'blog description', 'Blog SEO Description', 'blog seo description', 'Description', 'description'),
    blogSeoTitle:     g(colMap, 'Blog SEO Title', 'blog seo title'),
    blogSeoDescription: g(colMap, 'Blog SEO Description', 'blog seo description'),
    blogCaption:      g(colMap, 'Blog Caption', 'blog caption'),
    coverImageUrl:    g(colMap, 'Cover Image URL', 'cover image url'),
    localImagePath:   g(colMap, 'Local Image Path', 'local image path'),
    socialPostImagePath: g(colMap, 'Social Post Image Path', 'social post image path'),
    targetUrl:        g(colMap, 'targetUrl', 'targeturl', 'Download Report URL', 'Report URL', 'Target URL', 'URL', 'url'),
    marketValue:     g(colMap, 'market_value', 'marketValue', 'market value'),
    cagr:            g(colMap, 'cagr') || undefined,
    batch:           Number(g(colMap, 'Batch', 'batch', 'S.No') || -1),
    date:            g(colMap, 'Date to Be Published', 'date to be published', 'date'),
    name:            g(colMap, 'Name', 'name'),
    newName:         g(colMap, 'New Name', 'new name', 'newName'),
    priority:        g(colMap, 'priority', 'seoRanking', 'seoranking'),
    lastPostedX:     g(colMap, 'lastPostedX', 'lastpostedx'),
    lastPostedFb:    g(colMap, 'lastPostedFb', 'lastpostedfb'),
    lastPostedLi:    g(colMap, 'lastPostedLi', 'lastpostedli'),
    // SEO columns
    seoIndexed:      g(colMap, 'seoIndexed', 'seoindexed'),
    seoPage:         g(colMap, 'seoPage', 'seopage'),
    seoKeywords:     g(colMap, 'seoKeywords', 'seokeywords'),
    seoRanking:      g(colMap, 'seoRanking', 'seoranking', 'priority'),
    lastSerpCheckDate: g(colMap, 'lastSerpCheckDate', 'last serp check date'),
    priorityAssignedDate: g(colMap, 'priorityAssignedDate', 'priority assigned date'),
    platforms:       g(colMap, 'platforms'),
    // Unified content column — "Blog Content" (col 4) takes priority over generic "Content" (col 14)
    blogContent:     g(colMap, 'Blog Content', 'blog content', 'Blog Content for all', 'blog content for all', 'blogcontent', 'Content', 'content'),
    // X columns
    xThread:         g(colMap, 'X Thread', 'x thread', 'xThread', 'Thread'),
    xPost:           g(colMap, 'X Post', 'x post'),
    xPostUrl:        g(colMap, 'X Post URL', 'x post url'),
    xStatus:         g(colMap, 'X Status', 'x status'),
    xError:          g(colMap, 'X Error', 'x error'),
    // Facebook columns
    fbPost:          g(colMap, 'FB Post', 'fb post'),
    fbPostUrl:       g(colMap, 'FB Post URL', 'fb post url'),
    fbStatus:        g(colMap, 'FB Status', 'fb status'),
    fbError:         g(colMap, 'FB Error', 'fb error'),
    // Tumblr columns
    tumblrPost:      g(colMap, 'Tumblr Post', 'tumblr post'),
    tumblrPostUrl:   g(colMap, 'Tumblr Post URL', 'tumblr post url'),
    tumblrStatus:    g(colMap, 'Tumblr Status', 'tumblr status'),
    tumblrError:     g(colMap, 'Tumblr Error', 'tumblr error'),
    tumblrBatch:     g(colMap, 'Tumblr Batch', 'tumblr batch', 'tumblrBatch'),
    lastPostedTumblr: g(colMap, 'lastPostedTumblr', 'lastpostedtumblr'),
    // LinkedIn columns
    linkedinPost:    g(colMap, 'LinkedIn Post', 'linkedin post'),
    linkedinPostUrl: g(colMap, 'LinkedIn Post URL', 'linkedin post url'),
    linkedinStatus:  g(colMap, 'LinkedIn Status', 'linkedin status'),
    linkedinError:   g(colMap, 'LinkedIn Error', 'linkedin error'),
    // Instagram columns
    instagramPost:    g(colMap, 'Instagram Post', 'instagram post'),
    instagramPostUrl: g(colMap, 'Instagram Post URL', 'instagram post url'),
    instagramStatus:  g(colMap, 'Instagram Status', 'instagram status'),
    instagramError:   g(colMap, 'Instagram Error', 'instagram error'),
    instagramBatch:   g(colMap, 'instagramBatch', 'instagram batch', 'Instagram Batch'),
    lastPostedInstagram: g(colMap, 'lastPostedInstagram', 'lastpostedinstagram'),
    // Medium columns
    mediumPost:      g(colMap, 'Medium Post', 'medium post'),
    mediumPostUrl:   g(colMap, 'Medium Post URL', 'medium post url'),
    mediumStatus:    g(colMap, 'Medium Status', 'medium status'),
    mediumError:     g(colMap, 'Medium Error', 'medium error'),
    mediumBatch:     g(colMap, 'mediumBatch', 'medium batch', 'Medium Batch'),
    lastPostedMedium: g(colMap, 'lastPostedMedium', 'lastpostedmedium'),
    // Linkmate columns
    linkMateContent: g(colMap, 'Linkmate Content', 'linkmate content'),
    linkMatePostUrl: g(colMap, 'Linkmate Post URL', 'linkmate post url'),
    linkMateStatus:  g(colMap, 'Linkmate Status', 'linkmate status'),
    linkMateError:   g(colMap, 'Linkmate Error', 'linkmate error'),
    linkmateBatch:   g(colMap, 'linkmateBatch', 'linkmate batch', 'Linkmate Batch'),
    lastPostedLinkmate: g(colMap, 'lastPostedLinkmate', 'lastpostedlinkmate'),
    // Google Sites columns
    googleSitePostUrl:   g(colMap, 'Google Site Post URL', 'google site post url'),
    googleSiteStatus:    g(colMap, 'Google Site Status', 'google site status'),
    googleSiteError:     g(colMap, 'Google Site Error', 'google site error'),
    googleSiteBatch:     g(colMap, 'GoogleSite Batch', 'googleSiteBatch', 'google site batch', 'Google Site Batch', 'googlesite batch'),
    lastPostedGoogleSite: g(colMap, 'lastPostedGoogleSite', 'lastpostedgooglesite'),
    // Dev.to columns
    devtoPostUrl:    g(colMap, 'Dev.to Post URL', 'dev.to post url'),
    devtoStatus:     g(colMap, 'Dev.to Status', 'dev.to status'),
    devtoError:      g(colMap, 'Dev.to Error', 'dev.to error'),
    devtoBatch:      g(colMap, 'Devto Batch', 'devtoBatch', 'dev.to batch', 'Dev.to Batch', 'devto batch'),
    lastPostedDevto: g(colMap, 'lastPostedDevto', 'lastposteddevto'),
    // LinkedIn Pulse columns
    linkedinPulsePostUrl:    g(colMap, 'Linkedin Pulse URL', 'LinkedIn Pulse Post URL', 'linkedin pulse post url', 'linkedin pulse url'),
    linkedinPulseStatus:     g(colMap, 'LinkedIn Pulse Status', 'linkedin pulse status'),
    linkedinPulseError:      g(colMap, 'LinkedIn Pulse Error', 'linkedin pulse error'),
    linkedinPulseBatch:      g(colMap, 'linkedinPulseBatch', 'linkedin pulse batch', 'LinkedIn Pulse Batch'),
    lastPostedLinkedinPulse: g(colMap, 'lastPosted linkedin Pulse', 'lastPostedLinkedinPulse', 'lastpostedlinkedinpulse'),
    // Calisthenics columns
    calisthenicsPostUrl: g(colMap, 'Calisthenics Post URL', 'calisthenics post url'),
    calisthenicsStatus:  g(colMap, 'Calisthenics Status', 'calisthenics status'),
    calisthenicsError:   g(colMap, 'Calisthenics Error', 'calisthenics error'),
    calisthenicsNBatch:  g(colMap, 'calisthenicsNBatch', 'calisthenics batch', 'Calisthenics Batch'),
    lastPostedCalisthenics: g(colMap, 'lastPostedCalisthenics', 'lastpostedcalisthenics'),
    // Substack columns
    substackPostUrl: g(colMap, 'Substack Post URL', 'substack post url'),
    substackStatus:  g(colMap, 'Substack Status', 'substack status'),
    substackError:   g(colMap, 'Substack  Error', 'Substack Error', 'substack  error', 'substack error'),
    substackBatch:   g(colMap, 'substackBatch', 'substack batch', 'Substack Batch'),
    lastPostedSubstack: g(colMap, 'lastPostedSubstack', 'lastpostedsubstack'),
    // HackMD columns
    hackmdPostUrl: g(colMap, 'HackMD Post URL', 'hackmd post url'),
    hackmdStatus:  g(colMap, 'HackMD Status', 'hackmd status'),
    hackmdError:   g(colMap, 'HackMD Error', 'hackmd error'),
    hackmdBatch:   g(colMap, 'hackmdBatch', 'hackmd batch', 'HackMD Batch'),
    lastPostedHackmd: g(colMap, 'lastPostedHackMD', 'lastPostedHackmd', 'lastpostedhackmd'),
    // WordPress columns
    wordpressPostUrl: g(colMap, 'WordPress Post URL', 'wordpress post url'),
    wordpressStatus:  g(colMap, 'WordPress Status', 'wordpress status'),
    wordpressError:   g(colMap, 'WordPress Error', 'wordpress error'),
    wordpressBatch:   g(colMap, 'wordpressBatch', 'wordpress batch', 'WordPress Batch'),
    lastPostedWordpress: g(colMap, 'lastPostedWordpress', 'lastpostedwordpress'),
    // Blogger columns
    bloggerPostUrl: g(colMap, 'Blogger Post URL', 'blogger post url'),
    bloggerStatus:  g(colMap, 'Blogger Status', 'blogger status'),
    bloggerError:   g(colMap, 'Blogger Error', 'blogger error'),
    bloggerBatch:   g(colMap, 'bloggerBatch', 'blogger batch', 'Blogger Batch'),
    lastPostedBlogger: g(colMap, 'Last Posted Blogger', 'lastPostedBlogger', 'lastpostedblogger'),
    // Patreon columns
    patreonPostUrl: g(colMap, 'Patreon Post URL', 'patreon post url'),
    patreonStatus:  g(colMap, 'Patreon Status', 'patreon status'),
    patreonError:   g(colMap, 'Patreon Error', 'patreon error'),
    patreonBatch:   g(colMap, 'patreonBatch', 'patreon batch', 'Patreon Batch'),
    lastPostedPatreon: g(colMap, 'Last Posted Patreon', 'lastPostedPatreon', 'lastpostedpatreon'),
    // Notion columns
    notionPostUrl: g(colMap, 'Notion Post URL', 'notion post url'),
    notionStatus:  g(colMap, 'Notion Status', 'notion status'),
    notionError:   g(colMap, 'Notion Error', 'notion error'),
    notionBatch:   g(colMap, 'notionBatch', 'notion batch', 'Notion Batch'),
    lastPostedNotion: g(colMap, 'Last Posted Notion', 'lastPostedNotion', 'lastpostednotion'),
    // Note columns
    notePostUrl: g(colMap, 'Note Post URL', 'note post url'),
    noteStatus:  g(colMap, 'Note Status', 'note status'),
    noteError:   g(colMap, 'Note Error', 'note error'),
    noteBatch:   g(colMap, 'noteBatch', 'note batch', 'Note Batch'),
    lastPostedNote: g(colMap, 'Last Posted Note', 'lastPostedNote', 'lastpostednote'),
    // vc.ru columns
    vcruPostUrl: g(colMap, 'Vcru Post URL', 'vcru post url'),
    vcruStatus:  g(colMap, 'Vcru Status', 'vcru status'),
    vcruError:   g(colMap, 'Vcru Error', 'vcru error'),
    vcruBatch:   g(colMap, 'vcruBatch', 'vcru batch', 'Vcru Batch'),
    lastPostedVcru: g(colMap, 'Last Posted Vcru', 'lastPostedVcru', 'lastpostedvcru'),
    // Naver columns
    naverPostUrl: g(colMap, 'Naver Post URL', 'naver post url'),
    naverStatus:  g(colMap, 'Naver Status', 'naver status'),
    naverError:   g(colMap, 'Naver Error', 'naver error'),
    naverBatch:   g(colMap, 'naverBatch', 'naver batch', 'Naver Batch'),
    lastPostedNaver: g(colMap, 'Last Posted Naver', 'lastPostedNaver', 'lastpostednaver'),
    // Velog columns
    velogPostUrl: g(colMap, 'Velog Post URL', 'velog post url'),
    velogStatus:  g(colMap, 'Velog Status', 'velog status'),
    velogError:   g(colMap, 'Velog Error', 'velog error'),
    velogBatch:   g(colMap, 'velogBatch', 'velog batch', 'Velog Batch'),
    lastPostedVelog: g(colMap, 'Last Posted Velog', 'lastPostedVelog', 'lastpostedvelog'),
    // Coda columns
    codaPostUrl: g(colMap, 'Coda Post URL', 'coda post url'),
    codaStatus:  g(colMap, 'Coda Status', 'coda status'),
    codaError:   g(colMap, 'Coda Error', 'coda error'),
    codaBatch:   g(colMap, 'codaBatch', 'coda batch', 'Coda Batch'),
    lastPostedCoda: g(colMap, 'Last Posted Coda', 'lastPostedCoda', 'lastpostedcoda'),
    // Paragraph columns
    paragraphPostUrl:    g(colMap, 'Paragraph Post URL', 'paragraph post url'),
    paragraphStatus:     g(colMap, 'Paragraph Status', 'paragraph status'),
    paragraphError:      g(colMap, 'Paragraph Error', 'paragraph error'),
    paragraphBatch:      g(colMap, 'Paragraph Batch', 'paragraph batch', 'paragraphBatch'),
    lastPostedParagraph: g(colMap, 'Last Posted Paragraph', 'lastPostedParagraph', 'lastpostedparagraph'),
    // Instapaper columns
    instapaperUrl:    g(colMap, 'Instapaper Post URL', 'instapaper post url', 'Instapaper URL'),
    instapaperNote:   g(colMap, 'Instapaper Note', 'instapaper note'),
    instapaperStatus: g(colMap, 'Instapaper Status', 'instapaper status'),
    instapaperError:  g(colMap, 'Instapaper Error', 'instapaper error'),
    instapaperBatch:  g(colMap, 'instapaperBatch', 'instapaper batch', 'Instapaper Batch'),
    lastPostedInstapaper: g(colMap, 'Last Posted Instapaper', 'lastPostedInstapaper', 'lastpostedinstapaper'),
    // Raindrop columns
    raindropUrl:    g(colMap, 'Raindrop Post URL', 'raindrop post url', 'Raindrop URL'),
    raindropNote:   g(colMap, 'Raindrop Note', 'raindrop note'),
    raindropStatus: g(colMap, 'Raindrop Status', 'raindrop status'),
    raindropError:  g(colMap, 'Raindrop Error', 'raindrop error'),
    raindropBatch:  g(colMap, 'raindropBatch', 'raindrop batch', 'Raindrop Batch'),
    lastPostedRaindrop: g(colMap, 'Last Posted Raindrop', 'lastPostedRaindrop', 'lastpostedraindrop'),
    // Pearltrees columns
    pearltreesUrl:    g(colMap, 'Pearltrees Post URL', 'pearltrees post url', 'Pearltrees URL'),
    pearltreesStatus: g(colMap, 'Pearltrees Status', 'pearltrees status'),
    pearltreesError:  g(colMap, 'Pearltrees Error', 'pearltrees error'),
    pearltreesBatch:  g(colMap, 'pearltreesBatch', 'pearltrees batch', 'Pearltrees Batch'),
    lastPostedPearltrees: g(colMap, 'Last Posted Pearltrees', 'lastPostedPearltrees', 'lastpostedpearltrees'),
    // PdfHost columns
    pdfhostUrl:    g(colMap, 'PdfHost Post URL', 'pdfhost post url', 'PdfHost URL'),
    pdfhostStatus: g(colMap, 'PdfHost Status', 'pdfhost status'),
    pdfhostError:  g(colMap, 'PdfHost Error', 'pdfhost error'),
    pdfhostBatch:  g(colMap, 'pdfhostBatch', 'pdfhost batch', 'PdfHost Batch'),
    lastPostedPdfhost: g(colMap, 'Last Posted PdfHost', 'lastPostedPdfhost', 'lastpostedpdfhost'),
    // 4shared columns
    fourSharedUrl:    g(colMap, '4shared Post URL', '4shared post url', '4shared URL'),
    fourSharedStatus: g(colMap, '4shared Status', '4shared status'),
    fourSharedError:  g(colMap, '4shared Error', '4shared error'),
    fourSharedBatch:  g(colMap, 'fourSharedBatch', '4shared batch', '4shared Batch'),
    lastPostedFourShared: g(colMap, 'Last Posted 4shared', 'lastPostedFourShared', 'lastposted4shared'),
    // Scribd columns
    scribdUrl:    g(colMap, 'Scribd Post URL', 'scribd post url', 'Scribd URL'),
    scribdStatus: g(colMap, 'Scribd Status', 'scribd status'),
    scribdError:  g(colMap, 'Scribd Error', 'scribd error'),
    scribdBatch:  g(colMap, 'scribdBatch', 'scribd batch', 'Scribd Batch'),
    lastPostedScribd: g(colMap, 'Last Posted Scribd', 'lastPostedScribd', 'lastpostedscribd'),
    // Mastodon columns
    mastodonPost:    g(colMap, 'Mastodon Post', 'mastodon post'),
    mastodonPostUrl: g(colMap, 'Mastodon Post URL', 'mastodon post url', 'Mastodon URL'),
    mastodonStatus:  g(colMap, 'Mastodon Status', 'mastodon status'),
    mastodonError:   g(colMap, 'Mastodon Error', 'mastodon error'),
    mastodonBatch:   g(colMap, 'mastodonBatch', 'mastodon batch', 'Mastodon Batch'),
    lastPostedMastodon: g(colMap, 'Last Posted Mastodon', 'lastPostedMastodon', 'lastpostedmastodon'),
    // Generated file paths
    pdfPath:   g(colMap, 'PDF Path', 'pdf path', 'pdfPath'),
    pptxPath:  g(colMap, 'PPTX Path', 'pptx path', 'pptxPath'),
    imagesUrl: g(colMap, 'Images URL', 'images url', 'Image URL', 'image url'),
    sevenSlide: g(colMap, '7Slide', '7slide'),
    // Content Pool group-batch columns
    groupAssigned:   g(colMap, 'Group Assigned', 'group assigned'),
    claimedAt:       g(colMap, 'Claimed At', 'claimed at'),
  };
}

// ──── Content Pool: claim next unclaimed rows for a group batch ──────────
// Reads the "Content Pool" tab, takes the first `count` rows (in sheet order)
// where "Group Assigned" is blank and Title is non-empty, immediately marks
// them claimed (Group Assigned + Claimed At) so a concurrent/later batch
// can't double-pick them, then returns the claimed rows.

export async function claimNextRowsForGroup(
  groupName: string,
  count: number,
  accountNames?: string[],
  sheetType: 'pool' | 'newLogic' = 'pool',
  accountColumn: 'both' | 'name' | 'newName' = 'both'
): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(sheetType);
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:ZZ`,
  }), 'claimNextRowsForGroup');

  const rows: string[][] = res.data.values ?? [];
  const titleIdx = col(colMap, 'Title', 'title', 'Blog Title', 'blog title') ?? -1;
  const groupIdx = col(colMap, 'Group Assigned', 'group assigned') ?? -1;

  if (groupIdx === -1) {
    console.warn(`   ⚠️ [${groupName}] "Group Assigned" column not found in "${sheetConfig.name}" tab — cannot claim rows.`);
    return [];
  }

  const claimed: SheetRow[] = [];
  for (let i = 1; i < rows.length && claimed.length < count; i++) {
    const row = rows[i];
    const title = titleIdx >= 0 ? (row[titleIdx] ?? '').trim() : '';
    const alreadyAssigned = (row[groupIdx] ?? '').trim();
    if (!title || alreadyAssigned) continue;
    claimed.push(mapRow(row, colMap, i + 1, sheetType));
  }

  if (claimed.length === 0) {
    console.warn(`   ⚠️ [${groupName}] No unclaimed rows available in Content Pool.`);
    return [];
  }

  const now = new Date().toISOString();
  const claimData = claimed.flatMap((r, i) => {
    const fields: { names: string[]; value: string }[] = [
      { names: ['Group Assigned', 'group assigned'], value: groupName },
      { names: ['Claimed At',     'claimed at'],      value: now },
    ];
    if (accountNames && accountNames.length > 0) {
      const accountName = accountNames[i % accountNames.length];
      if (accountColumn === 'both' || accountColumn === 'name') {
        fields.push({ names: ['Name', 'name'], value: accountName });
      }
      if (accountColumn === 'both' || accountColumn === 'newName') {
        fields.push({ names: ['New Name', 'new name', 'newName'], value: accountName });
      }
    }
    return buildUpdates(colMap, r.rowIndex, fields, sheetConfig.name);
  });
  await batchWrite(sheets, claimData, sheetConfig.id);

  claimed.forEach((r, i) => {
    r.groupAssigned = groupName;
    r.claimedAt = now;
    if (accountNames && accountNames.length > 0) {
      const accountName = accountNames[i % accountNames.length];
      if (accountColumn === 'both' || accountColumn === 'name') r.name = accountName;
      if (accountColumn === 'both' || accountColumn === 'newName') r.newName = accountName;
    }
  });
  console.log(`   📦 [${groupName}] Claimed ${claimed.length} rows from Content Pool.`);
  return claimed;
}

/**
 * One-time setup: add any of `wanted` header columns to `sheetType`'s tab
 * that don't already exist. Safe to run repeatedly — skips any header that's
 * already present, appends the rest after the last used column.
 */
export async function ensureSheetColumns(sheetType: 'social' | 'blog' | 'pool' | 'newLogic', wanted: string[]): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(sheetType);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!1:1`,
  }), 'ensureSheetColumns');
  const headers: string[] = res.data.values?.[0] ?? [];
  const lowerHeaders = headers.map(h => h.trim().toLowerCase());

  let nextCol = headers.length;
  const data: { range: string; values: string[][] }[] = [];

  for (const name of wanted) {
    if (lowerHeaders.includes(name.toLowerCase())) {
      console.log(`   ✔ Column already exists: "${name}"`);
      continue;
    }
    data.push({ range: `${sheetConfig.name}!${colToLetter(nextCol)}1`, values: [[name]] });
    console.log(`   ➕ Adding column "${name}" at ${colToLetter(nextCol)}1`);
    nextCol++;
  }

  if (data.length === 0) {
    console.log(`   ✔ All requested columns already exist on "${sheetConfig.name}" — nothing to do.`);
    return;
  }

  // The sheet's grid may not physically have enough columns yet (Sheets
  // rejects writes past the current grid size) — grow it first if needed.
  const meta = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId: sheetConfig.id,
    fields: 'sheets(properties(sheetId,title,gridProperties))',
  }), 'ensureSheetColumns:meta');
  const sheetProps = meta.data.sheets?.find((s: any) => s.properties?.title === sheetConfig.name)?.properties;
  const gridSheetId = sheetProps?.sheetId;
  const currentColCount = sheetProps?.gridProperties?.columnCount ?? 0;

  if (gridSheetId !== undefined && nextCol > currentColCount) {
    const growBy = nextCol - currentColCount;
    console.log(`   📐 Growing "${sheetConfig.name}" grid by ${growBy} column(s) (${currentColCount} → ${nextCol})...`);
    await withRetry(() => sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetConfig.id,
      requestBody: {
        requests: [{
          appendDimension: { sheetId: gridSheetId, dimension: 'COLUMNS', length: growBy },
        }],
      },
    }), 'ensureSheetColumns:growGrid');
  }

  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetConfig.id,
    requestBody: { valueInputOption: 'RAW', data },
  }), 'ensureSheetColumns:write');
  console.log(`   ✅ Added ${data.length} column(s) to "${sheetConfig.name}".`);
}

/**
 * One-time setup: add the "Last Posted Blog Platform 1/2/3" header columns to
 * the New Logic tab if they don't already exist (date-only, one per slot —
 * replaces the old single shared "Last Posted Blog" encoded column).
 */
export async function ensureLastPostedBlogPlatformColumns(): Promise<void> {
  return ensureSheetColumns('newLogic', [
    'Last Posted Blog Platform 1', 'Last Posted Blog Platform 2', 'Last Posted Blog Platform 3',
  ]);
}

/**
 * Clear "Group Assigned"/"Claimed At" on a row so a future claimNextRowsForGroup
 * pass can pick it up again. Call this when a platform in the group failed to
 * post to the row — otherwise the row stays claimed forever and is silently
 * skipped from then on, even though it was never actually posted.
 *
 * Safe to call even if ANOTHER platform in the same group already posted
 * successfully to this row: each platform's batch runner is expected to skip
 * rows that already have its own post URL (see the guard at the top of
 * runMediumBatch/runGoogleSiteBatch), so re-claiming never causes a duplicate
 * post — it only gives the platform that actually failed another chance.
 */
export async function unclaimGroupRow(rowIndex: number, sheetType: 'pool' | 'newLogic' = 'newLogic'): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(sheetType);
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const data = buildUpdates(colMap, rowIndex, [
    { names: ['Group Assigned', 'group assigned'], value: '' },
    { names: ['Claimed At', 'claimed at'], value: '' },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Content Pool: rows that need blog generation ───────────────────────
// Reads the "Content Pool" tab, returns rows where Target URL is set but
// Blog Content is empty (< 50 chars) — i.e. ready for the ChatGPT blog
// generator. Does not claim/mark rows (unlike claimNextRowsForGroup) —
// generation just needs to not re-run on a row that already has content, and
// the very next read will naturally exclude any row this pass just filled in.

export async function getContentPoolRowsNeedingGeneration(limit: number = 3, sheetType: 'pool' | 'newLogic' = 'pool'): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(sheetType);
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:ZZ`,
  }), 'getContentPoolRowsNeedingGeneration');

  const rows: string[][] = res.data.values ?? [];
  const urlIdx = col(colMap, 'targetUrl', 'targeturl', 'Target URL', 'target url', 'URL', 'url', 'Report URL', 'Download Report URL') ?? -1;
  const contentIdx = col(colMap, 'Blog Content', 'blog content') ?? -1;

  if (urlIdx === -1) {
    console.warn(`   ⚠️ [blog-gen] "Target URL" column not found in "${sheetConfig.name}" tab — cannot pick rows to generate.`);
    return [];
  }

  const pending: SheetRow[] = [];
  for (let i = 1; i < rows.length && pending.length < limit; i++) {
    const row = rows[i];
    const targetUrl = (row[urlIdx] ?? '').trim();
    const blogContent = contentIdx >= 0 ? (row[contentIdx] ?? '').trim() : '';
    if (!targetUrl || blogContent.length >= 50) continue;
    pending.push(mapRow(row, colMap, i + 1, sheetType));
  }

  return pending;
}

// ──── Write a ChatGPT-generated blog back to the Content Pool / New Logic tab ────

export async function saveGeneratedBlogToPool(
  row: { rowIndex: number },
  result: { coverImageUrl?: string; html: string; seoTitle?: string; metaDescription?: string; imageData?: string; imageData2?: string },
  sheetType: 'pool' | 'newLogic' = 'pool'
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(sheetType);
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  // Blog Content + Cover Image URL, plus (since the V1.3 master prompt,
  // 2026-09-18) the SEO Title / Meta Description / Key Snapshot Metrics the
  // same ChatGPT reply already returns — written into New Logic's existing
  // "Title" (C) / "Description" (D) / "Image Data" (E) columns.
  // "Image Data 2" (Growth Drivers / Competitive Landscape / Regional
  // Landscape, feeding the second mid-blog image — see
  // blogLandscapeImageAgent.ts) is a NEW column; buildUpdates() logs a
  // warning and skips it harmlessly until that column is added to the New
  // Logic sheet.
  const fields: { names: string[]; value: string }[] = [
    { names: ['Blog Content', 'blog content'], value: result.html },
  ];
  if (result.coverImageUrl) fields.push({ names: ['Cover Image URL', 'cover image url'], value: result.coverImageUrl });
  if (result.seoTitle) fields.push({ names: ['Title', 'title'], value: result.seoTitle });
  if (result.metaDescription) fields.push({ names: ['Description', 'description'], value: result.metaDescription });
  if (result.imageData) fields.push({ names: ['Image Data', 'image data'], value: result.imageData });
  if (result.imageData2) fields.push({ names: ['Image Data 2', 'image data 2'], value: result.imageData2 });

  const data = buildUpdates(colMap, row.rowIndex, fields, sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 ${sheetConfig.name} row ${row.rowIndex}: blog saved (~${result.html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length} words)`);
}

/** Write ONLY the Cover Image URL for a row — called the moment the image is
 * generated, before the (much slower) blog finishes, so the URL is on the
 * sheet even if the blog attempt then fails and retries. */
export async function saveCoverImageUrlToPool(
  row: { rowIndex: number },
  coverImageUrl: string,
  sheetType: 'pool' | 'newLogic' = 'pool'
): Promise<void> {
  if (!coverImageUrl) return;
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(sheetType);
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const data = buildUpdates(colMap, row.rowIndex, [{ names: ['Cover Image URL', 'cover image url'], value: coverImageUrl }], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 ${sheetConfig.name} row ${row.rowIndex}: cover image URL saved immediately`);
}

// Writes whatever text ChatGPT wrote alongside the generated cover image
// into New Logic!Z ("Image text") — purely observational for now, so this
// never throws; a failed write here must never fail the row's blog generation.
export async function saveNewLogicImageText(
  row: { rowIndex: number },
  imageText: string
): Promise<void> {
  if (!imageText?.trim()) return;
  try {
    const sheets = await getSheetsClient();
    const sheetConfig = getSheetConfig('newLogic');
    const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
    const data = buildUpdates(colMap, row.rowIndex, [{ names: ['Image text', 'image text'], value: imageText }], sheetConfig.name);
    await batchWrite(sheets, data, sheetConfig.id);
    console.log(`   📝 ${sheetConfig.name} row ${row.rowIndex}: image text saved`);
  } catch (err: any) {
    console.log(`   ⚠️ Could not save image text (non-fatal): ${err.message}`);
  }
}

// ──── Blogs tab: rows needing a ChatGPT-generated cover image saved locally ────
// Picks rows with a Blog Title but no "Local Image Path" yet — independent of
// the Content Pool's Drive-upload "Cover Image URL" flow above.

export async function getBlogRowsNeedingLocalImage(limit: number = 5): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:ZZ`,
  }), 'getBlogRowsNeedingLocalImage');

  const rows: string[][] = res.data.values ?? [];
  const titleIdx = col(colMap, 'Blog Title', 'blog title', 'Title', 'title', 'Main Title') ?? -1;
  const pathIdx = col(colMap, 'Local Image Path', 'local image path') ?? -1;

  if (titleIdx === -1) {
    console.warn('   ⚠️ [blog-image] "Blog Title" column not found on "Blogs" tab — cannot pick rows.');
    return [];
  }

  const pending: SheetRow[] = [];
  for (let i = 1; i < rows.length && pending.length < limit; i++) {
    const row = rows[i];
    const title = (row[titleIdx] ?? '').trim();
    const existingPath = pathIdx >= 0 ? (row[pathIdx] ?? '').trim() : '';
    if (!title || existingPath) continue;
    pending.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  return pending;
}

/** Write the local (on-disk) generated cover image path for a Blogs-tab row. */
export async function saveLocalImagePath(row: { rowIndex: number }, localPath: string): Promise<void> {
  if (!localPath) return;
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const data = buildUpdates(colMap, row.rowIndex, [{ names: ['Local Image Path', 'local image path'], value: localPath }], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 Blogs row ${row.rowIndex}: local image path saved`);
}

// ──── Blogs tab: rows needing a ChatGPT-generated TEXT-POST card image ────
// Separate from getBlogRowsNeedingLocalImage above (blog hero cover) — this
// is the lighter branded social-card image that rides along an FB/LI/X text
// post, tracked in its own "Social Post Image Path" column so the two flows
// never collide on the same cell.

export async function getBlogRowsNeedingSocialPostImage(limit: number = 5): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:ZZ`,
  }), 'getBlogRowsNeedingSocialPostImage');

  const rows: string[][] = res.data.values ?? [];
  // Column A ("Title") specifically — NOT "Blog Title" (a different, pre-existing
  // column used for the full blog-article pipeline at a different index).
  const titleIdx = col(colMap, 'Title', 'title') ?? -1;
  const pathIdx = col(colMap, 'Social Post Image Path', 'social post image path') ?? -1;

  if (titleIdx === -1) {
    console.warn('   ⚠️ [social-image] "Title" column not found on "Blogs" tab — cannot pick rows.');
    return [];
  }

  const pending: SheetRow[] = [];
  for (let i = 1; i < rows.length && pending.length < limit; i++) {
    const row = rows[i];
    const title = (row[titleIdx] ?? '').trim();
    const existingPath = pathIdx >= 0 ? (row[pathIdx] ?? '').trim() : '';
    if (!title || existingPath) continue;
    pending.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  return pending;
}

/** Write the local (on-disk) generated text-post card image path for a Blogs-tab row. */
export async function saveSocialPostImagePath(row: { rowIndex: number }, localPath: string): Promise<void> {
  if (!localPath) return;
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const data = buildUpdates(colMap, row.rowIndex, [{ names: ['Social Post Image Path', 'social post image path'], value: localPath }], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 Blogs row ${row.rowIndex}: social post image path saved`);
}

// Same social-card image flow as above, but against the "New Logic" tab —
// used by the nightly RSS feeder so freshly-fed New Logic rows also get a
// branded social-card image (LI carousel), not just the blog hero cover.

export async function getNewLogicRowsNeedingSocialPostImage(limit: number = 10): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('newLogic');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:AZ`,
  }), 'getNewLogicRowsNeedingSocialPostImage');

  const rows: string[][] = res.data.values ?? [];
  const titleIdx = col(colMap, 'Title', 'title') ?? -1;
  const reportTitleIdx = col(colMap, 'Report Title', 'report title') ?? -1; // fed rows only have this one
  const pathIdx = col(colMap, 'Social Post Image Path', 'social post image path') ?? -1;

  if (titleIdx === -1 && reportTitleIdx === -1) {
    console.warn('   ⚠️ [social-image] "Title"/"Report Title" column not found on "New Logic" tab — cannot pick rows.');
    return [];
  }

  const pending: SheetRow[] = [];
  for (let i = 1; i < rows.length && pending.length < limit; i++) {
    const row = rows[i];
    const title = ((titleIdx >= 0 ? row[titleIdx] : '') || (reportTitleIdx >= 0 ? row[reportTitleIdx] : '') || '').trim();
    const existingPath = pathIdx >= 0 ? (row[pathIdx] ?? '').trim() : '';
    if (!title || existingPath) continue;
    pending.push(mapRow(row, colMap, i + 1, 'newLogic'));
  }

  return pending;
}

/** Write the local (on-disk) generated text-post card image path for a New Logic-tab row. */
export async function saveNewLogicSocialPostImagePath(row: { rowIndex: number }, localPath: string): Promise<void> {
  if (!localPath) return;
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('newLogic');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const data = buildUpdates(colMap, row.rowIndex, [{ names: ['Social Post Image Path', 'social post image path'], value: localPath }], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 New Logic row ${row.rowIndex}: social post image path saved`);
}

/** Find a Blogs-tab row by title (case-insensitive exact match). Returns null if not found. */
export async function findBlogRowByTitle(title: string): Promise<SheetRow | null> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:ZZ`,
  }), 'findBlogRowByTitle');

  const rows: string[][] = res.data.values ?? [];
  const titleIdx = col(colMap, 'Title', 'title') ?? -1;
  if (titleIdx === -1) return null;

  const needle = title.trim().toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    const rowTitle = (rows[i][titleIdx] ?? '').trim().toLowerCase();
    if (rowTitle === needle) return mapRow(rows[i], colMap, i + 1, 'blog');
  }
  return null;
}

/** Append a new row (Title + Target URL only) to the Blogs tab. Returns the new row's 1-based index. */
export async function appendRowToBlogSheet(row: { title: string; targetUrl: string }): Promise<number> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  // Column A ("Title") specifically — NOT "Blog Title" (a different,
  // pre-existing column used for the full blog-article pipeline, sitting at
  // a different index). Matching "Blog Title" first here previously caused
  // titles for this flow to land in the wrong column entirely.
  const titleIdx = col(colMap, 'Title', 'title');
  const urlIdx = col(colMap, 'targetUrl', 'targeturl', 'Download Report URL', 'Report URL', 'Target URL', 'URL', 'url');
  if (titleIdx === undefined || urlIdx === undefined) {
    throw new Error('Cannot append to Blogs tab — Title or Target URL column not found');
  }

  const maxCol = Math.max(titleIdx, urlIdx) + 1;
  const arr = Array(maxCol).fill('');
  arr[titleIdx] = row.title;
  arr[urlIdx] = row.targetUrl;

  const appendRes = await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [arr] },
  }), 'appendRowToBlogSheet:append');

  // Read the real row number back from the API response instead of guessing
  // it from a separate column-A count beforehand — that count silently
  // undercounts whenever rows have data in other columns but a blank Title
  // cell, which previously caused the image-path write-back to land on the
  // wrong (unrelated) row.
  const updatedRange = appendRes.data.updates?.updatedRange ?? '';
  const rowMatch = updatedRange.match(/![A-Z]+(\d+)/);
  if (!rowMatch) {
    throw new Error(`appendRowToBlogSheet: could not parse row number from updatedRange "${updatedRange}"`);
  }
  const newRowIndex = parseInt(rowMatch[1], 10);

  console.log(`   📄 Appended new Blogs row ${newRowIndex}: "${row.title}"`);
  return newRowIndex;
}

// ──── Content Pool: append new rows (Title + Target URL only) ───────────
// Appends past the last existing row — never overwrites — leaving Group
// Assigned/Claimed At/Name/New Name/all per-platform columns blank for the
// automation to fill in later.

export async function appendRowsToContentPool(rows: Array<{ title: string; targetUrl: string }>): Promise<boolean> {
  if (rows.length === 0) return false;
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('pool');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const titleIdx = col(colMap, 'Title', 'title');
  const urlIdx = col(colMap, 'targetUrl', 'targeturl', 'Target URL', 'target url');
  if (titleIdx === undefined || urlIdx === undefined) {
    console.warn('   ⚠️  Cannot append to Content Pool — Title or Target URL column not found');
    return false;
  }

  const maxCol = Math.max(titleIdx, urlIdx) + 1;
  const data = rows.map(r => {
    const arr = Array(maxCol).fill('');
    arr[titleIdx] = r.title;
    arr[urlIdx] = r.targetUrl;
    return arr;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: data },
  });
  console.log(`   📄 Appended ${rows.length} row(s) to Content Pool`);
  return true;
}

// ──── Content Pool: append fully-written rows (Title + Target URL + ──────
// Description + Blog Content) — for seeding from a source that already has
// finished content (e.g. the "Blogs" tab), as opposed to
// appendRowsToContentPool() which only seeds Title + Target URL for rows
// that still need generation.

export async function appendFullRowsToContentPool(rows: Array<{
  title: string;
  targetUrl: string;
  description?: string;
  blogCaption?: string;
  blogContent?: string;
  name?: string;
  newName?: string;
}>): Promise<boolean> {
  if (rows.length === 0) return false;
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('pool');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const titleIdx = col(colMap, 'Title', 'title');
  const urlIdx = col(colMap, 'targetUrl', 'targeturl', 'Target URL', 'target url');
  const descIdx = col(colMap, 'Description', 'description');
  const captionIdx = col(colMap, 'Blog Caption', 'blog caption');
  const contentIdx = col(colMap, 'Blog Content', 'blog content');
  const nameIdx = col(colMap, 'Name', 'name');
  const newNameIdx = col(colMap, 'New Name', 'new name', 'newName');
  if (titleIdx === undefined || urlIdx === undefined) {
    console.warn('   ⚠️  Cannot append to Content Pool — Title or Target URL column not found');
    return false;
  }

  const maxCol = Math.max(titleIdx, urlIdx, descIdx ?? 0, captionIdx ?? 0, contentIdx ?? 0, nameIdx ?? 0, newNameIdx ?? 0) + 1;
  const data = rows.map(r => {
    const arr = Array(maxCol).fill('');
    arr[titleIdx] = r.title;
    arr[urlIdx] = r.targetUrl;
    if (descIdx !== undefined) arr[descIdx] = r.description ?? '';
    if (captionIdx !== undefined) arr[captionIdx] = r.blogCaption ?? '';
    if (contentIdx !== undefined) arr[contentIdx] = r.blogContent ?? '';
    if (nameIdx !== undefined) arr[nameIdx] = r.name ?? '';
    if (newNameIdx !== undefined) arr[newNameIdx] = r.newName ?? '';
    return arr;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: data },
  });
  console.log(`   📄 Appended ${rows.length} fully-written row(s) to Content Pool`);
  return true;
}

// ──── Write generated tweet back to sheet ───────────────────────────────

export async function saveGeneratedTweet(row: SheetRow, xPost: string): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const colIdx = col(colMap, 'X Post', 'x post');
  if (colIdx === undefined) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!${colToLetter(colIdx)}${row.rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[xPost]] },
  });
}

// ──── Write X posting result back to sheet ──────────────────────────────

export async function savePostingResult(
  row: { rowIndex: number },
  result: {
    xPostUrl: string;
    xStatus: string;
    xError?: string;
    xPost?: string;
    xBatch?: string;
  }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const today = new Date().toISOString().split('T')[0];
  const existing = await getRowByIndex(row.rowIndex);
  const newUrl = appendValue(existing?.xPostUrl, result.xPostUrl);
  const newLastPosted = result.xStatus?.toLowerCase() === 'posted'
    ? appendValue(existing?.lastPostedX, today)
    : (existing?.lastPostedX ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['X Post',          'x post'],               value: result.xPost ?? '' },
    { names: ['X Post URL',      'x post url'],            value: newUrl },
    { names: ['X Status',        'x status'],              value: result.xStatus },
    { names: ['X Error',         'x error'],               value: result.xError ?? '' },
    { names: ['xBatch',          'x batch',   'X Batch'], value: result.xBatch ?? '' },
    { names: ['lastPostedX',     'lastpostedx'],           value: newLastPosted },
  ]);

  await batchWrite(sheets, data);
  console.log(`   📝 Sheet updated for row ${row.rowIndex}: ${result.xStatus}`);
}

// ──── Write SEO analysis data to sheet ──────────────────────────────────

export async function saveUnifiedSeoData(
  row: { rowIndex: number; sheetType?: SheetType },
  seoData: { indexStatus: string; rankPage: number; rankPosition?: number; keywords: string[]; platforms: string[]; priority?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType);
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const posStr = positionToString(seoData.rankPosition ?? -1, seoData.indexStatus);
  const indexed = (seoData.rankPosition ?? -1) >= 0 ? 'yes' : 'no';

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['seoIndexed', 'seoindexed'],   value: indexed },
    { names: ['seoPage',    'seopage'],       value: posStr },
    { names: ['seoKeywords','seokeywords'],   value: seoData.keywords.join(', ') },
    { names: ['platforms'],                   value: seoData.platforms.join(',') },
    { names: ['priority', 'seoRanking', 'seoranking'], value: seoData.priority ?? '' },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 SEO data saved for row ${row.rowIndex}: ${seoData.priority ?? 'N/A'} | ${posStr}`);
}

// ──── Bulk-write SEO data for many rows in a single API call ──────────────
// Avoids quota exhaustion by reusing one client + colMap and sending all
// updates in chunks of 500 ranges (Sheets API limit per batchUpdate).

export async function saveBulkSeoData(
  entries: Array<{
    rowIndex: number;
    seoData: { indexStatus: string; rankPage: number; rankPosition?: number; keywords: string[]; platforms: string[]; priority?: string };
  }>,
  sheetType: SheetType = 'social'
): Promise<void> {
  if (entries.length === 0) return;

  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(sheetType);
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const allUpdates: { range: string; values: string[][] }[] = [];

  for (const { rowIndex, seoData } of entries) {
    const posStr = positionToString(seoData.rankPosition ?? -1, seoData.indexStatus);
    const indexed = (seoData.rankPosition ?? -1) >= 0 ? 'yes' : 'no';
    const updates = buildUpdates(colMap, rowIndex, [
      { names: ['seoIndexed', 'seoindexed'],   value: indexed },
      { names: ['seoPage',    'seopage'],       value: posStr },
      { names: ['seoKeywords','seokeywords'],   value: seoData.keywords.join(', ') },
      { names: ['platforms'],                   value: seoData.platforms.join(',') },
      { names: ['priority', 'seoRanking', 'seoranking'], value: seoData.priority ?? '' },
    ], sheetConfig.name);
    allUpdates.push(...updates);
  }

  const CHUNK = 500;
  for (let i = 0; i < allUpdates.length; i += CHUNK) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetConfig.id,
      requestBody: { valueInputOption: 'RAW', data: allUpdates.slice(i, i + CHUNK) },
    });
  }
}

// ──── Write Facebook posting result to unified sheet ──────────────────────

export async function saveUnifiedFbResult(
  row: SheetRow,
  result: { post: string; postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const today = new Date().toISOString().split('T')[0];

  // Re-read live cell values so we always append to current sheet data,
  // not the stale row object fetched at batch-start.
  let liveFbPostUrl = row.fbPostUrl ?? '';
  let liveLastPostedFb = row.lastPostedFb ?? '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${row.rowIndex}:${row.rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    const urlIdx = col(colMap, 'FB Post URL', 'fb post url');
    const dateIdx = col(colMap, 'lastPostedFb', 'lastpostedfb');
    if (urlIdx !== undefined) liveFbPostUrl = (liveRow[urlIdx] ?? '').trim();
    if (dateIdx !== undefined) liveLastPostedFb = (liveRow[dateIdx] ?? '').trim();
  } catch { /* non-critical — fall back to row object */ }

  console.log(`   [FB save] row ${row.rowIndex} | existing URL: "${liveFbPostUrl}" | new URL: "${result.postUrl}"`);
  const newUrl = appendValue(liveFbPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(liveLastPostedFb, today)
    : liveLastPostedFb;
  console.log(`   [FB save] → writing URL: "${newUrl}" | date: "${newLastPosted}"`);

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['FB Post',     'fb post'],                        value: result.post    },
    { names: ['FB Post URL', 'fb post url'],                    value: newUrl },
    { names: ['FB Status',   'fb status'],                      value: result.status  },
    { names: ['FB Error',    'fb error'],                       value: result.error ?? '' },
    { names: ['fbBatch',     'fb batch',    'FB Batch'],        value: result.batch ?? '' },
    { names: ['lastPostedFb','lastpostedfb'],                   value: newLastPosted },
  ]);

  await batchWrite(sheets, data);
  console.log(`   📝 FB updated for row ${row.rowIndex}: ${result.status}`);
}

// ──── Write Tumblr posting result to unified sheet ─────────────────────────

export async function saveUnifiedTumblrResult(
  row: SheetRow,
  result: { post: string; postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const today = new Date().toISOString().split('T')[0];

  let liveTumblrPostUrl = row.tumblrPostUrl ?? '';
  let liveLastPostedTumblr = row.lastPostedTumblr ?? '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${row.rowIndex}:${row.rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    const urlIdx = col(colMap, 'Tumblr Post URL', 'tumblr post url');
    const dateIdx = col(colMap, 'lastPostedTumblr', 'lastpostedtumblr');
    if (urlIdx !== undefined) liveTumblrPostUrl = (liveRow[urlIdx] ?? '').trim();
    if (dateIdx !== undefined) liveLastPostedTumblr = (liveRow[dateIdx] ?? '').trim();
  } catch { /* non-critical — fall back to row object */ }

  const newUrl = appendValue(liveTumblrPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(liveLastPostedTumblr, today)
    : liveLastPostedTumblr;

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Tumblr Post',     'tumblr post'],                      value: result.post    },
    { names: ['Tumblr Post URL', 'tumblr post url'],                  value: newUrl },
    { names: ['Tumblr Status',   'tumblr status'],                    value: result.status  },
    { names: ['Tumblr Error',    'tumblr error'],                     value: result.error ?? '' },
    { names: ['Tumblr Batch',    'tumblr batch', 'tumblrBatch'],      value: result.batch ?? '' },
    { names: ['lastPostedTumblr','lastpostedtumblr'],                 value: newLastPosted },
  ]);

  await batchWrite(sheets, data);
  console.log(`   📝 Tumblr updated for row ${row.rowIndex}: ${result.status}`);
}

// ──── Write LinkedIn posting result to unified sheet ──────────────────────

export async function saveUnifiedLinkedInResult(
  row: SheetRow,
  result: { post: string; postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const today = new Date().toISOString().split('T')[0];

  let liveLinkedinPostUrl = row.linkedinPostUrl ?? '';
  let liveLastPostedLi = row.lastPostedLi ?? '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!${row.rowIndex}:${row.rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    const urlIdx = col(colMap, 'LinkedIn Post URL', 'linkedin post url');
    const dateIdx = col(colMap, 'lastPostedLi', 'lastpostedli');
    if (urlIdx !== undefined) liveLinkedinPostUrl = (liveRow[urlIdx] ?? '').trim();
    if (dateIdx !== undefined) liveLastPostedLi = (liveRow[dateIdx] ?? '').trim();
  } catch { /* non-critical — fall back to row object */ }

  console.log(`   [LI save] row ${row.rowIndex} | existing URL: "${liveLinkedinPostUrl}" | new URL: "${result.postUrl}"`);
  const newUrl = appendValue(liveLinkedinPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(liveLastPostedLi, today)
    : liveLastPostedLi;
  console.log(`   [LI save] → writing URL: "${newUrl}" | date: "${newLastPosted}"`);

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['LinkedIn Post',     'linkedin post'],                              value: result.post    },
    { names: ['LinkedIn Post URL', 'linkedin post url'],                          value: newUrl },
    { names: ['LinkedIn Status',   'linkedin status'],                            value: result.status  },
    { names: ['LinkedIn Error',    'linkedin error'],                             value: result.error ?? '' },
    { names: ['liBatch',           'li batch',         'LI Batch'],              value: result.batch ?? '' },
    { names: ['lastPostedLi',      'lastpostedli'],                               value: newLastPosted },
  ]);

  await batchWrite(sheets, data);
  console.log(`   📝 LinkedIn updated for row ${row.rowIndex}: ${result.status}`);
}

// ──── Write LinkedIn image-post result to the "LinkedinCarousel" column ───
// Used by runLiBatch's image-post path: when a row has a locally-saved image
// (column E / "Images URL"), the post goes out via the single-image flow
// instead of the normal text post, and its resulting URL is written here
// (column F / "LinkedinCarousel") instead of the usual Social URL slot.

export async function saveLinkedinCarouselResult(
  rowIndex: number,
  result: { postUrl: string; status: string; error?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const posted = result.status?.toLowerCase() === 'posted';
  const today = new Date().toISOString().split('T')[0];

  const fields = [
    { names: ['LinkedinCrousel', 'linkedincrousel', 'LinkedinCarousel', 'linkedincarousel'], value: posted ? result.postUrl : '' },
  ];
  if (posted) {
    // Images URL (column E) stays filled on purpose — not cleared.
    fields.push({ names: ['CrouselDate', 'crouseldate', 'CarouselDate', 'carouseldate', 'LiCrouselDate', 'licrouseldate'], value: today });
  }

  const data = buildUpdates(colMap, rowIndex, fields);

  await batchWrite(sheets, data);
  console.log(`   📝 LinkedinCarousel updated for row ${rowIndex}: ${result.status}`);
}

// ──── Write Medium posting result to unified sheet ────────────────────────

export async function saveUnifiedMediumResult(
  row: SheetRow,
  result: { post: string; postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  // Medium is exclusively backed by the New Logic tab.
  const sheetConfig = getSheetConfig('newLogic');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.mediumPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedMedium, today)
    : (row.lastPostedMedium ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Medium Post URL', 'medium post url'],                        value: newUrl },
    { names: ['Medium Status',   'medium status'],                          value: result.status  },
    { names: ['Medium Error',    'medium error'],                           value: result.error ?? '' },
    { names: ['mediumBatch',     'medium batch',    'Medium Batch'],        value: result.batch ?? '' },
    { names: ['lastPostedMedium','lastpostedmedium'],                       value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 Medium updated for row ${row.rowIndex}: ${result.status}`);
}

// ──── Write Linkmate posting result to unified sheet ────────────────────

export async function saveUnifiedLinkmateResult(
  row: SheetRow,
  result: { content: string; postUrl: string; status: string; error?: string; batch?: string; lastPosted?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.linkMatePostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedLinkmate, today)
    : (row.lastPostedLinkmate ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Linkmate Content', 'linkmate content'],                       value: result.content    },
    { names: ['Linkmate Post URL', 'linkmate post url'],                     value: newUrl },
    { names: ['Linkmate Status',   'linkmate status'],                       value: result.status  },
    { names: ['Linkmate Error',    'linkmate error'],                        value: result.error ?? '' },
    { names: ['linkmateBatch',     'linkmate batch',    'Linkmate Batch'],   value: result.batch ?? '' },
    { names: ['lastPostedLinkmate','lastpostedlinkmate'],                    value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 Linkmate updated for row ${row.rowIndex}: ${result.status}`);
}

// ──── Write Google Sites posting result to unified sheet ────────────────

export async function saveUnifiedGoogleSiteResult(
  row: SheetRow,
  result: { post: string; postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  // Google Sites is exclusively backed by the New Logic tab.
  const sheetConfig = getSheetConfig('newLogic');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.googleSitePostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedGoogleSite, today)
    : (row.lastPostedGoogleSite ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Google Site Post URL', 'google site post url'],                value: newUrl },
    { names: ['Google Site Status',   'google site status'],                  value: result.status  },
    { names: ['Google Site Error',    'google site error'],                   value: result.error ?? '' },
    { names: ['GoogleSite Batch', 'googleSiteBatch', 'google site batch', 'Google Site Batch'], value: result.batch ?? '' },
    { names: ['lastPostedGoogleSite', 'lastpostedgooglesite'],                value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 Google Sites updated for row ${row.rowIndex}: ${result.status}`);
}

/**
 * Fetch a single row by its Google Sheet row number (1-based, row 1 = header).
 * e.g. rowIndex=15 returns the data in sheet row 15.
 */
export async function getSheetRowByIndex(rowIndex: number, sheetType: SheetType): Promise<SheetRow | null> {
  const sheets = await getSheetsClient();
  const config = getSheetConfig(sheetType);
  const colMap = await getColumnMap(sheets, config.id, config.name);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: config.id,
    range: `${config.name}!A:AZ`,
  }), 'getSheetRowByIndex');

  const rows: string[][] = res.data.values ?? [];
  // rows[0] = header, rows[rowIndex-1] = sheet row rowIndex
  const arrIdx = rowIndex - 1;
  if (arrIdx < 1 || arrIdx >= rows.length) return null;

  return mapRow(rows[arrIdx], colMap, rowIndex, sheetType);
}

// ──── Write Dev.to posting result to unified sheet ──────────────────────

export async function saveUnifiedDevtoResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.devtoPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedDevto, today)
    : (row.lastPostedDevto ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Dev.to Post URL', 'dev.to post url'],                value: newUrl },
    { names: ['Dev.to Status',   'dev.to status'],                  value: result.status  },
    { names: ['Dev.to Error',    'dev.to error'],                   value: result.error ?? '' },
    { names: ['Devto Batch', 'devtoBatch', 'dev.to batch', 'Dev.to Batch'], value: result.batch ?? '' },
    { names: ['lastPostedDevto', 'lastposteddevto'],                value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 Dev.to updated for row ${row.rowIndex}: ${result.status}`);
}

// ──── Write LinkedIn Pulse posting result to unified sheet ──────────────

export async function saveLinkedinPulseResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.linkedinPulsePostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedLinkedinPulse, today)
    : (row.lastPostedLinkedinPulse ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Linkedin Pulse URL', 'LinkedIn Pulse Post URL', 'linkedin pulse post url'], value: newUrl },
    { names: ['Linkedin Pulse Status', 'LinkedIn Pulse Status', 'linkedin pulse status'], value: result.status  },
    { names: ['Linkedin Pulse Error', 'LinkedIn Pulse Error', 'linkedin pulse error'],    value: result.error ?? '' },
    { names: ['linkedinPulseBatch', 'linkedin pulse batch', 'LinkedIn Pulse Batch'],      value: result.batch ?? '' },
    { names: ['lastPosted linkedin Pulse', 'lastPostedLinkedinPulse', 'lastpostedlinkedinpulse'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 LinkedIn Pulse updated for row ${row.rowIndex}: ${result.status}`);
}

export async function saveCalisthenicsResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.calisthenicsPostUrl, result.postUrl);
  console.log(`   🔍 saveCalisthenicsResult: row=${row.rowIndex} postUrl="${result.postUrl}" existing="${row.calisthenicsPostUrl}" → newUrl="${newUrl}"`);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedCalisthenics, today)
    : (row.lastPostedCalisthenics ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Calisthenics Post URL', 'calisthenics post url'], value: newUrl },
    { names: ['Calisthenics Status', 'calisthenics status'], value: result.status  },
    { names: ['Calisthenics Error', 'calisthenics error'],    value: result.error ?? '' },
    { names: ['calisthenicsNBatch', 'calisthenics batch', 'Calisthenics Batch'],      value: result.batch ?? '' },
    { names: ['lastPostedCalisthenics', 'lastpostedcalisthenics'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 Calisthenics updated for row ${row.rowIndex}: ${result.status}`);
}

// ──── Save weekly SERP re-check results (Feature 2) ───────────────────────

export async function saveWeeklySerpRecheck(
  row: SheetRow,
  seoResult: {
    seoRanking: number;
    indexStatus: string;
    priority: string;
    keywords: string[];
  },
  contentResult?: {
    tweet: string;
    fbPost: string;
    liPost: string;
    blog: string;
  }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);
  const today = new Date().toISOString().split('T')[0];

  const indexed = (seoResult.seoRanking ?? -1) >= 0 ? 'yes' : 'no';
  const updates = [
    { names: ['priority'],                                              value: seoResult.priority },
    { names: ['seoIndexed', 'seoindexed'],                             value: indexed },
    { names: ['seoKeywords', 'seokeywords'],                           value: seoResult.keywords.join(', ') },
    // Clear old post URLs so rows are re-picked for re-posting
    { names: ['X Post URL',         'x post url'],                     value: '' },
    { names: ['FB Post URL',        'fb post url'],                    value: '' },
    { names: ['LinkedIn Post URL',  'linkedin post url'],              value: '' },
  ];

  // If content was regenerated, update it
  if (contentResult) {
    updates.push(
      { names: ['X Post', 'x post', 'xPost'],                           value: contentResult.tweet },
      { names: ['FB Post', 'fb post', 'fbPost'],                        value: contentResult.fbPost },
      { names: ['LinkedIn Post', 'linkedin post', 'linkedinPost'],      value: contentResult.liPost },
      { names: ['Message Status'],                                      value: contentResult.blog }
    );
  }

  const data = buildUpdates(colMap, row.rowIndex, updates);
  await batchWrite(sheets, data);
  console.log(`   📝 SERP re-checked for row ${row.rowIndex}: ${seoResult.priority} (${today})`);
}

// ──── Write today's full posting breakdown log into Algo Reports!F (Daily posting count) ────
// Finds the row whose "Report Date" (col A) matches today (IST); if none exists yet,
// appends a new row. Only touches column A (date, on append) and column F — never
// overwrites the Report Content / High Impact / Recommendations / Indexing Rate columns.
// `summaryText` is the full per-platform breakdown + TOTAL (the same text logged to the
// console), not just the bare number.
export async function saveDailyPostingCount(dateIST: string, summaryText: string): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, ALGO_SHEET_ID, ALGO_SHEET_NAME);

  const dateIdx  = col(colMap, 'Report Date', 'report date');
  const countIdx = col(colMap, 'Daily posting count', 'daily posting count');
  if (dateIdx === undefined || countIdx === undefined) {
    console.warn('   ⚠️  saveDailyPostingCount: "Report Date" or "Daily posting count" column not found in Algo Reports');
    return;
  }

  const existing = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: ALGO_SHEET_ID,
    range: `${ALGO_SHEET_NAME}!${colToLetter(dateIdx)}2:${colToLetter(dateIdx)}`,
  }), 'saveDailyPostingCount:read');
  const dateColumn: string[] = (existing.data.values ?? []).map((r: string[]) => (r[0] ?? '').trim());
  const matchOffset = dateColumn.findIndex(d => d === dateIST);

  if (matchOffset >= 0) {
    const rowIndex = matchOffset + 2; // +2: 1-indexed sheet rows, header is row 1
    await sheets.spreadsheets.values.update({
      spreadsheetId: ALGO_SHEET_ID,
      range: `${ALGO_SHEET_NAME}!${colToLetter(countIdx)}${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[summaryText]] },
    });
    console.log(`   📝 Algo Reports row ${rowIndex}: Daily posting count log written`);
  } else {
    const maxCol = Math.max(dateIdx, countIdx) + 1;
    const arr = Array(maxCol).fill('');
    arr[dateIdx] = dateIST;
    arr[countIdx] = summaryText;
    await sheets.spreadsheets.values.append({
      spreadsheetId: ALGO_SHEET_ID,
      range: `${ALGO_SHEET_NAME}!A:A`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [arr] },
    });
    console.log(`   📝 Algo Reports: appended new row for ${dateIST}, Daily posting count log written`);
  }
}

// ──── Read a single row by 1-based row index ────────────────────────────

export async function getRowByIndex(rowIndex: number): Promise<SheetRow | null> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A${rowIndex}:AH${rowIndex}`,
  }), 'getRowByIndex');

  const rows: string[][] = res.data.values ?? [];
  if (rows.length === 0) return null;
  return mapRow(rows[0], colMap, rowIndex);
}

// ──── Read rows across a date range (for unprocessed detection) ──────────

export async function getAllRowsInDateRange(dates: string[]): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getAllRowsInDateRange');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const rowDate   = row[col(colMap, 'date') ?? -1]                 ?? '';
    const rowStatus = row[col(colMap, 'X Status', 'x status') ?? -1] ?? '';

    if (!dates.includes(rowDate)) continue;
    if (rowStatus && rowStatus.trim() !== '') continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  console.log(`   📄 Found ${results.length} unprocessed rows for dates: ${dates.join(', ')}`);
  return results;
}

// ──── Recent reports (for RSS feed) ────────────────────────────────────────
// "date" = "Date to Be Published" — the report's own publish date on
// kenresearch.com, not this pipeline's posting date — exactly what an RSS
// item's pubDate should reflect. Sourced from the Social Media tab since
// that's where every report row first lands before being distributed.

export interface FeedItem {
  title: string;
  url: string;
  date: string; // YYYY-MM-DD as stored in the sheet
}

export async function getRecentReportsForFeed(limit: number = 50): Promise<FeedItem[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getRecentReportsForFeed');

  const rows: string[][] = res.data.values ?? [];
  const titleIdx = col(colMap, 'Title', 'title') ?? -1;
  const urlIdx = col(colMap, 'Target URL', 'target url', 'targetUrl', 'URL', 'url') ?? -1;
  const dateIdx = col(colMap, 'Date to Be Published', 'date to be published', 'date') ?? -1;

  const byUrl = new Map<string, FeedItem>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const title = titleIdx >= 0 ? (row[titleIdx] ?? '').trim() : '';
    const url = urlIdx >= 0 ? (row[urlIdx] ?? '').trim() : '';
    const date = dateIdx >= 0 ? (row[dateIdx] ?? '').trim() : '';
    if (!title || !url || !date) continue;

    // A report can appear on multiple rows (re-posted across platforms) —
    // keep only the newest-dated entry per URL.
    const existing = byUrl.get(url);
    if (!existing || date > existing.date) {
      byUrl.set(url, { title, url, date });
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

// ──── Read unassigned rows (name/batch/date empty, URL+title present) ────

export interface UnassignedRow {
  rowIndex: number;
  title: string;
  targetUrl: string;
  name: string;
  marketValue?: string;
}

export async function getUnassignedRows(): Promise<UnassignedRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const dataRes = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getUnassignedRows');
  const rows: string[][] = dataRes.data.values ?? [];
  const results: UnassignedRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const title     = row[col(colMap, 'Blog Title', 'blog title', 'Title', 'title', 'Main Title') ?? -1]                   ?? '';
    const targetUrl = row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'targetUrl', 'targeturl', 'URL', 'url') ?? -1]  ?? '';
    const seoRanking = row[col(colMap, 'seoRanking', 'priority') ?? -1] ?? '';

    // Must have URL + title
    if (!targetUrl.trim() || !title.trim()) continue;
    // NEW ARCHITECTURE: Skip rows already with priority (P1/P2/P3)
    if (seoRanking.trim()) continue;

    results.push({
      rowIndex: i + 1,
      title,
      targetUrl,
      name: row[col(colMap, 'Name', 'name') ?? -1] ?? '',
      marketValue: row[col(colMap, 'market_value', 'marketValue', 'market value') ?? -1] ?? '',
    });
  }

  console.log(`   📄 Found ${results.length} unassigned rows (no priority yet)`);
  return results;
}

// ──── Get unassigned rows as SheetRow (for batch top-up) ─────────────────

export async function getUnassignedRowsAsSheetRows(limit: number = 15, sheetType: 'social' | 'blog' = 'social'): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const sheetConfig = sheetType === 'blog' ? { id: BLOG_SHEET_ID, name: BLOG_SHEET_NAME } : { id: SOCIAL_SHEET_ID, name: SOCIAL_SHEET_NAME };
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const dataRes = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:AZ`,
  }), 'getUnassignedRowsAsSheetRows');
  const rows: string[][] = dataRes.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const title     = row[col(colMap, 'Blog Title', 'blog title', 'Title', 'title', 'Main Title') ?? -1]                   ?? '';
    const targetUrl = row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'targetUrl', 'targeturl', 'URL', 'url') ?? -1]  ?? '';
    const seoRanking = row[col(colMap, 'seoRanking', 'priority') ?? -1] ?? '';

    // Must have URL + title
    if (!targetUrl.trim() || !title.trim()) continue;
    // Skip rows already with priority (P1/P2/P3)
    if (seoRanking.trim()) continue;

    results.push(mapRow(row, colMap, i + 1, sheetType));
  }

  return results;
}

// ──── Get rows for continuous reposting (priority-based) ──────────────────

export async function getRowsForContinuousXPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousXPosting');
  const rows: string[][] = res.data.values ?? [];
  // urlColNames must be the actual URL column — status column names go in the
  // 7th arg (statusColNames). Previously the status names were passed here by
  // mistake, so isProcessed() checked "is X Status non-empty" instead of "is
  // X Post URL non-empty" — harmless while status only ever held Posted/
  // Failed/Error (also non-empty), but wrongly treats any other non-empty
  // status (e.g. "Generated") as already processed.
  return pickNextSequentialBlogRows(rows, colMap, ['X Post URL', 'x post url', 'xPostUrl'], limit, 'X', 'social', ['X Status', 'x status', 'xStatus']);
}

export async function getRowsForContinuousFbPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousFbPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['FB Post URL', 'fb post url', 'fbPostUrl'], limit, 'FB', 'social', ['FB Status', 'fb status', 'fbStatus']);
}

export async function getRowsForContinuousLiPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousLiPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['LinkedIn Post URL', 'linkedin post url', 'linkedinPostUrl'], limit, 'LI', 'social', ['LinkedIn Status', 'linkedin status', 'liStatus']);
}

export async function getRowsForContinuousTumblrPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsForContinuousTumblrPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['Tumblr Post URL', 'tumblr post url', 'tumblrPostUrl'], limit, 'Tumblr', 'social', ['Tumblr Status', 'tumblr status', 'tumblrStatus']);
}

// ──── Social Media: 2-slot shared posting ──────────────────────────────────
// Slot 1: X, LinkedIn, Instapaper, Raindrop
// Slot 2: Facebook, Tumblr, Pearltrees
// Each row is claimed by exactly one platform per slot — whichever platform's
// cron job runs first for that slot wins the row; the other platforms sharing
// that slot skip it once claimed. Mirrors the New Logic slot pattern (see
// getRowsNeedingSlot above), but on the Social Media tab and with separate
// per-slot columns (Social Platform N / Social URL N / Social Status N /
// Social Batch N / Social Error N / Last Posted Social Platform N) instead of
// a combined P1/P2-encoded string.

export async function getRowsNeedingSocialSlot(slot: 1 | 2, limit: number): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:AZ`,
  }), `getRowsNeedingSocialSlot_${slot}`);
  const rows: string[][] = res.data.values ?? [];

  const titleIdx = col(colMap, 'Title', 'title') ?? -1;
  const targetUrlIdx = col(colMap, 'Target URL', 'target url', 'targetUrl', 'URL', 'url') ?? -1;
  const slotPlatformIdx = col(colMap, `Social Platform ${slot}`) ?? -1;

  if (slotPlatformIdx === -1) {
    console.warn(`   ⚠️ [Social Slot ${slot}] "Social Platform ${slot}" column not found — cannot pick rows.`);
    return [];
  }

  const results: SheetRow[] = [];
  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const title = titleIdx >= 0 ? (row[titleIdx] ?? '').trim() : '';
    const targetUrl = targetUrlIdx >= 0 ? (row[targetUrlIdx] ?? '').trim() : '';
    const slotFilled = (row[slotPlatformIdx] ?? '').trim();
    if (!title || !targetUrl || slotFilled) continue;
    results.push(mapRow(row, colMap, i + 1, 'social'));
  }

  console.log(`   📄 [Social Slot ${slot}] found ${results.length} row(s) ready`);
  return results;
}

/** Rows eligible for the LinkedIn image-post flow: "7Slide" (col H, the
 *  7-slide storyline carousel PDF path) has a local path, but "LinkedIn
 *  Status" (LinkedIn's own dedicated column, same one savePlatformColumnResult
 *  writes for every LI post whether image or text) is still empty — i.e. a
 *  carousel PDF was generated for this row but LinkedIn hasn't been posted
 *  to yet at all. "LinkedIn Status" getting filled on success (or failure)
 *  is itself the completion marker, so a row never gets re-picked.
 *  (Was "Images URL" + "LinkedinCrousel"-driven before 2026-09-22 — switched
 *  to "7Slide" + "LinkedIn Status" per explicit instruction, so the image
 *  and text LI flows share one dedicated completion marker; X's own image
 *  posting still uses "Images URL", untouched.) */
export async function getRowsNeedingLinkedinImagePost(limit: number): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsNeedingLinkedinImagePost');
  const rows: string[][] = res.data.values ?? [];

  const titleIdx = col(colMap, 'Title', 'title') ?? -1;
  const targetUrlIdx = col(colMap, 'Target URL', 'target url', 'targetUrl', 'URL', 'url') ?? -1;
  const sevenSlideIdx = col(colMap, '7Slide', '7slide') ?? -1;
  const carouselIdx = col(colMap, 'LinkedIn Status', 'linkedin status') ?? -1;

  if (sevenSlideIdx === -1 || carouselIdx === -1) {
    console.warn('   ⚠️ [LI Image] "7Slide" or "LinkedIn Status" column not found — cannot pick rows.');
    return [];
  }

  const results: SheetRow[] = [];
  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const title = titleIdx >= 0 ? (row[titleIdx] ?? '').trim() : '';
    const targetUrl = targetUrlIdx >= 0 ? (row[targetUrlIdx] ?? '').trim() : '';
    const imagePath = (row[sevenSlideIdx] ?? '').trim();
    const carouselFilled = (row[carouselIdx] ?? '').trim();
    if (!title || !targetUrl || !imagePath || carouselFilled) continue;
    results.push(mapRow(row, colMap, i + 1, 'social'));
  }

  console.log(`   📄 [LI Image] found ${results.length} row(s) ready`);
  return results;
}

/** Write one platform's post result into its assigned Social Media slot. Only writes Social Platform/URL on success — a failed slot stays blank so the row can be retried by another platform in the same slot. */
export async function saveSocialSlotResult(
  rowIndex: number,
  slot: 1 | 2,
  platformDisplayName: string,
  result: { url: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);
  const today = new Date().toISOString().split('T')[0];

  const fields: { names: string[]; value: string }[] = [
    { names: [`Social Status ${slot}`], value: result.status ?? '' },
    { names: [`Social Batch ${slot}`], value: result.batch ?? '' },
    { names: [`Social Error ${slot}`], value: result.error ?? '' },
  ];
  if (result.status?.toLowerCase() === 'posted') {
    fields.push({ names: [`Social Platform ${slot}`], value: platformDisplayName });
    fields.push({ names: [`Social URL ${slot}`], value: result.url });
    fields.push({ names: [`Last Posted Social Platform ${slot}`], value: today });
  }

  const data = buildUpdates(colMap, rowIndex, fields, SHEET_NAME);
  await batchWrite(sheets, data, SHEET_ID);
}

// ──── Social Media: dedicated per-platform columns ─────────────────────────
// X / Facebook / Instapaper / Tumblr / Raindrop / Pearltrees / LinkedIn each
// own their full column set (lastPosted<Platform> / <platform>Batch /
// <Platform> Post / <Platform> Post URL / <Platform> Status / <Platform>
// Error) — the pattern this project originally used (see the "Previous
// Socila media" tab) before it was consolidated into the shared
// "Social Platform 1/2" slot system above. Added back 2026-09-22 as an
// independent, parallel picking system — the shared-slot functions
// (getRowsNeedingSocialSlot / saveSocialSlotResult) are kept as-is, not
// removed, for possible future reuse.
//
// Picking rule: a row is eligible for a platform once its own <Platform>
// Status cell is empty. Any non-empty status (Posted, Failed, Error, or
// anything else) means that platform already ran on this row — skip it,
// the next row with an empty status for that platform is picked instead.

interface PlatformColumnSet {
  lastPosted: string;
  batch: string;
  post: string;
  url: string;
  status: string;
  error: string;
}

const PLATFORM_COLUMNS = {
  X:          { lastPosted: 'lastPostedX',         batch: 'xBatch',          post: 'X Post',          url: 'X Post URL',          status: 'X Status',          error: 'X Error' },
  Facebook:   { lastPosted: 'lastPostedFb',         batch: 'fbBatch',         post: 'FB Post',         url: 'FB Post URL',         status: 'FB Status',         error: 'FB Error' },
  Instapaper: { lastPosted: 'lastPostedInstapaper', batch: 'instapaperBatch', post: 'Instapaper Post', url: 'Instapaper Post URL', status: 'Instapaper Status', error: 'Instapaper Error' },
  Tumblr:     { lastPosted: 'lastPostedTumblr',     batch: 'tumblrBatch',     post: 'Tumblr Post',     url: 'Tumblr Post URL',     status: 'Tumblr Status',     error: 'Tumblr Error' },
  Raindrop:   { lastPosted: 'lastPostedRaindrop',   batch: 'raindropBatch',   post: 'Raindrop Post',   url: 'Raindrop Post URL',   status: 'Raindrop Status',   error: 'Raindrop Error' },
  Pearltrees: { lastPosted: 'lastPostedPearltrees', batch: 'pearltreesBatch', post: 'Pearltrees Post', url: 'Pearltrees Post URL', status: 'Pearltrees Status', error: 'Pearltrees Error' },
  LinkedIn:   { lastPosted: 'lastPostedLi',         batch: 'liBatch',         post: 'LinkedIn Post',   url: 'LinkedIn Post URL',   status: 'LinkedIn Status',   error: 'LinkedIn Error' },
  Instagram:  { lastPosted: 'lastPostedInstagram',  batch: 'instagramBatch',  post: 'Instagram Post',  url: 'Instagram Post URL',  status: 'Instagram Status',  error: 'Instagram Error' },
} satisfies Record<string, PlatformColumnSet>;

export type PlatformColumnName = keyof typeof PLATFORM_COLUMNS;

/** opts.requireImage: only pick rows that already have an "Images URL" — the image check happens WHILE picking, so a platform that needs images (Instagram) gets `limit` image rows instead of the image rows among the first `limit` unposted ones. */
export async function getRowsNeedingPlatformColumn(platform: PlatformColumnName, limit: number, opts: { requireImage?: boolean } = {}): Promise<SheetRow[]> {
  const cols = PLATFORM_COLUMNS[platform];
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:BZ`,
  }), `getRowsNeedingPlatformColumn_${platform}`);
  const rows: string[][] = res.data.values ?? [];

  const titleIdx = col(colMap, 'Title', 'title') ?? -1;
  const targetUrlIdx = col(colMap, 'Target URL', 'target url', 'targetUrl', 'URL', 'url') ?? -1;
  const statusIdx = col(colMap, cols.status) ?? -1;
  const imageIdx = opts.requireImage ? (col(colMap, 'Images URL', 'images url', 'Image URL', 'image url') ?? -1) : -2;

  if (statusIdx === -1) {
    console.warn(`   ⚠️ [${platform} Column] "${cols.status}" column not found — cannot pick rows.`);
    return [];
  }

  const results: SheetRow[] = [];
  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const title = titleIdx >= 0 ? (row[titleIdx] ?? '').trim() : '';
    const targetUrl = targetUrlIdx >= 0 ? (row[targetUrlIdx] ?? '').trim() : '';
    const statusFilled = (row[statusIdx] ?? '').trim();
    if (!title || !targetUrl || statusFilled) continue;
    if (imageIdx !== -2 && (imageIdx === -1 || !(row[imageIdx] ?? '').trim())) continue;
    results.push(mapRow(row, colMap, i + 1, 'social'));
  }

  console.log(`   📄 [${platform} Column] found ${results.length} row(s) ready`);
  return results;
}

/** Write one platform's post result into its own dedicated columns —
 *  Post (generated content), Post URL, Status, Error, Batch, lastPosted.
 *  Only writes the URL/lastPosted on success — a failed row stays without a
 *  URL so it's visibly distinct, but its Status is still filled (non-empty),
 *  so it will NOT be re-picked (matches the "skip if Status filled" rule
 *  regardless of success/failure). `post` (the generated content) is written
 *  whenever supplied, regardless of success/failure, since it's useful for
 *  debugging a failed post too. */
export async function savePlatformColumnResult(
  rowIndex: number,
  platform: PlatformColumnName,
  result: { url: string; status: string; error?: string; batch?: string; post?: string }
): Promise<void> {
  const cols = PLATFORM_COLUMNS[platform];
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);
  const today = new Date().toISOString().split('T')[0];

  const fields: { names: string[]; value: string }[] = [
    { names: [cols.status], value: result.status ?? '' },
    { names: [cols.batch], value: result.batch ?? '' },
    { names: [cols.error], value: result.error ?? '' },
  ];
  if (result.post !== undefined) {
    fields.push({ names: [cols.post], value: result.post });
  }
  if (result.status?.toLowerCase() === 'posted') {
    fields.push({ names: [cols.url], value: result.url });
    fields.push({ names: [cols.lastPosted], value: today });
  }

  const data = buildUpdates(colMap, rowIndex, fields, SHEET_NAME);
  await batchWrite(sheets, data, SHEET_ID);
}

// ──── Read leftover rows (assigned but unposted from before today) ────────

export interface LeftoverRow {
  rowIndex: number;
  title: string;
  targetUrl: string;
}

export async function getLeftoverRows(today: string): Promise<LeftoverRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getLeftoverRows');

  const rows: string[][] = res.data.values ?? [];
  const results: LeftoverRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row     = rows[i];
    const title     = row[col(colMap, 'title') ?? -1]                  ?? '';
    const targetUrl = row[col(colMap, 'targetUrl', 'targeturl') ?? -1] ?? '';
    const batch     = row[col(colMap, 'batch') ?? -1]                  ?? '';
    const date      = row[col(colMap, 'date') ?? -1]                   ?? '';
    const name      = row[col(colMap, 'Name', 'name') ?? -1]           ?? '';
    const xStatus   = row[col(colMap, 'X Status', 'x status') ?? -1]  ?? '';

    // Must have url + title
    if (!targetUrl.trim() || !title.trim()) continue;
    // Must have been assigned (has batch + date + name) – skip url-title-only rows
    if (!batch.trim() || !date.trim() || !name.trim()) continue;
    // Date must be before today
    if (date.trim() >= today) continue;
    // Must not have been posted
    if (xStatus.trim().toLowerCase() === 'posted') continue;

    results.push({ rowIndex: i + 1, title, targetUrl });
  }

  console.log(`   📄 Found ${results.length} leftover rows before ${today}`);
  return results;
}

// ──── Append url+title rows to end of sheet (for leftover agent) ──────────

export async function appendRowsToSheet(rows: Array<{ title: string; targetUrl: string }>): Promise<void> {
  if (rows.length === 0) return;
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const titleIdx  = col(colMap, 'title');
  const urlIdx    = col(colMap, 'targetUrl', 'targeturl');
  if (titleIdx === undefined || urlIdx === undefined) {
    console.warn('   ⚠️  Cannot append rows – title or targetUrl column not found');
    return;
  }

  const maxCol = Math.max(titleIdx, urlIdx) + 1;
  const data = rows.map(r => {
    const arr = Array(maxCol).fill('');
    arr[titleIdx] = r.title;
    arr[urlIdx]   = r.targetUrl;
    return arr;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: data },
  });
  console.log(`   📄 Appended ${rows.length} leftover rows to end of sheet`);
}

// ──── Append newly-discovered kenresearch.com reports (report watcher) ─────
// Requires 'Type' and 'Region' columns on the Social Media sheet — run
// tools/addReportDiscoveryColumns.ts once to add them. Columns are looked
// up by name and silently skipped if absent (same pattern as
// appendFullRowsToContentPool), so this is safe to call before that setup
// too — it just won't record type/region until the columns exist.
export interface DiscoveredReportRow {
  title: string;
  targetUrl: string;
  date: string;
  type: string;
  region?: string;
}

export async function appendDiscoveredReportRows(rows: DiscoveredReportRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const titleIdx = col(colMap, 'title', 'Title');
  const urlIdx = col(colMap, 'targetUrl', 'targeturl', 'Target URL', 'target url');
  const dateIdx = col(colMap, 'Date to Be Published', 'date to be published', 'date');
  const typeIdx = col(colMap, 'Type', 'type', 'Content Type', 'content type');
  const regionIdx = col(colMap, 'Region', 'region');

  if (titleIdx === undefined || urlIdx === undefined) {
    console.warn('   ⚠️  Cannot append discovered reports — Title or Target URL column not found');
    return 0;
  }

  const maxCol = Math.max(titleIdx, urlIdx, dateIdx ?? 0, typeIdx ?? 0, regionIdx ?? 0) + 1;
  const data = rows.map(r => {
    const arr = Array(maxCol).fill('');
    arr[titleIdx] = r.title;
    arr[urlIdx] = r.targetUrl;
    if (dateIdx !== undefined) arr[dateIdx] = r.date;
    if (typeIdx !== undefined) arr[typeIdx] = r.type;
    if (regionIdx !== undefined) arr[regionIdx] = r.region ?? '';
    return arr;
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: data },
  });
  console.log(`   📄 Appended ${rows.length} newly discovered report row(s)`);
  return rows.length;
}

// ──── RSS Extraction: raw feed landing tab ──────────────────────────────────
// Stage 1 of a two-stage pipeline: every item the RSS watcher sees lands here
// in full, untouched. Stage 2 (reading this tab and feeding qualifying rows
// into Social Media / New Logic) is not built yet — deliberately separate so
// the raw feed is captured and reviewable before that logic exists.

const RSS_EXTRACTION_HEADERS = [
  'Discovered At', 'Title', 'URL', 'Type', 'Region', 'Pub Date',
  'Category (raw)', 'GUID', 'Description', 'Fed to Social', 'Fed to Blog',
];

export interface RssExtractionRow {
  title: string;
  url: string;
  type: string;
  region?: string;
  pubDate: string;
  rawCategory?: string;
  guid?: string;
  description?: string;
}

/** Creates the "RSS Extraction" tab with its header row if it doesn't exist yet. Safe to call repeatedly. */
async function ensureRssExtractionSheet(sheets: any): Promise<void> {
  const cfg = getSheetConfig('rssExtraction');
  const meta = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId: cfg.id,
    fields: 'sheets(properties(sheetId,title))',
  }), 'ensureRssExtractionSheet:meta');

  const exists = meta.data.sheets?.some((s: any) => s.properties?.title === cfg.name);
  if (exists) return;

  console.log(`   📐 Creating "${cfg.name}" tab...`);
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: cfg.id,
    requestBody: {
      requests: [{ addSheet: { properties: { title: cfg.name } } }],
    },
  }), 'ensureRssExtractionSheet:addSheet');

  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: cfg.id,
    range: `${cfg.name}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [RSS_EXTRACTION_HEADERS] },
  }), 'ensureRssExtractionSheet:headers');
  console.log(`   ✅ "${cfg.name}" tab created with header row.`);
}

/** One-time setup: creates the "RSS Extraction" tab + header row now, without needing a new item to trigger it. Safe to call repeatedly. */
export async function createRssExtractionTabIfMissing(): Promise<void> {
  const sheets = await getSheetsClient();
  await ensureRssExtractionSheet(sheets);
}

/** Reads every URL already present in the "RSS Extraction" tab (column C), as a Set for fast dedup lookups. */
async function getExistingRssExtractionUrls(sheets: any): Promise<Set<string>> {
  const cfg = getSheetConfig('rssExtraction');
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: cfg.id,
    range: `${cfg.name}!C:C`,
  }), 'getExistingRssExtractionUrls').catch(() => ({ data: { values: [] } }));
  const values: string[][] = res.data.values ?? [];
  return new Set(values.slice(1).map(r => (r[0] ?? '').trim()).filter(Boolean));
}

/** Appends raw RSS feed items to the "RSS Extraction" tab, creating it first if needed. Skips any URL already present in the tab — no duplicate rows regardless of how many times the same item is pulled. */
export async function appendRssExtractionRows(rows: RssExtractionRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sheets = await getSheetsClient();
  const cfg = getSheetConfig('rssExtraction');
  await ensureRssExtractionSheet(sheets);

  const existingUrls = await getExistingRssExtractionUrls(sheets);
  const deduped = rows.filter(r => !existingUrls.has(r.url.trim()));
  const skipped = rows.length - deduped.length;
  if (skipped > 0) {
    console.log(`   ⏭ Skipped ${skipped} row(s) already present in "${cfg.name}".`);
  }
  if (deduped.length === 0) return 0;

  const discoveredAt = new Date().toISOString();
  const data = deduped.map(r => [
    discoveredAt, r.title, r.url, r.type, r.region ?? '', r.pubDate,
    r.rawCategory ?? '', r.guid ?? '', r.description ?? '', '', '',
  ]);

  await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: cfg.id,
    range: `${cfg.name}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: data },
  }), 'appendRssExtractionRows');
  console.log(`   📡 Appended ${deduped.length} row(s) to "${cfg.name}".`);
  return deduped.length;
}

export interface UnfedRssRow {
  rowIndex: number; // 1-based sheet row
  title: string;
  url: string;
  type: string;
  region: string;
}

/**
 * Reads RSS Extraction rows whose `Fed to Social` / `Fed to Blog` marker
 * (per `channel`) is still blank — i.e. never yet fed into that channel's
 * tab. Once a row is fed, it's marked (via markRssExtractionRowsFed) and
 * never picked again for that channel, even across restarts, until someone
 * manually clears the marker cell.
 */
export async function getUnfedRssExtractionRows(channel: 'social' | 'blog', limit: number): Promise<UnfedRssRow[]> {
  const sheets = await getSheetsClient();
  const cfg = getSheetConfig('rssExtraction');
  await ensureRssExtractionSheet(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: cfg.id,
    range: `${cfg.name}!A:K`,
  }), 'getUnfedRssExtractionRows');
  const rows: string[][] = res.data.values ?? [];

  // Fixed column layout — see RSS_EXTRACTION_HEADERS.
  const titleIdx = 1, urlIdx = 2, typeIdx = 3, regionIdx = 4;
  const fedIdx = channel === 'social' ? 9 : 10;

  const results: UnfedRssRow[] = [];
  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const url = (row[urlIdx] ?? '').trim();
    if (!url) continue;
    const fed = (row[fedIdx] ?? '').trim();
    if (fed) continue;
    results.push({
      rowIndex: i + 1,
      title: (row[titleIdx] ?? '').trim(),
      url,
      type: (row[typeIdx] ?? '').trim(),
      region: (row[regionIdx] ?? '').trim(),
    });
  }
  return results;
}

/** Marks the given RSS Extraction rows as fed into `channel`, so they're never picked again for it. */
export async function markRssExtractionRowsFed(rowIndexes: number[], channel: 'social' | 'blog'): Promise<void> {
  if (rowIndexes.length === 0) return;
  const sheets = await getSheetsClient();
  const cfg = getSheetConfig('rssExtraction');
  const col = channel === 'social' ? 'J' : 'K'; // Fed to Social / Fed to Blog
  const now = new Date().toISOString();
  const data = rowIndexes.map(rowIndex => ({
    range: `${cfg.name}!${col}${rowIndex}`,
    values: [[now]],
  }));
  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: cfg.id,
    requestBody: { valueInputOption: 'RAW', data },
  }), 'markRssExtractionRowsFed');
}

// ──── Read today's rows for FB/LI batches (filtered by platform eligibility) ──

export async function getFbPendingRowsForBatches(xBatches: number[], today: string): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getFbPendingRows');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row       = rows[i];
    const rowBatch  = Number(row[col(colMap, 'batch') ?? -1] ?? -1);
    const rowDate   = row[col(colMap, 'date') ?? -1]                        ?? '';
    const platforms = row[col(colMap, 'platforms') ?? -1]                   ?? '';
    const fbStatus  = row[col(colMap, 'FB Status', 'fb status') ?? -1]      ?? '';

    if (rowDate !== today) continue;
    if (!xBatches.includes(rowBatch)) continue;
    if (!platforms.includes('facebook')) continue;
    if (fbStatus.trim().toLowerCase() === 'posted') continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  return results;
}

export async function getLiPendingRowsForBatches(xBatches: number[], today: string): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getLiPendingRows');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row           = rows[i];
    const rowBatch      = Number(row[col(colMap, 'batch') ?? -1] ?? -1);
    const rowDate       = row[col(colMap, 'date') ?? -1]                          ?? '';
    const platforms     = row[col(colMap, 'platforms') ?? -1]                     ?? '';
    const liStatus      = row[col(colMap, 'LinkedIn Status', 'linkedin status') ?? -1] ?? '';

    if (rowDate !== today) continue;
    if (!xBatches.includes(rowBatch)) continue;
    if (!platforms.includes('linkedin')) continue;
    if (liStatus.trim().toLowerCase() === 'posted') continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  return results;
}

export const getUnassignedXRows = getUnassignedRows;

// ──── Get all rows with a targetUrl and no X Status (pending posts) ──────

export async function getPendingRows(): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getPendingRows');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row       = rows[i];
    const targetUrl = row[col(colMap, 'targetUrl', 'targeturl') ?? -1] ?? '';
    const name      = row[col(colMap, 'Name', 'name') ?? -1]           ?? '';
    const xStatus   = row[col(colMap, 'X Status', 'x status') ?? -1]  ?? '';

    if (!targetUrl.trim()) continue;
    if (!name.trim()) continue;
    if (xStatus.trim().toLowerCase() === 'posted') continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  console.log(`   📄 Found ${results.length} pending rows`);
  return results;
}

// ──── New: get rows ready for FB/LI batch (seoRanking set, postUrl empty) ──

/**
 * Get rows where X has assigned priority (seoRanking/seoPage is set)
 * but fbPostUrl is still empty. Used by FB batch to pick rows to post.
 */
export async function getRowsReadyForFb(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsReadyForFb');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const fbPostUrl  = (row[col(colMap, 'FB Post URL', 'fb post url') ?? -1] ?? '').trim();
    const targetUrl  = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title      = (row[col(colMap, 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no FB post yet
    if (!targetUrl || !title) continue;
    if (fbPostUrl) continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  console.log(`   📄 FB: Found ${results.length} rows ready for posting`);
  return results;
}

/**
 * Get rows where linkedinPostUrl is still empty. Used by LI batch.
 */
export async function getRowsReadyForLi(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsReadyForLi');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const liPostUrl     = (row[col(colMap, 'LinkedIn Post URL', 'linkedin post url') ?? -1] ?? '').trim();
    const targetUrl     = (row[col(colMap, 'Download Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title         = (row[col(colMap, 'Title', 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no LI post yet
    if (!targetUrl || !title) continue;
    if (liPostUrl) continue;

    results.push(mapRow(row, colMap, i + 1));
  }

  console.log(`   📄 LI: Found ${results.length} rows ready for posting`);
  return results;
}

/**
 * Get rows where mediumPostUrl is still empty. Used by Medium batch.
 */
export async function getRowsReadyForMedium(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:BZ`,
  }), 'getRowsReadyForMedium');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const mediumPostUrl = (row[col(colMap, 'Medium Post URL', 'medium post url') ?? -1] ?? '').trim();
    const targetUrl     = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title         = (row[col(colMap, 'Title', 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no Medium post yet
    if (!targetUrl || !title) continue;
    if (mediumPostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  console.log(`   📄 Medium: Found ${results.length} rows ready for posting`);
  return results;
}

/**
 * Get rows where linkMatePostUrl is still empty. Used by Linkmate batch.
 */
export async function getRowsReadyForLinkmate(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:BZ`,
  }), 'getRowsReadyForLinkmate');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const linkMatePostUrl = (row[col(colMap, 'Linkmate Post URL', 'linkmate post url') ?? -1] ?? '').trim();
    const targetUrl       = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title           = (row[col(colMap, 'Title', 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no Linkmate post yet
    if (!targetUrl || !title) continue;
    if (linkMatePostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  console.log(`   📄 Linkmate: Found ${results.length} rows ready for posting`);
  return results;
}

/**
 * Get rows where googleSitePostUrl is still empty. Used by Google Sites batch.
 */
export async function getRowsReadyForGoogleSite(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:BZ`,
  }), 'getRowsReadyForGoogleSite');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const googleSitePostUrl = (row[col(colMap, 'Google Site Post URL', 'google site post url') ?? -1] ?? '').trim();
    const targetUrl         = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title             = (row[col(colMap, 'Title', 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no Google Sites post yet
    if (!targetUrl || !title) continue;
    if (googleSitePostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  console.log(`   📄 Google Sites: Found ${results.length} rows ready for posting`);
  return results;
}

/**
 * Get rows where devtoPostUrl is still empty. Used by Dev.to batch.
 */
export async function getRowsReadyForDevto(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:BZ`,
  }), 'getRowsReadyForDevto');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const devtoPostUrl = (row[col(colMap, 'Dev.to Post URL', 'dev.to post url') ?? -1] ?? '').trim();
    const targetUrl    = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title        = (row[col(colMap, 'Title', 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no Dev.to post yet
    if (!targetUrl || !title) continue;
    if (devtoPostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  console.log(`   📄 Dev.to: Found ${results.length} rows ready for posting`);
  return results;
}

/**
 * Get rows where linkedinPulsePostUrl is still empty. Used by LinkedIn Pulse batch.
 */
export async function getRowsReadyForLinkedinPulse(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:BZ`,
  }), 'getRowsReadyForLinkedinPulse');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const linkedinPulsePostUrl = (row[col(colMap, 'Linkedin Pulse URL', 'LinkedIn Pulse Post URL', 'linkedin pulse post url', 'linkedin pulse url') ?? -1] ?? '').trim();
    const targetUrl            = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl') ?? -1] ?? '').trim();
    const title                = (row[col(colMap, 'Title', 'title') ?? -1] ?? '').trim();

    // Must have URL + title, and no LinkedIn Pulse post yet
    if (!targetUrl || !title) continue;
    if (linkedinPulsePostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  console.log(`   📄 LinkedIn Pulse: Found ${results.length} rows ready for posting`);
  return results;
}

// ──── Continuous posting for blog platforms (sequential: next unposted rows) ──

/**
 * Shared helper: find the last row that already has a URL for this platform,
 * then return the next `limit` rows after it where the URL is still empty.
 * No P1/P2/P3 or SERP required — pure sequential order.
 */
function pickNextSequentialBlogRows(
  rows: string[][],
  colMap: ColMap,
  urlColNames: string[],
  limit: number,
  label: string,
  sheetType: SheetType = 'blog',
  statusColNames?: string[],
  minRowIndex: number = 0,
  requireNewName: boolean = false
): SheetRow[] {
  const urlColIdx = col(colMap, ...urlColNames) ?? -1;
  const titleIdx = col(colMap, 'Blog Title', 'blog title', 'Title', 'title', 'Main Title') ?? -1;
  const targetUrlIdx = col(colMap, 'Report URL', 'Download Report URL', 'Target URL', 'target url', 'targetUrl', 'URL', 'url') ?? -1;
  const statusColIdx = statusColNames ? (col(colMap, ...statusColNames) ?? -1) : -1;
  const newNameIdx = requireNewName ? (col(colMap, 'New Name', 'new name', 'newName') ?? -1) : -1;

  const canDetectViaSheet = urlColIdx >= 0 || statusColIdx >= 0;

  // A row counts as "processed" if it has a URL OR a status (Posted/Failed/Error)
  const isProcessed = (row: string[]): boolean => {
    if (urlColIdx >= 0) {
      if ((row[urlColIdx] ?? '').trim()) return true;
    }
    if (statusColIdx >= 0) {
      const status = (row[statusColIdx] ?? '').trim().toLowerCase();
      if (status === 'posted' || status === 'failed' || status === 'error') return true;
    }
    return false;
  };

  // Find the highest data-row index that has been processed (by sheet content)
  let lastProcessedIdx = 0;
  if (canDetectViaSheet) {
    for (let i = 1; i < rows.length; i++) {
      if (isProcessed(rows[i])) lastProcessedIdx = i;
    }
  }

  // Respect caller-supplied minRowIndex (from local progress file) — take the max
  // minRowIndex is a 1-based sheet row; convert to 0-based array index
  if (minRowIndex > 0) {
    const minArrayIdx = minRowIndex - 1;
    if (minArrayIdx > lastProcessedIdx) {
      console.log(`   📌 [${label}] Progress file last row=${minRowIndex} > sheet scan last=${lastProcessedIdx + 1}. Using progress file.`);
      lastProcessedIdx = minArrayIdx;
    }
  }

  if (!canDetectViaSheet && minRowIndex === 0) {
    console.warn(`   ⚠️ [${label}] No URL/status column found in sheet AND no progress file offset. Columns tried: [${urlColNames.join(', ')}]. Will pick from row 2 every time until columns are added or a batch completes.`);
  }

  // Pick next rows after lastProcessedIdx that haven't been processed
  const results: SheetRow[] = [];
  for (let i = lastProcessedIdx + 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const title = titleIdx >= 0 ? (row[titleIdx] ?? '').trim() : '';
    const targetUrl = targetUrlIdx >= 0 ? (row[targetUrlIdx] ?? '').trim() : '';

    if (isProcessed(row)) continue;
    if (!title || !targetUrl) continue;
    if (requireNewName && newNameIdx >= 0 && !(row[newNameIdx] ?? '').trim()) continue;

    results.push(mapRow(row, colMap, i + 1, sheetType));
  }

  console.log(`   📄 [${label}] Scanning from row ${lastProcessedIdx + 2} → found ${results.length} rows ready`);
  return results;
}

// ──── New Logic: 3-slot independent posting ────────────────────────────────
// 9 platforms, each permanently assigned to exactly one of 3 shared slot
// columns (Blog Platform 1/2/3 + Blog URL 1/2/3) on the "New Logic" tab:
//   Slot 1: Linkmate, Blogger, Coda
//   Slot 2: Calisthenics, Notion, LinkedIn Pulse
//   Slot 3: HackMD, WordPress, Dev.to
// Each platform runs independently (own cron trigger) and just needs the
// next row where ITS slot is still empty — no group/block claiming.

// Shared 15-account roster for the 9 slot platforms — same rotation the old
// group system used. A row's "Name" account, once assigned, is reused by
// every platform that later posts to that row's other slots (assigned once
// on first pick, not per-platform), matching prior behavior.
const NEW_LOGIC_ACCOUNT_NAMES_15 = [
  'aniket', 'krishi', 'sameeksha', 'hritika', 'meenakshi', 'vansh', 'kamakshi',
  'vishal', 'pranav', 'shrey', 'sanya', 'shivani', 'vijay', 'avdhesh', 'abhinav',
];

async function getRowsNeedingSlot(slot: 1 | 2 | 3, limit: number): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('newLogic');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:AD`,
  }), `getRowsNeedingSlot_${slot}`);
  const rows: string[][] = res.data.values ?? [];

  const contentIdx = col(colMap, 'Blog Content', 'blog content') ?? -1;
  const slotPlatformIdx = col(colMap, `Blog Platform ${slot}`) ?? -1;
  const nameIdx = col(colMap, 'Name', 'name') ?? -1;

  if (slotPlatformIdx === -1) {
    console.warn(`   ⚠️ [New Logic] "Blog Platform ${slot}" column not found — cannot pick rows.`);
    return [];
  }

  // Round-robin cursor: count how many rows already have a Name assigned, so
  // a fresh assignment continues the rotation rather than restarting at 0.
  let assignedCount = 0;
  if (nameIdx >= 0) {
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][nameIdx] ?? '').trim()) assignedCount++;
    }
  }

  const results: SheetRow[] = [];
  const nameAssignments: { rowIndex: number; name: string }[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const content = contentIdx >= 0 ? (row[contentIdx] ?? '').trim() : '';
    const slotFilled = (row[slotPlatformIdx] ?? '').trim();
    if (!content || slotFilled) continue;

    const mapped = mapRow(row, colMap, i + 1, 'newLogic');

    if (nameIdx >= 0 && !(row[nameIdx] ?? '').trim()) {
      const accountName = NEW_LOGIC_ACCOUNT_NAMES_15[assignedCount % NEW_LOGIC_ACCOUNT_NAMES_15.length];
      assignedCount++;
      mapped.name = accountName;
      nameAssignments.push({ rowIndex: mapped.rowIndex, name: accountName });
    }

    results.push(mapped);
  }

  if (nameAssignments.length > 0) {
    const claimData = nameAssignments.flatMap(a =>
      buildUpdates(colMap, a.rowIndex, [{ names: ['Name', 'name'], value: a.name }], sheetConfig.name)
    );
    await batchWrite(sheets, claimData, sheetConfig.id);
  }

  console.log(`   📄 [New Logic] Slot ${slot}: found ${results.length} row(s) ready`);
  return results;
}

// ──── Feed-row writer: fill the first EMPTY rows, never append below ─────────
// The sheets often have pre-filled cells further down (e.g. Name / New Name
// round-robin columns), so values.append (which lands after the last row with
// ANY data) would put fed URLs below that block and misalign them from their
// names. Instead: scan the Target URL column for empty rows (within the grid)
// and write ONLY the url/title/(report tab) cells there. Other columns are
// never touched. Any rows that don't fit in the existing grid are appended.
async function writeFeedRowsIntoEmptySlots(
  sheets: any,
  sheetConfig: { id: string; name: string },
  urlIdx: number,
  items: { cells: { idx: number; value: string }[] }[],
  label: string,
): Promise<number> {
  const urlLetter = colToLetter(urlIdx);
  const colRes: any = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!${urlLetter}1:${urlLetter}`,
  }), `${label}:urlColumn`);
  const urlCol: string[][] = colRes.data.values ?? [];

  const meta: any = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId: sheetConfig.id,
    fields: 'sheets(properties(title,gridProperties(rowCount)))',
  }), `${label}:gridSize`);
  const gridRows: number = meta.data.sheets?.find((sh: any) => sh.properties?.title === sheetConfig.name)
    ?.properties?.gridProperties?.rowCount ?? urlCol.length;

  const emptyRows: number[] = [];
  for (let r = 2; r <= gridRows && emptyRows.length < items.length; r++) {
    if (!(urlCol[r - 1]?.[0] ?? '').trim()) emptyRows.push(r);
  }

  const data = emptyRows.flatMap((row, i) =>
    items[i].cells.map(c => ({ range: `${sheetConfig.name}!${colToLetter(c.idx)}${row}`, values: [[c.value]] })));
  if (data.length > 0) {
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetConfig.id,
      requestBody: { valueInputOption: 'RAW', data },
    }), `${label}:write`);
    console.log(`   📄 [${label}] Wrote ${emptyRows.length} row(s) into empty rows ${emptyRows[0]}–${emptyRows[emptyRows.length - 1]}.`);
  }

  // Overflow beyond the current grid: append (no pre-filled data can exist there).
  const leftover = items.slice(emptyRows.length);
  if (leftover.length > 0) {
    const maxCol = Math.max(...leftover.flatMap(it => it.cells.map(c => c.idx))) + 1;
    const values = leftover.map(it => {
      const arr: string[] = Array(maxCol).fill('');
      for (const c of it.cells) arr[c.idx] = c.value;
      return arr;
    });
    await withRetry(() => sheets.spreadsheets.values.append({
      spreadsheetId: sheetConfig.id,
      range: `${sheetConfig.name}!A:A`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    }), `${label}:append`);
    console.log(`   📄 [${label}] Appended ${leftover.length} overflow row(s) past the grid.`);
  }
  return items.length;
}

// ──── RSS/Distributed-URL feeder: write into New Logic (blank content) ─────
// Writes Target URL + Title only — Blog Content stays blank for blogGenLoop
// to fill in later. "Report Tab" records where the URL came from ("RSS" or
// "R.P"/"R.A"/"R.S"/"R.V") purely for traceability.

export interface NewLogicFeedRow {
  url: string;
  title: string;
  sourceTag: string; // "RSS" or "R.P" / "R.A" / "R.S" / "R.V"
}

export async function appendNewLogicFeedRows(rows: NewLogicFeedRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('newLogic');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const urlIdx = col(colMap, 'Target URL', 'target url');
  // Fed report names go in "Report Title" (the generated blog title lives in "Title"); fall back to "Title" only if that column doesn't exist.
  const titleIdx = col(colMap, 'Report Title', 'report title') ?? col(colMap, 'Title', 'title');
  const reportTabIdx = col(colMap, 'Report Tab', 'report tab');

  if (urlIdx === undefined) {
    console.warn('   ⚠️ [New Logic Feed] "Target URL" column not found — cannot append.');
    return 0;
  }

  return writeFeedRowsIntoEmptySlots(sheets, sheetConfig, urlIdx, rows.map(r => ({
    cells: [
      { idx: urlIdx, value: r.url },
      ...(titleIdx !== undefined ? [{ idx: titleIdx, value: r.title }] : []),
      ...(reportTabIdx !== undefined ? [{ idx: reportTabIdx, value: r.sourceTag }] : []),
    ],
  })), 'New Logic Feed');
}

// ──── RSS/Distributed-URL feeder: write into Social Media (with Name) ──────
// Writes Target URL + Title + a round-robin-assigned Name (from the same 15-
// persona pool New Logic uses) — Social Media's own picker doesn't auto-
// assign Name like New Logic's does, so it has to happen here at write time
// or these rows can never actually log in to post.

export interface SocialMediaFeedRow {
  url: string;
  title: string;
}

export async function appendSocialMediaFeedRows(rows: SocialMediaFeedRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('social');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const urlIdx = col(colMap, 'Target URL', 'target url', 'targetUrl', 'URL', 'url');
  // Social Media tab: the report name goes in "Title".
  const titleIdx = col(colMap, 'Title', 'title');
  if (urlIdx === undefined) {
    console.warn('   ⚠️ [Social Media Feed] "Target URL"/"targetUrl" column not found — cannot append.');
    return 0;
  }

  // Writes only URL + Title into the first empty rows — Name is pre-assigned
  // in the sheet and must not be touched here.
  return writeFeedRowsIntoEmptySlots(sheets, sheetConfig, urlIdx, rows.map(r => ({
    cells: [
      { idx: urlIdx, value: r.url },
      ...(titleIdx !== undefined ? [{ idx: titleIdx, value: r.title }] : []),
    ],
  })), 'Social Media Feed');
}

// Medium shares slot 1 of the New Logic 3-slot system with Linkmate,
// Blogger, Coda, Velog, and Scribd — same row pool, same "Blog Platform 1"/
// "Blog URL 1" shared columns, written via saveSlotResult() (not its own
// dedicated Medium Status/Post URL columns).
export async function getRowsForContinuousMediumPosting(limit: number = 25): Promise<SheetRow[]> {
  return getRowsNeedingSlot(1, limit);
}

// archive.org and MediaFire both use New Logic slot 3 ("Blog Platform 3"/"Blog
// URL 3"), shared with HackMD/WordPress/Dev.to/4shared/Telegraph.
export async function getRowsForContinuousArchiveOrgPosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(3, limit);
}

export async function getRowsForContinuousFigsharePosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(3, limit);
}

export async function getRowsForContinuousMediaFirePosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(3, limit);
}

export async function getRowsForContinuousLinkmatePosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(1, limit);
}

export async function getRowsForContinuousDevtoPosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(3, limit);
}

// Google Sites shares slot 2 of the New Logic 3-slot system with
// Calisthenics, Notion, LinkedIn Pulse, and PdfHost — same row pool, same
// "Blog Platform 2"/"Blog URL 2" shared columns, written via
// saveSlotResult() (not its own dedicated Google Site Status/Post URL
// columns).
export async function getRowsForContinuousGoogleSitePosting(limit: number = 25): Promise<SheetRow[]> {
  return getRowsNeedingSlot(2, limit);
}

export async function getRowsForContinuousLinkedinPulsePosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(2, limit);
}

export async function getRowsForContinuousCalisthenicsPosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(2, limit);
}

// ──── Continuous row picking for FB/LI (legacy - kept for compatibility) ──

export async function getRowsWithoutFbUrl(startRowIndex: number, limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsWithoutFbUrl');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];
  let count = 0;
  let currentRowIndex = 0;

  for (let i = 1; i < rows.length && count < limit; i++) {
    const row = rows[i];
    const fbPostUrl = row[col(colMap, 'FB Post URL', 'fb post url') ?? -1] ?? '';

    // Skip rows that already have fbPostUrl filled
    if (fbPostUrl.trim()) continue;

    currentRowIndex++;

    // Only include rows >= startRowIndex
    if (currentRowIndex < startRowIndex) continue;

    results.push(mapRow(row, colMap, i + 1));
    count++;
  }

  console.log(`   📄 FB: Found ${results.length} rows starting from index ${startRowIndex}`);
  return results;
}

export async function getRowsWithoutLiUrl(startRowIndex: number, limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getRowsWithoutLiUrl');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];
  let count = 0;
  let currentRowIndex = 0;

  for (let i = 1; i < rows.length && count < limit; i++) {
    const row = rows[i];
    const liPostUrl = row[col(colMap, 'LinkedIn Post URL', 'linkedin post url') ?? -1] ?? '';

    // Skip rows that already have liPostUrl filled
    if (liPostUrl.trim()) continue;

    currentRowIndex++;

    // Only include rows >= startRowIndex
    if (currentRowIndex < startRowIndex) continue;

    results.push(mapRow(row, colMap, i + 1));
    count++;
  }

  console.log(`   📄 LI: Found ${results.length} rows starting from index ${startRowIndex}`);
  return results;
}

// ──── Get URLs due for weekly SERP re-check (Week 2+ feature) ──────────

export async function getUrlsDueForRecheck(): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  }), 'getUrlsDueForRecheck');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];
  const today = new Date();
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const targetUrl = row[col(colMap, 'targetUrl', 'targeturl') ?? -1] ?? '';
    const lastSerpCheckDate = row[col(colMap, 'lastSerpCheckDate', 'last serp check date') ?? -1] ?? '';
    const priority = row[col(colMap, 'priority', 'seoRanking') ?? -1] ?? '';

    // Need: targetUrl exists AND priority was assigned AND lastSerpCheckDate <= 7 days ago
    if (!targetUrl.trim()) continue;
    if (!priority.trim()) continue; // Skip unprocessed URLs

    // If no lastSerpCheckDate, it's new - skip
    if (!lastSerpCheckDate.trim()) continue;

    // Check if > 7 days old
    if (lastSerpCheckDate <= sevenDaysAgo) {
      results.push(mapRow(row, colMap, i + 1));
    }
  }

  console.log(`   📄 Found ${results.length} URLs due for SERP re-check (> 7 days old)`);
  return results;
}

// ──── Batch-assign name/batch/date back to sheet rows ──────────────────

export interface RowAssignment {
  rowIndex: number;
  name: string;
  batch: number;
  date: string;
}

export async function assignRowsBatch(assignments: RowAssignment[]): Promise<void> {
  if (assignments.length === 0) return;
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets);

  const nameCol  = colToLetter(col(colMap, 'Name', 'name') ?? 0);
  const batchCol = colToLetter(col(colMap, 'batch') ?? 0);
  const dateCol  = colToLetter(col(colMap, 'date') ?? 0);

  const data = assignments.flatMap(a => [
    { range: `${SHEET_NAME}!${nameCol}${a.rowIndex}`,  values: [[a.name]] },
    { range: `${SHEET_NAME}!${batchCol}${a.rowIndex}`, values: [[String(a.batch)]] },
    { range: `${SHEET_NAME}!${dateCol}${a.rowIndex}`,  values: [[a.date]] },
  ]);

  const CHUNK = 500;
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = data.slice(i, i + CHUNK);
    await withRetry(() => sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: chunk },
    }), 'assignRowsBatch');
  }
  console.log(`   ✔ Assigned ${assignments.length} rows`);
}

export const assignXRowsBatch  = (a: RowAssignment[]) => assignRowsBatch(a);
export const assignFbRowsBatch = (a: RowAssignment[]) => assignRowsBatch(a);
export const assignLiRowsBatch = (a: RowAssignment[]) => assignRowsBatch(a);

// ──── Internal helpers ──────────────────────────────────────────────────

/**
 * Converts exact rank position to a human-readable sheet value.
 *   rankPosition > 0  → "PageNo=1 ranking=7"  (page number + exact position)
 *   rankPosition = 0  → "PageNo=11+ ranking=100+"  (indexed but outside top 100)
 *   rankPosition = -1 → "N/A" (unknown / SerpAPI unavailable)
 */
function positionToString(rankPosition: number, indexStatus: string): string {
  if (rankPosition > 0 && rankPosition < 999) {
    const page = Math.ceil(rankPosition / 10);
    return `page=${page}/ranking=${rankPosition}`;
  }
  if (rankPosition === 999) return 'page=NA/ranking=NA';
  if (rankPosition === 0) return 'page=11+/ranking=100+';
  return 'N/A';
}

// ──── Get next batch number from sheet (last written batch + 1) ─────────

export async function getLastBatchNumber(
  batchColNames: string[],
  sheetType: SheetType = 'social'
): Promise<number> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(sheetType);
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const batchColIdx = col(colMap, ...batchColNames);
  if (batchColIdx === undefined) return 0;

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id,
    range: `${sheetConfig.name}!A:AZ`,
  }), 'getLastBatchNumber');

  const rows: string[][] = res.data.values ?? [];
  let maxBatch = 0;
  for (let i = 1; i < rows.length; i++) {
    const val = (rows[i][batchColIdx] || '').trim();
    if (val.startsWith('Batch ')) {
      const num = parseInt(val.slice(6), 10);
      if (!isNaN(num) && num > maxBatch) maxBatch = num;
    }
  }
  return maxBatch;
}

function buildUpdates(
  colMap: ColMap,
  rowIndex: number,
  fields: { names: string[]; value: string }[],
  sheetName: string = SHEET_NAME
): { range: string; values: string[][] }[] {
  const results: { range: string; values: string[][] }[] = [];
  for (const f of fields) {
    const colIdx = col(colMap, ...f.names);
    if (colIdx === undefined) {
      console.warn(`   ⚠️ buildUpdates: column NOT FOUND for names [${f.names.join(', ')}] – skipping`);
    } else {
      results.push({
        range: `${sheetName}!${colToLetter(colIdx)}${rowIndex}`,
        values: [[f.value]],
      });
    }
  }
  if (results.length === 0) {
    console.warn(`   ⚠️ buildUpdates: NO columns matched for row ${rowIndex} – nothing will be written!`);
  } else {
    console.log(`   ✔ buildUpdates: ${results.length}/${fields.length} fields matched for row ${rowIndex}`);
  }
  return results;
}

// ──── Write PDF / PPTX file paths back to the sheet ────────────────────────

export async function savePdfPath(row: SheetRow, pdfPath: string, pptxPath?: string, sheetType: SheetType = 'blog'): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(sheetType);
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const fields: { names: string[]; value: string }[] = [
    { names: ['PDF Path', 'pdf path', 'pdfPath'], value: pdfPath },
  ];

  if (pptxPath) {
    fields.push({ names: ['PPTX Path', 'pptx path', 'pptxPath'], value: pptxPath });
  }

  const data = buildUpdates(colMap, row.rowIndex, fields, sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
  console.log(`   📝 PDF/PPTX paths saved for row ${row.rowIndex} on "${sheetConfig.name}"`);
}

async function batchWrite(sheets: any, data: { range: string; values: string[][] }[], spreadsheetId: string = SHEET_ID): Promise<void> {
  if (data.length === 0) {
    console.warn('   ⚠️ batchWrite: called with EMPTY data – nothing to write');
    return;
  }
  console.log(`   ✔ batchWrite: writing ${data.length} cells – ${data.map(d => d.range).join(', ')}`);
  await withRetry(() => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data },
  }), 'batchWrite');
}

function colToLetter(col: number): string {
  let letter = '';
  let n = col + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}

// ──── Sunday Examination: Move Failed Posts to End of Sheet ──────────────────

export async function examineSundayFailedPosts(): Promise<void> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:BZ`,
  }), 'examineSundayFailedPosts');

  const rows: string[][] = res.data.values ?? [];
  const failedRows: { rowIndex: number; data: string[]; platform: string }[] = [];
  let lastDataRowIndex = 1; // Start from header

  // Column indexes for relevant fields
  const descTitleCol = col(colMap, 'descriptionTitle', 'Report Title', 'description title', 'report title');
  const targetUrlCol = col(colMap, 'targetUrl', 'Target URL', 'Download Report URL', 'target url', 'url');

  // Platform status columns
  const mediumStatusCol = col(colMap, 'mediumStatus', 'Medium Status', 'medium status');
  const mediumUrlCol = col(colMap, 'mediumPostUrl', 'Medium Post URL', 'medium post url');
  const linkmateStatusCol = col(colMap, 'linkMateStatus', 'Linkmate Status', 'linkmate status');
  const linkmateUrlCol = col(colMap, 'linkMatePostUrl', 'Linkmate Post URL', 'linkmate post url');
  const googleSiteStatusCol = col(colMap, 'googleSiteStatus', 'Google Site Status', 'google site status');
  const googleSiteUrlCol = col(colMap, 'googleSitePostUrl', 'Google Site Post URL', 'google site post url');
  const devtoStatusCol = col(colMap, 'devtoStatus', 'Dev.to Status', 'dev.to status');
  const devtoUrlCol = col(colMap, 'devtoPostUrl', 'Dev.to Post URL', 'dev.to post url');
  const liPulseStatusCol = col(colMap, 'linkedinPulseStatus', 'LinkedIn Pulse Status', 'linkedin pulse status');
  const liPulseUrlCol = col(colMap, 'linkedinPulsePostUrl', 'LinkedIn Pulse Post URL', 'linkedin pulse post url');
  const calisthenicsStatusCol = col(colMap, 'calisthenicsStatus', 'Calisthenics Status', 'calisthenics status');
  const calisthenicsUrlCol = col(colMap, 'calisthenicsPostUrl', 'Calisthenics Post URL', 'calisthenics post url');

  // Scan for failed rows and last data row
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const descTitle = (row[descTitleCol ?? -1] ?? '').trim();
    const targetUrl = (row[targetUrlCol ?? -1] ?? '').trim();

    // Track last row with data
    if (descTitle || targetUrl) {
      lastDataRowIndex = i + 1; // Convert to 1-based for sheet operations
    }

    // Check for failed posts
    const checks = [
      { status: mediumStatusCol, url: mediumUrlCol, platform: 'Medium' },
      { status: linkmateStatusCol, url: linkmateUrlCol, platform: 'Linkmate' },
      { status: googleSiteStatusCol, url: googleSiteUrlCol, platform: 'Google Sites' },
      { status: devtoStatusCol, url: devtoUrlCol, platform: 'Dev.to' },
      { status: liPulseStatusCol, url: liPulseUrlCol, platform: 'LinkedIn Pulse' },
      { status: calisthenicsStatusCol, url: calisthenicsUrlCol, platform: 'Calisthenics' },
    ];

    for (const check of checks) {
      if (check.status === undefined || check.url === undefined) continue;

      const status = (row[check.status] ?? '').trim();
      const postUrl = (row[check.url] ?? '').trim();

      if (status.toLowerCase() === 'failed' && !postUrl) {
        failedRows.push({
          rowIndex: i + 1,
          data: [...row],
          platform: check.platform,
        });
        break; // Don't count same row twice for multiple platforms
      }
    }
  }

  if (failedRows.length === 0) {
    console.log(`   ✅ Sunday Examination: No failed posts to move`);
    return;
  }

  console.log(`   🔍 Sunday Examination: Found ${failedRows.length} failed posts`);

  // Insert failed rows at the end (after lastDataRowIndex)
  const insertStartRow = lastDataRowIndex + 1;
  const updates: any[] = [];

  for (let i = 0; i < failedRows.length; i++) {
    const failedRow = failedRows[i];
    const sheetRowIndex = insertStartRow + i;

    // Build update for this row
    const rowData: any[] = [];
    for (let colIndex = 0; colIndex < failedRow.data.length; colIndex++) {
      rowData.push({ userEnteredValue: { stringValue: failedRow.data[colIndex] ?? '' } });
    }

    // Append rows to sheet
    updates.push({
      range: `${BLOG_SHEET_NAME}!A${sheetRowIndex}`,
      values: [failedRow.data],
    });
  }

  // Write all updates
  await batchWrite(sheets, updates, BLOG_SHEET_ID);

  console.log(`   📋 Moved ${failedRows.length} failed posts to rows ${insertStartRow}-${insertStartRow + failedRows.length - 1}`);
  console.log(`      Failed posts:`);
  for (const fp of failedRows) {
    const title = (fp.data[col(colMap, 'Blog Title', 'blog title', 'Title', 'title', 'Main Title') ?? -1] ?? 'N/A').slice(0, 50);
    console.log(`        • ${title}... (${fp.platform})`);
  }
}

// ──── Substack Blog Posting ─────────────────────────────────────────────────────

export async function getRowsReadyForSubstack(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:BZ`,
  }), 'getRowsReadyForSubstack');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const substackPostUrl = (row[col(colMap, 'Substack Post URL', 'substack post url') ?? -1] ?? '').trim();
    const targetUrl = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl', 'URL') ?? -1] ?? '').trim();
    const title = (row[col(colMap, 'Blog Title', 'blog title', 'Title', 'title', 'Main Title') ?? -1] ?? '').trim();

    if (!targetUrl || !title) continue;
    if (substackPostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  return results;
}

export async function getRowsForContinuousSubstackPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:BZ`,
  }), 'getRowsForContinuousSubstackPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['Substack Post URL', 'substack post url', 'substackPostUrl'], limit, 'Substack');
}

export async function getRowsForContinuousWordpressPosting(limit: number = 15, _minRowIndex: number = 0): Promise<SheetRow[]> {
  return getRowsNeedingSlot(3, limit);
}

// Shared helper: pick rows where the given status column is empty
async function pickRowsByEmptyStatus(
  statusColNames: string[],
  label: string,
  limit: number,
  sheetType: 'blog' | 'social' | 'newLogic' = 'blog',
): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(sheetType);
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: sheetConfig.id, range: `${sheetConfig.name}!A:ZZ`,
  }), `pickRowsByEmptyStatus_${label}`);
  const rows: string[][] = res.data.values ?? [];

  const statusIdx    = col(colMap, ...statusColNames) ?? -1;
  const titleIdx     = col(colMap, 'Blog Title', 'blog title', 'Title', 'title', 'Main Title') ?? -1;
  const targetUrlIdx = col(colMap, 'Report URL', 'Download Report URL', 'Target URL', 'target url', 'targetUrl', 'URL', 'url') ?? -1;
  // New Logic rows don't get a "Name" account until some platform assigns
  // one (getRowsNeedingSlot does this for the 9 slot platforms) — PdfHost
  // isn't part of that slot system, so it needs its own round-robin
  // assignment here, same roster/logic as getRowsNeedingSlot.
  const nameIdx = sheetType === 'newLogic' ? (col(colMap, 'Name', 'name') ?? -1) : -1;

  if (statusIdx < 0) {
    console.warn(`   ⚠️ [${label}] Status column not found. Tried: [${statusColNames.join(', ')}]. Check sheet headers.`);
    return [];
  }

  let assignedCount = 0;
  if (nameIdx >= 0) {
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][nameIdx] ?? '').trim()) assignedCount++;
    }
  }

  const results: SheetRow[] = [];
  const nameAssignments: { rowIndex: number; name: string }[] = [];
  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    if ((row[statusIdx] ?? '').trim()) continue;  // Posted / Failed / Error → skip

    const title     = titleIdx >= 0 ? (row[titleIdx] ?? '').trim() : '';
    const targetUrl = targetUrlIdx >= 0 ? (row[targetUrlIdx] ?? '').trim() : '';
    if (!title || !targetUrl) continue;

    const mapped = mapRow(row, colMap, i + 1, sheetType);
    if (nameIdx >= 0 && !(row[nameIdx] ?? '').trim()) {
      const accountName = NEW_LOGIC_ACCOUNT_NAMES_15[assignedCount % NEW_LOGIC_ACCOUNT_NAMES_15.length];
      assignedCount++;
      mapped.name = accountName;
      nameAssignments.push({ rowIndex: mapped.rowIndex, name: accountName });
    }

    results.push(mapped);
  }

  if (nameAssignments.length > 0) {
    const claimData = nameAssignments.flatMap(a =>
      buildUpdates(colMap, a.rowIndex, [{ names: ['Name', 'name'], value: a.name }], sheetConfig.name)
    );
    await batchWrite(sheets, claimData, sheetConfig.id);
  }

  console.log(`   📄 [${label}] Found ${results.length} rows with empty status (col idx ${statusIdx}) on "${sheetConfig.name}"`);
  return results;
}

export async function getRowsForContinuousBloggerPosting(limit: number = 15, _minRowIndex: number = 0): Promise<SheetRow[]> {
  return getRowsNeedingSlot(1, limit);
}

export async function saveUnifiedSubstackResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.substackPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedSubstack, today)
    : (row.lastPostedSubstack ?? '');

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Substack Post URL', 'substack post url'], value: newUrl },
    { names: ['Substack Status', 'substack status'], value: result.status },
    { names: ['Substack  Error', 'Substack Error', 'substack  error', 'substack error'], value: result.error ?? '' },
    { names: ['substackBatch', 'substack batch', 'Substack Batch'], value: result.batch ?? '' },
    { names: ['lastPostedSubstack', 'lastpostedsubstack'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── HackMD Blog Posting ─────────────────────────────────────────────────────

export async function getRowsReadyForHackmd(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID,
    range: `${BLOG_SHEET_NAME}!A:ZZ`,
  }), 'getRowsReadyForHackmd');

  const rows: string[][] = res.data.values ?? [];
  const results: SheetRow[] = [];

  for (let i = 1; i < rows.length && results.length < limit; i++) {
    const row = rows[i];
    const hackmdStatus  = (row[col(colMap, 'HackMD Status',   'Hackmd Status',   'hackmd status')   ?? -1] ?? '').trim();
    const hackmdPostUrl = (row[col(colMap, 'HackMD Post URL', 'Hackmd Post URL', 'hackmd post url') ?? -1] ?? '').trim();
    const targetUrl = (row[col(colMap, 'Download Report URL', 'Report URL', 'Target URL', 'target url', 'targetUrl', 'URL') ?? -1] ?? '').trim();
    const title = (row[col(colMap, 'Blog Title', 'blog title', 'Title', 'title', 'Main Title') ?? -1] ?? '').trim();

    if (!targetUrl || !title) continue;
    if (hackmdStatus || hackmdPostUrl) continue;

    results.push(mapRow(row, colMap, i + 1, 'blog'));
  }

  return results;
}

export async function getRowsForContinuousHackmdPosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(3, limit);
}

// Telegraph is a long-form blog platform, not a social-media one — it was
// previously wired to the Social Media tab's slot system (short-form
// content, real blog HTML usually absent), which meant it almost always
// fell back to a minimal stub instead of an actual article. Moved to New
// Logic Slot 3 (shares it with Dev.to/WordPress/HackMD/4shared) so it
// posts the same full blogContent the other blog platforms do.
export async function getRowsForContinuousTelegraphPosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(3, limit);
}

export async function saveUnifiedWordpressResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];

  let liveWordpressPostUrl = row.wordpressPostUrl ?? '';
  let liveLastPostedWordpress = row.lastPostedWordpress ?? '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetConfig.id,
      range: `${sheetConfig.name}!${row.rowIndex}:${row.rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    const urlIdx = col(colMap, 'WordPress Post URL', 'wordpress post url');
    const dateIdx = col(colMap, 'lastPostedWordpress', 'lastpostedwordpress');
    if (urlIdx !== undefined) liveWordpressPostUrl = (liveRow[urlIdx] ?? '').trim();
    if (dateIdx !== undefined) liveLastPostedWordpress = (liveRow[dateIdx] ?? '').trim();
  } catch { /* non-critical */ }

  const newUrl = appendValue(liveWordpressPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(liveLastPostedWordpress, today)
    : liveLastPostedWordpress;

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['WordPress Post URL', 'wordpress post url'], value: newUrl },
    { names: ['WordPress Status', 'wordpress status'], value: result.status },
    { names: ['WordPress Error', 'wordpress error'], value: result.error ?? '' },
    { names: ['wordpressBatch', 'wordpress batch', 'WordPress Batch'], value: result.batch ?? '' },
    { names: ['lastPostedWordpress', 'lastpostedwordpress'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
}

export async function saveUnifiedBloggerResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];

  let liveBloggerPostUrl = row.bloggerPostUrl ?? '';
  let liveLastPostedBlogger = row.lastPostedBlogger ?? '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetConfig.id,
      range: `${sheetConfig.name}!${row.rowIndex}:${row.rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    const urlIdx = col(colMap, 'Blogger Post URL', 'blogger post url');
    const dateIdx = col(colMap, 'Last Posted Blogger', 'lastPostedBlogger', 'lastpostedblogger');
    if (urlIdx !== undefined) liveBloggerPostUrl = (liveRow[urlIdx] ?? '').trim();
    if (dateIdx !== undefined) liveLastPostedBlogger = (liveRow[dateIdx] ?? '').trim();
  } catch { /* non-critical */ }

  const newUrl = appendValue(liveBloggerPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(liveLastPostedBlogger, today)
    : liveLastPostedBlogger;

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Blogger Post URL', 'blogger post url'], value: newUrl },
    { names: ['Blogger Status', 'blogger status'], value: result.status },
    { names: ['Blogger Error', 'blogger error'], value: result.error ?? '' },
    { names: ['bloggerBatch', 'blogger batch', 'Blogger Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Blogger', 'lastPostedBlogger', 'lastpostedblogger'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
}

export async function saveUnifiedHackmdResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];

  // Re-read live cell values so we always append to the current sheet data,
  // not the stale row object fetched at batch-start.
  let liveHackmdPostUrl = row.hackmdPostUrl ?? '';
  let liveLastPostedHackmd = row.lastPostedHackmd ?? '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetConfig.id,
      range: `${sheetConfig.name}!${row.rowIndex}:${row.rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    const urlIdx = col(colMap, 'HackMD Post URL', 'Hackmd Post URL', 'hackmd post url');
    const dateIdx = col(colMap, 'lastPostedHackmd', 'lastPostedHackMD', 'lastpostedhackmd');
    if (urlIdx !== undefined) liveHackmdPostUrl = (liveRow[urlIdx] ?? '').trim();
    if (dateIdx !== undefined) liveLastPostedHackmd = (liveRow[dateIdx] ?? '').trim();
  } catch { /* non-critical — fall back to row object */ }

  console.log(`   [HackMD save] row ${row.rowIndex} | existing URL: "${liveHackmdPostUrl}" | new URL: "${result.postUrl}"`);
  const newUrl = appendValue(liveHackmdPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(liveLastPostedHackmd, today)
    : liveLastPostedHackmd;
  console.log(`   [HackMD save] → writing URL: "${newUrl}" | date: "${newLastPosted}"`);

  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['HackMD Post URL', 'Hackmd Post URL', 'hackmd post url'], value: newUrl },
    { names: ['HackMD Status',   'Hackmd Status',   'hackmd status'],   value: result.status },
    { names: ['HackMD Error',    'Hackmd Error',    'hackmd error'],    value: result.error ?? '' },
    { names: ['hackmdBatch', 'hackmd batch', 'HackMD Batch'],           value: result.batch ?? '' },
    { names: ['lastPostedHackmd', 'lastPostedHackMD', 'lastpostedhackmd'], value: newLastPosted },
  ], sheetConfig.name);

  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Patreon Blog Posting ─────────────────────────────────────────────────────

export async function getRowsForContinuousPatreonPosting(limit: number = 15): Promise<SheetRow[]> {
  const sheets = await getSheetsClient();
  const colMap = await getColumnMap(sheets, BLOG_SHEET_ID, BLOG_SHEET_NAME);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: BLOG_SHEET_ID, range: `${BLOG_SHEET_NAME}!A:ZZ`,
  }), 'getRowsForContinuousPatreonPosting');
  const rows: string[][] = res.data.values ?? [];
  return pickNextSequentialBlogRows(rows, colMap, ['Patreon Post URL', 'patreon post url', 'patreonPostUrl'], limit, 'Patreon');
}

export async function saveUnifiedPatreonResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.patreonPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedPatreon, today)
    : (row.lastPostedPatreon ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Patreon Post URL', 'patreon post url'], value: newUrl },
    { names: ['Patreon Status', 'patreon status'], value: result.status },
    { names: ['Patreon Error', 'patreon error'], value: result.error ?? '' },
    { names: ['patreonBatch', 'patreon batch', 'Patreon Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Patreon', 'lastPostedPatreon', 'lastpostedpatreon'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Notion Blog Posting ─────────────────────────────────────────────────────

export async function getRowsForContinuousNotionPosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(2, limit);
}

export async function saveUnifiedNotionResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.notionPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedNotion, today)
    : (row.lastPostedNotion ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Notion Post URL', 'notion post url'], value: newUrl },
    { names: ['Notion Status', 'notion status'], value: result.status },
    { names: ['Notion Error', 'notion error'], value: result.error ?? '' },
    { names: ['notionBatch', 'notion batch', 'Notion Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Notion', 'lastPostedNotion', 'lastpostednotion'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Note Blog Posting ────────────────────────────────────────────────────────

export async function getRowsForContinuousNotePosting(limit: number = 15): Promise<SheetRow[]> {
  return pickRowsByEmptyStatus(['Note Status', 'note status', 'NoteStatus'], 'Note', limit, 'newLogic');
}

export async function saveUnifiedNoteResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.notePostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedNote, today)
    : (row.lastPostedNote ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Note Post URL', 'note post url'], value: newUrl },
    { names: ['Note Status', 'note status'], value: result.status },
    { names: ['Note Error', 'note error'], value: result.error ?? '' },
    { names: ['noteBatch', 'note batch', 'Note Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Note', 'lastPostedNote', 'lastpostednote'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── vc.ru Blog Posting ───────────────────────────────────────────────────────

export async function getRowsForContinuousVcruPosting(limit: number = 15): Promise<SheetRow[]> {
  return pickRowsByEmptyStatus(['Vcru Status', 'vcru status', 'VcruStatus'], 'Vcru', limit, 'newLogic');
}

export async function saveUnifiedVcruResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.vcruPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedVcru, today)
    : (row.lastPostedVcru ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Vcru Post URL', 'vcru post url'], value: newUrl },
    { names: ['Vcru Status', 'vcru status'], value: result.status },
    { names: ['Vcru Error', 'vcru error'], value: result.error ?? '' },
    { names: ['vcruBatch', 'vcru batch', 'Vcru Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Vcru', 'lastPostedVcru', 'lastpostedvcru'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Naver Blog Posting ───────────────────────────────────────────────────────

export async function getRowsForContinuousNaverPosting(limit: number = 15): Promise<SheetRow[]> {
  return pickRowsByEmptyStatus(['Naver Status', 'naver status', 'NaverStatus'], 'Naver', limit);
}

export async function saveUnifiedNaverResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.naverPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedNaver, today)
    : (row.lastPostedNaver ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Naver Post URL', 'naver post url'], value: newUrl },
    { names: ['Naver Status', 'naver status'], value: result.status },
    { names: ['Naver Error', 'naver error'], value: result.error ?? '' },
    { names: ['naverBatch', 'naver batch', 'Naver Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Naver', 'lastPostedNaver', 'lastpostednaver'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Instapaper Posting ────────────────────────────────────────────────────────

export async function getRowsForContinuousInstapaperPosting(limit: number = 15): Promise<SheetRow[]> {
  return pickRowsByEmptyStatus(['Instapaper Status', 'instapaper status', 'InstapaperStatus'], 'Instapaper', limit, 'social');
}

export async function saveUnifiedInstapaperResult(
  row: SheetRow,
  result: { postUrl: string; note?: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'social');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.instapaperUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedInstapaper, today)
    : (row.lastPostedInstapaper ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Instapaper Post URL', 'instapaper post url'], value: newUrl },
    { names: ['Instapaper Note', 'instapaper note'], value: result.note ?? row.instapaperNote ?? '' },
    { names: ['Instapaper Status', 'instapaper status'], value: result.status },
    { names: ['Instapaper Error', 'instapaper error'], value: result.error ?? '' },
    { names: ['instapaperBatch', 'instapaper batch', 'Instapaper Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Instapaper', 'lastPostedInstapaper', 'lastpostedinstapaper'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Raindrop Posting ──────────────────────────────────────────────────────────

export async function getRowsForContinuousRaindropPosting(limit: number = 15): Promise<SheetRow[]> {
  return pickRowsByEmptyStatus(['Raindrop Status', 'raindrop status', 'RaindropStatus'], 'Raindrop', limit, 'social');
}

export async function saveUnifiedRaindropResult(
  row: SheetRow,
  result: { postUrl: string; note?: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'social');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.raindropUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedRaindrop, today)
    : (row.lastPostedRaindrop ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Raindrop Post URL', 'raindrop post url'], value: newUrl },
    { names: ['Raindrop Note', 'raindrop note'], value: result.note ?? row.raindropNote ?? '' },
    { names: ['Raindrop Status', 'raindrop status'], value: result.status },
    { names: ['Raindrop Error', 'raindrop error'], value: result.error ?? '' },
    { names: ['raindropBatch', 'raindrop batch', 'Raindrop Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Raindrop', 'lastPostedRaindrop', 'lastpostedraindrop'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Pearltrees Posting ────────────────────────────────────────────────────────

export async function getRowsForContinuousPearltreesPosting(limit: number = 15): Promise<SheetRow[]> {
  return pickRowsByEmptyStatus(['Pearltrees Status', 'pearltrees status', 'PearltreesStatus'], 'Pearltrees', limit, 'social');
}

export async function saveUnifiedPearltreesResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'social');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.pearltreesUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedPearltrees, today)
    : (row.lastPostedPearltrees ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Pearltrees Post URL', 'pearltrees post url'], value: newUrl },
    { names: ['Pearltrees Status', 'pearltrees status'], value: result.status },
    { names: ['Pearltrees Error', 'pearltrees error'], value: result.error ?? '' },
    { names: ['pearltreesBatch', 'pearltrees batch', 'Pearltrees Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Pearltrees', 'lastPostedPearltrees', 'lastpostedpearltrees'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── PdfHost Posting ───────────────────────────────────────────────────────────

// PdfHost shares slot 2 of the New Logic 3-slot system with Calisthenics,
// Notion, LinkedIn Pulse, and Google Sites — same row pool, same
// "Blog Platform 2"/"Blog URL 2" shared columns, written via
// saveSlotResult() (not its own dedicated PdfHost Status/Post URL columns).
export async function getRowsForContinuousPdfhostPosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(2, limit);
}

export async function saveUnifiedPdfhostResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'newLogic');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.pdfhostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedPdfhost, today)
    : (row.lastPostedPdfhost ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['PdfHost Post URL', 'pdfhost post url'], value: newUrl },
    { names: ['PdfHost Status', 'pdfhost status'], value: result.status },
    { names: ['PdfHost Error', 'pdfhost error'], value: result.error ?? '' },
    { names: ['pdfhostBatch', 'pdfhost batch', 'PdfHost Batch'], value: result.batch ?? '' },
    { names: ['Last Posted PdfHost', 'lastPostedPdfhost', 'lastpostedpdfhost'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Scribd Posting ────────────────────────────────────────────────────────────

// Scribd shares slot 1 of the New Logic 3-slot system with Linkmate,
// Blogger, Coda, Medium, and Velog — same row pool, same "Blog Platform 1"/
// "Blog URL 1" shared columns, written via saveSlotResult() (not its own
// dedicated Scribd Status/Post URL columns).
export async function getRowsForContinuousScribdPosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(1, limit);
}

export async function saveUnifiedScribdResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'newLogic');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.scribdUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedScribd, today)
    : (row.lastPostedScribd ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Scribd Post URL', 'scribd post url'], value: newUrl },
    { names: ['Scribd Status', 'scribd status'], value: result.status },
    { names: ['Scribd Error', 'scribd error'], value: result.error ?? '' },
    { names: ['scribdBatch', 'scribd batch', 'Scribd Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Scribd', 'lastPostedScribd', 'lastpostedscribd'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── 4shared Posting ───────────────────────────────────────────────────────────

// 4shared shares slot 3 of the New Logic 3-slot system with HackMD,
// WordPress, and Dev.to — same row pool, same "Blog Platform 3"/"Blog
// URL 3" shared columns, written via saveSlotResult() (not its own
// dedicated 4shared Status/Post URL columns).
export async function getRowsForContinuousFourSharedPosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(3, limit);
}

export async function saveUnifiedFourSharedResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'newLogic');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.fourSharedUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedFourShared, today)
    : (row.lastPostedFourShared ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['4shared Post URL', '4shared post url'], value: newUrl },
    { names: ['4shared Status', '4shared status'], value: result.status },
    { names: ['4shared Error', '4shared error'], value: result.error ?? '' },
    { names: ['fourSharedBatch', '4shared batch', '4shared Batch'], value: result.batch ?? '' },
    { names: ['Last Posted 4shared', 'lastPostedFourShared', 'lastposted4shared'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Tistory Posting ───────────────────────────────────────────────────────────
// Tistory shares slot 2 of the New Logic 3-slot system with Google Sites,
// Calisthenics, Notion, LinkedIn Pulse and PdfHost — same row pool, same "Blog Platform 2"/"Blog
// URL 2" shared columns, written via saveSlotResult() (not its own
// dedicated Tistory Status/Post URL columns).
export async function getRowsForContinuousTistoryPosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(2, limit);
}

// ──── Mastodon Posting ──────────────────────────────────────────────────────────

export async function getRowsForContinuousMastodonPosting(limit: number = 15): Promise<SheetRow[]> {
  return pickRowsByEmptyStatus(['Mastodon Status', 'mastodon status', 'MastodonStatus'], 'Mastodon', limit, 'social');
}

export async function saveUnifiedMastodonResult(
  row: SheetRow,
  result: { postUrl: string; post?: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'social');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.mastodonPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedMastodon, today)
    : (row.lastPostedMastodon ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Mastodon Post', 'mastodon post'], value: result.post ?? row.mastodonPost ?? '' },
    { names: ['Mastodon Post URL', 'mastodon post url'], value: newUrl },
    { names: ['Mastodon Status', 'mastodon status'], value: result.status },
    { names: ['Mastodon Error', 'mastodon error'], value: result.error ?? '' },
    { names: ['mastodonBatch', 'mastodon batch', 'Mastodon Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Mastodon', 'lastPostedMastodon', 'lastpostedmastodon'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Velog Posting ────────────────────────────────────────────────────────────
// Velog shares slot 1 of the New Logic 3-slot system with Linkmate, Blogger,
// Coda, Medium, and Scribd — same row pool, same "Blog Platform 1"/"Blog
// URL 1" shared columns, written via saveSlotResult() (not its own dedicated
// Velog Status/Post URL columns).

export async function getRowsForContinuousVelogPosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(1, limit);
}

// ──── Coda Posting ─────────────────────────────────────────────────────────────

export async function getRowsForContinuousCodaPosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(1, limit);
}

export async function saveUnifiedCodaResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.codaPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedCoda, today)
    : (row.lastPostedCoda ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Coda Post URL', 'coda post url'], value: newUrl },
    { names: ['Coda Status', 'coda status'], value: result.status },
    { names: ['Coda Error', 'coda error'], value: result.error ?? '' },
    { names: ['codaBatch', 'coda batch', 'Coda Batch'], value: result.batch ?? '' },
    { names: ['Last Posted Coda', 'lastPostedCoda', 'lastpostedcoda'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ── Ameba ─────────────────────────────────────────────────────────────────────

export async function getRowsForContinuousAmebaPosting(limit: number = 15): Promise<SheetRow[]> {
  return pickRowsByEmptyStatus(['Ameba Status', 'ameba status', 'AmebaStatus'], 'Ameba', limit);
}

export async function saveUnifiedAmebaResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue((row as any).amebaPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue((row as any).lastPostedAmeba, today)
    : ((row as any).lastPostedAmeba ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Ameba Post URL', 'ameba post url'], value: newUrl },
    { names: ['Ameba Status', 'ameba status'], value: result.status },
    { names: ['Ameba Error', 'ameba error'], value: result.error ?? '' },
    { names: ['Ameba Batch', 'ameba batch'], value: result.batch ?? '' },
    { names: ['Last Posted Ameba', 'lastPostedAmeba', 'lastpostedameba'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ── Paragraph ─────────────────────────────────────────────────────────────────

export async function getRowsForContinuousParagraphPosting(limit: number = 15): Promise<SheetRow[]> {
  return pickRowsByEmptyStatus(['Paragraph Status', 'paragraph status'], 'Paragraph', limit);
}

export async function saveUnifiedParagraphResult(
  row: SheetRow,
  result: { postUrl: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'blog');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const newUrl = appendValue(row.paragraphPostUrl, result.postUrl);
  const newLastPosted = result.status?.toLowerCase() === 'posted'
    ? appendValue(row.lastPostedParagraph, today)
    : (row.lastPostedParagraph ?? '');
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Paragraph Post URL', 'paragraph post url'], value: newUrl },
    { names: ['Paragraph Status', 'paragraph status'],    value: result.status },
    { names: ['Paragraph Error', 'paragraph error'],      value: result.error ?? '' },
    { names: ['Paragraph Batch', 'paragraph batch', 'paragraphBatch'], value: result.batch ?? '' },
    { names: ['Last Posted Paragraph', 'lastPostedParagraph', 'lastpostedparagraph'], value: newLastPosted },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ── Mataroa ───────────────────────────────────────────────────────────────────
// Pure REST API (no browser) — see browser/mataroa/apiPoster.ts.
// Shares New Logic Slot 1 ("Blog Platform 1"/"Blog URL 1") with Linkmate,
// Blogger, Coda, Medium and Velog — see getRowsNeedingSlot / saveSlotResult.

export async function getRowsForContinuousMataroaPosting(limit: number = 15): Promise<SheetRow[]> {
  return getRowsNeedingSlot(1, limit);
}

// ──── New Logic: slot result writer ────────────────────────────────────────
// Each of the 9 platforms is permanently assigned to exactly one slot (1/2/3).
// A row's slot columns (Blog Platform N / Blog URL N) are only ever written
// by platforms assigned to that slot, and each platform only ever posts to a
// row where its slot is still empty (see getRowsNeedingSlot above) — so there
// is no concurrent-write race on a given cell the way a shared "first open
// slot" claim system would have.
//
// Blog Status / Blog Batch / Blog Error / Last Posted Blog are SHARED across
// all 3 slots on one row, encoded as "P1:value|P2:value|P3:value" — writing
// a slot's result means reading the current string, replacing only that
// slot's segment, and writing the whole string back.

/** Replace (or insert) the P{slot}:value segment of a "P1:..|P2:..|P3:.." encoded string. */
function setSlotSegment(existing: string, slot: 1 | 2 | 3, value: string): string {
  const segments: Record<number, string> = { 1: '', 2: '', 3: '' };
  for (const part of (existing ?? '').split('|')) {
    const m = part.match(/^P([123]):(.*)$/s);
    if (m) segments[Number(m[1])] = m[2];
  }
  segments[slot] = value;
  return [1, 2, 3].map(n => `P${n}:${segments[n]}`).join('|');
}

/** Write one platform's post result into its assigned slot on a New Logic row. Only writes Blog Platform/URL on success — a failed slot stays blank so the row can be retried. */
export async function saveSlotResult(
  rowIndex: number,
  slot: 1 | 2 | 3,
  platformDisplayName: string,
  result: { url: string; status: string; error?: string; batch?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig('newLogic');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);

  const statusIdx = col(colMap, 'Blog Status');
  const batchIdx = col(colMap, 'Blog Batch');
  const errorIdx = col(colMap, 'Blog Error');

  let liveStatus = '', liveBatch = '', liveError = '';
  try {
    const liveRes = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetConfig.id,
      range: `${sheetConfig.name}!${rowIndex}:${rowIndex}`,
    });
    const liveRow: string[] = liveRes.data.values?.[0] ?? [];
    if (statusIdx !== undefined) liveStatus = (liveRow[statusIdx] ?? '').trim();
    if (batchIdx !== undefined) liveBatch = (liveRow[batchIdx] ?? '').trim();
    if (errorIdx !== undefined) liveError = (liveRow[errorIdx] ?? '').trim();
  } catch { /* non-critical — fall back to building fresh from empty */ }

  const isPosted = result.status?.toLowerCase() === 'posted';
  const today = new Date().toISOString().split('T')[0];

  const fields: { names: string[]; value: string }[] = [
    { names: ['Blog Status'], value: setSlotSegment(liveStatus, slot, result.status ?? '') },
    { names: ['Blog Batch'], value: setSlotSegment(liveBatch, slot, result.batch ?? '') },
    { names: ['Blog Error'], value: setSlotSegment(liveError, slot, result.error ?? '') },
  ];
  if (isPosted) {
    fields.push({ names: ['Blog Platform ' + slot], value: platformDisplayName });
    fields.push({ names: ['Blog URL ' + slot], value: result.url });
    // One column per slot (not the old shared "Last Posted Blog" encoded
    // P1:..|P2:..|P3:.. string) — add "Last Posted Blog Platform 1/2/3" as
    // real columns on the New Logic tab; buildUpdates skips silently (with a
    // warning) until they exist.
    fields.push({ names: [`Last Posted Blog Platform ${slot}`, `lastPostedBlogPlatform${slot}`], value: today });
  }

  const data = buildUpdates(colMap, rowIndex, fields, sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Newsletter (Outlook) ──────────────────────────────────────────────────
// Independent status column, like Note/Naver/Velog — not part of the 9-platform
// shared blog slot system, since it's a separate channel (email, not a blog post).

export async function getRowsForContinuousNewsletterPosting(limit: number = 15): Promise<SheetRow[]> {
  return pickRowsByEmptyStatus(['Newsletter Status', 'newsletter status', 'NewsletterStatus'], 'Newsletter', limit, 'newLogic');
}

export async function ensureNewsletterColumns(): Promise<void> {
  return ensureSheetColumns('newLogic', [
    'Newsletter Status', 'Newsletter Error', 'Newsletter Batch', 'Newsletter Recipients Sent', 'Last Posted Newsletter',
  ]);
}

export async function saveUnifiedNewsletterResult(
  row: SheetRow,
  result: { status: string; error?: string; batch?: string; recipientsSent?: number }
): Promise<void> {
  const sheets = await getSheetsClient();
  const sheetConfig = getSheetConfig(row.sheetType ?? 'newLogic');
  const colMap = await getColumnMap(sheets, sheetConfig.id, sheetConfig.name);
  const today = new Date().toISOString().split('T')[0];
  const data = buildUpdates(colMap, row.rowIndex, [
    { names: ['Newsletter Status', 'newsletter status'], value: result.status },
    { names: ['Newsletter Error', 'newsletter error'], value: result.error ?? '' },
    { names: ['Newsletter Batch', 'newsletter batch'], value: result.batch ?? '' },
    { names: ['Newsletter Recipients Sent', 'newsletter recipients sent'], value: String(result.recipientsSent ?? 0) },
    { names: ['Last Posted Newsletter', 'lastPostedNewsletter', 'lastpostednewsletter'], value: result.status?.toLowerCase() === 'posted' ? today : '' },
  ], sheetConfig.name);
  await batchWrite(sheets, data, sheetConfig.id);
}

// ──── Newsletter Campaign tab ("Newsletter") ────────────────────────────────
// Manual-input pipeline: you drop 3-4 report URLs + a list of prospect
// emails into a row; ChatGPT generates the newsletter content from those
// URLs; the generated content is stored back on the row; then it's sent to
// exactly the emails listed on that row. Independent of the New Logic-reuse
// newsletter path above — this tab is its own campaign queue, not tied to
// the 9-platform blog pipeline.

const NEWSLETTER_CAMPAIGN_HEADERS = [
  'Report URL 1', 'Report URL 2', 'Report URL 3', 'Report URL 4',
  'Prospect Emails', 'Generated Subject', 'Generated Content',
  'Status', 'Error', 'Batch', 'Recipients Sent', 'Sent At',
  // Added 2026-10-05 for the master-prompt, lead-matched pipeline. Only "Report URL 1"
  // is used now (one report per campaign row); "Prospect Emails" is no longer read —
  // recipients come from the "Sample Report Leads" tab, matched by Industry.
  'Target Industries', 'Sample Report Link', 'Sender Name', 'Sender Designation',
  'Approved', 'Recipient Limit', 'Generated Analysis', 'Sent Count',
  // Added 2026-10-11 for the industry-grouped flow (planBatch.ts): one campaign row per industry,
  // sent ONLY to the leads chosen when the plan was made ("Planned Lead Rows" = row numbers in the
  // "Sample Report Leads" tab, so this tab holds no personal data).
  'Industry', 'Plan Batch', 'Planned Lead Rows', 'Lead Count',
];

export interface NewsletterCampaignRow {
  rowIndex: number; // 1-based sheet row
  reportUrls: string[];
  prospectEmailsRaw: string;
  generatedSubject: string;
  generatedContent: string;
  status: string;
  targetIndustries: string[];
  sampleReportLink: string;
  senderName: string;
  senderDesignation: string;
  approved: boolean;
  recipientLimit: number; // 0 = use the run default
  sentCount: number;
  industry: string;          // single industry this row's email is for (industry-grouped flow); '' for legacy rows
  planBatch: string;
  plannedLeadRows: number[]; // row numbers in "Sample Report Leads"; empty = legacy behaviour (match by Target Industries)
}

function colLetter(idx0: number): string {
  let n = idx0 + 1, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Creates the "Newsletter" tab if missing, and appends any header columns the pipeline needs that the tab doesn't have yet. Safe to call repeatedly. */
async function ensureNewsletterCampaignSheet(sheets: any): Promise<void> {
  const cfg = getSheetConfig('newsletterCampaign');
  const meta = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId: cfg.id,
    fields: 'sheets(properties(sheetId,title))',
  }), 'ensureNewsletterCampaignSheet:meta');

  const exists = meta.data.sheets?.some((s: any) => s.properties?.title === cfg.name);
  if (exists) {
    const hr = await withRetry(() => sheets.spreadsheets.values.get({
      spreadsheetId: cfg.id, range: `${cfg.name}!1:1`,
    }), 'ensureNewsletterCampaignSheet:headerRead');
    const have: string[] = (hr.data.values?.[0] ?? []).map((h: any) => String(h).trim().toLowerCase());
    const missing = NEWSLETTER_CAMPAIGN_HEADERS.filter(h => !have.includes(h.toLowerCase()));
    if (missing.length > 0) {
      console.log(`   📐 Adding ${missing.length} column(s) to "${cfg.name}": ${missing.join(', ')}`);
      await withRetry(() => sheets.spreadsheets.values.update({
        spreadsheetId: cfg.id,
        range: `${cfg.name}!${colLetter(have.length)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [missing] },
      }), 'ensureNewsletterCampaignSheet:addColumns');
    }
    return;
  }

  console.log(`   📐 Creating "${cfg.name}" tab...`);
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: cfg.id,
    requestBody: { requests: [{ addSheet: { properties: { title: cfg.name } } }] },
  }), 'ensureNewsletterCampaignSheet:addSheet');

  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: cfg.id,
    range: `${cfg.name}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [NEWSLETTER_CAMPAIGN_HEADERS] },
  }), 'ensureNewsletterCampaignSheet:headers');
  console.log(`   ✅ "${cfg.name}" tab created with header row.`);
}

/** One-time setup: creates/extends the "Newsletter" tab now, without needing a row to trigger it. Safe to call repeatedly. */
export async function createNewsletterCampaignTabIfMissing(): Promise<void> {
  const sheets = await getSheetsClient();
  await ensureNewsletterCampaignSheet(sheets);
}

async function readNewsletterCampaignRows(): Promise<NewsletterCampaignRow[]> {
  const sheets = await getSheetsClient();
  const cfg = getSheetConfig('newsletterCampaign');
  await ensureNewsletterCampaignSheet(sheets);
  const colMap = await getColumnMap(sheets, cfg.id, cfg.name);

  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: cfg.id, range: `${cfg.name}!A:Z`,
  }), 'readNewsletterCampaignRows');
  const rows: string[][] = res.data.values ?? [];

  const g = (r: string[], ...names: string[]): string => {
    const idx = col(colMap, ...names);
    return idx !== undefined ? String(r[idx] ?? '').trim() : '';
  };

  const out: NewsletterCampaignRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => !String(c ?? '').trim())) continue;
    out.push({
      rowIndex: i + 1,
      reportUrls: [g(r, 'Report URL 1', 'report url 1'), g(r, 'Report URL 2', 'report url 2'), g(r, 'Report URL 3', 'report url 3'), g(r, 'Report URL 4', 'report url 4')].filter(Boolean),
      prospectEmailsRaw: g(r, 'Prospect Emails', 'prospect emails'),
      generatedSubject: g(r, 'Generated Subject', 'generated subject'),
      generatedContent: g(r, 'Generated Content', 'generated content'),
      status: g(r, 'Status', 'status'),
      targetIndustries: g(r, 'Target Industries', 'target industries').split(/\s*\|\s*|\n/).map(s => s.trim()).filter(Boolean),
      sampleReportLink: g(r, 'Sample Report Link', 'sample report link'),
      senderName: g(r, 'Sender Name', 'sender name'),
      senderDesignation: g(r, 'Sender Designation', 'sender designation'),
      approved: /^(yes|y|true|approved|1)$/i.test(g(r, 'Approved', 'approved')),
      recipientLimit: parseInt(g(r, 'Recipient Limit', 'recipient limit'), 10) || 0,
      sentCount: parseInt(g(r, 'Sent Count', 'sent count'), 10) || 0,
      industry: g(r, 'Industry', 'industry'),
      planBatch: g(r, 'Plan Batch', 'plan batch'),
      plannedLeadRows: (g(r, 'Planned Lead Rows', 'planned lead rows').match(/\d+/g) ?? []).map(Number),
    });
  }
  return out;
}

/** Rows with Report URL 1 filled in but no Generated Content yet — ready for ChatGPT generation. */
export async function getNewsletterCampaignRowsNeedingGeneration(limit: number = 5): Promise<NewsletterCampaignRow[]> {
  const all = await readNewsletterCampaignRows();
  return all.filter(r => r.reportUrls.length > 0 && !r.generatedContent).slice(0, limit);
}

export async function saveNewsletterCampaignGeneratedContent(
  rowIndex: number,
  result: { subject: string; content: string; targetIndustries?: string[]; analysis?: string; sampleReportLink?: string }
): Promise<void> {
  const sheets = await getSheetsClient();
  const cfg = getSheetConfig('newsletterCampaign');
  const colMap = await getColumnMap(sheets, cfg.id, cfg.name);
  const fields: { names: string[]; value: string }[] = [
    { names: ['Generated Subject', 'generated subject'], value: result.subject },
    { names: ['Generated Content', 'generated content'], value: result.content },
  ];
  if (result.targetIndustries) fields.push({ names: ['Target Industries', 'target industries'], value: result.targetIndustries.join(' | ') });
  if (result.analysis !== undefined) fields.push({ names: ['Generated Analysis', 'generated analysis'], value: result.analysis.slice(0, 45000) });
  if (result.sampleReportLink) fields.push({ names: ['Sample Report Link', 'sample report link'], value: result.sampleReportLink });
  const data = buildUpdates(colMap, rowIndex, fields, cfg.name);
  await batchWrite(sheets, data, cfg.id);
}

/** Rows that are generated, marked Approved, and not finished (Status blank or "partial") — ready to send. */
export async function getNewsletterCampaignRowsReadyToSend(limit: number = 5): Promise<NewsletterCampaignRow[]> {
  const all = await readNewsletterCampaignRows();
  return all
    .filter(r => r.generatedContent && r.approved && (!r.status || r.status.toLowerCase() === 'partial'))
    .slice(0, limit);
}

export async function saveNewsletterCampaignSendResult(
  rowIndex: number,
  result: { status: string; error?: string; batch?: string; recipientsSent?: number }
): Promise<void> {
  const sheets = await getSheetsClient();
  const cfg = getSheetConfig('newsletterCampaign');
  const colMap = await getColumnMap(sheets, cfg.id, cfg.name);
  const now = new Date().toISOString();
  const data = buildUpdates(colMap, rowIndex, [
    { names: ['Status', 'status'], value: result.status },
    { names: ['Error', 'error'], value: result.error ?? '' },
    { names: ['Batch', 'batch'], value: result.batch ?? '' },
    { names: ['Recipients Sent', 'recipients sent'], value: String(result.recipientsSent ?? 0) },
    { names: ['Sent Count', 'sent count'], value: String(result.recipientsSent ?? 0) },
    { names: ['Sent At', 'sent at'], value: result.recipientsSent ? now : '' },
  ], cfg.name);
  await batchWrite(sheets, data, cfg.id);
}

// ── Sample Report Leads (recipient source) + per-send log ───────────────────

const SAMPLE_REPORT_LEADS_TAB = 'Sample Report Leads';
const NEWSLETTER_SENDS_TAB = 'Newsletter Sends';
const NEWSLETTER_SENDS_HEADERS = ['Campaign Row', 'Email', 'Name', 'Industry', 'Status', 'Error', 'Sent At'];

export interface SampleReportLead {
  rowIndex: number; // 1-based sheet row
  name: string;
  email: string;
  designation: string;
  industry: string;
}

/** Reads every lead (Name, Email, Designation, Industry) from the "Sample Report Leads" tab. */
export async function getSampleReportLeads(): Promise<SampleReportLead[]> {
  const sheets = await getSheetsClient();
  const cfg = getSheetConfig('newsletterCampaign');
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: cfg.id, range: `'${SAMPLE_REPORT_LEADS_TAB}'!A2:D`,
  }), 'getSampleReportLeads');
  const rows: string[][] = res.data.values ?? [];
  return rows.map((r, i) => ({
    rowIndex: i + 2,
    name: String(r[0] ?? '').trim(),
    email: String(r[1] ?? '').trim(),
    designation: String(r[2] ?? '').trim(),
    industry: String(r[3] ?? '').trim(),
  }));
}

async function ensureNewsletterSendsTab(sheets: any): Promise<void> {
  const cfg = getSheetConfig('newsletterCampaign');
  const meta = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId: cfg.id, fields: 'sheets(properties(title))',
  }), 'ensureNewsletterSendsTab:meta');
  if (meta.data.sheets?.some((s: any) => s.properties?.title === NEWSLETTER_SENDS_TAB)) return;
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: cfg.id,
    requestBody: { requests: [{ addSheet: { properties: { title: NEWSLETTER_SENDS_TAB } } }] },
  }), 'ensureNewsletterSendsTab:add');
  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: cfg.id, range: `'${NEWSLETTER_SENDS_TAB}'!A1`, valueInputOption: 'RAW',
    requestBody: { values: [NEWSLETTER_SENDS_HEADERS] },
  }), 'ensureNewsletterSendsTab:headers');
}

/** Emails already logged (sent OR failed) for this campaign row — never contacted twice. */
export async function getNewsletterLoggedEmails(campaignRow: number): Promise<Set<string>> {
  const sheets = await getSheetsClient();
  const cfg = getSheetConfig('newsletterCampaign');
  await ensureNewsletterSendsTab(sheets);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: cfg.id, range: `'${NEWSLETTER_SENDS_TAB}'!A2:B`,
  }), 'getNewsletterLoggedEmails');
  const out = new Set<string>();
  for (const r of (res.data.values ?? []) as string[][]) {
    if (String(r[0] ?? '').trim() === String(campaignRow)) out.add(String(r[1] ?? '').trim().toLowerCase());
  }
  return out;
}

/** Every email ever logged (sent OR failed) under ANY campaign row — used to pick leads that were never contacted at all. */
export async function getAllNewsletterLoggedEmails(): Promise<Set<string>> {
  const sheets = await getSheetsClient();
  const cfg = getSheetConfig('newsletterCampaign');
  await ensureNewsletterSendsTab(sheets);
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: cfg.id, range: `'${NEWSLETTER_SENDS_TAB}'!B2:B`,
  }), 'getAllNewsletterLoggedEmails');
  const out = new Set<string>();
  for (const r of (res.data.values ?? []) as string[][]) {
    const e = String(r[0] ?? '').trim().toLowerCase();
    if (e) out.add(e);
  }
  return out;
}

/** Appends one send result to the "Newsletter Sends" log tab (called right after each send, so a crash can't cause a double-send). */
export async function appendNewsletterSendLog(
  campaignRow: number,
  lead: { email: string; name: string; industry: string },
  result: { status: 'sent' | 'failed'; error?: string },
): Promise<void> {
  const sheets = await getSheetsClient();
  const cfg = getSheetConfig('newsletterCampaign');
  await ensureNewsletterSendsTab(sheets);
  await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: cfg.id, range: `'${NEWSLETTER_SENDS_TAB}'!A:G`,
    valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[String(campaignRow), lead.email, lead.name, lead.industry, result.status, (result.error ?? '').slice(0, 300), new Date().toISOString()]] },
  }), 'appendNewsletterSendLog');
}
