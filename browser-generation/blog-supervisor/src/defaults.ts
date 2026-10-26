/**
 * Real wiring for the blog supervisor: the same ChatGPT browser windows, image agents and Sheet writers that
 * blogGenLoop.ts uses. Kept out of orchestrator.ts so the orchestrator can be tested with fakes.
 */
import { loadConfig } from '../../../src/config/index.js';
import { openBlogChatSession } from '../../src/agents/blogGenAgent.js';
import { generateBlogCoverImageWithText } from '../../src/agents/blogImageAgent.js';
import { generateAndUploadSnapshotImage, type SnapshotMetric } from '../../src/agents/blogSnapshotImageAgent.js';
import { generateAndUploadLandscapeImage } from '../../src/agents/blogLandscapeImageAgent.js';
import { normalizeImgTags } from '../../src/agents/blogSanityAgent.js';
import { applyPreferredSourceCTA, validatePreferredSourceCTA } from '../../src/agents/blogPreferredSourceAgent.js';
import {
  injectCoverImage, injectSnapshotImage, injectSnapshotImage2, stripUnresolvedImagePlaceholders, verifyWrite, PREFERRED_SOURCE_MODE,
} from '../../src/coordinator/blogGenLoop.js';
import { saveCoverImageUrlToPool, saveGeneratedBlogToPool, saveNewLogicImageText } from '../../src/sheets/sheets.js';
import { gatherBlogEvidence } from './evidence.js';
import type { BlogLedger } from './state.js';
import type { BlogRowDeps, FinishArticleParams } from './orchestrator.js';

export interface RealDepsOptions {
  withImage: boolean;
  structureMode: string;
  blogAccount?: string;
  imageAccount?: string;
  imagePromptChoice?: '1' | '2';
  ledger: BlogLedger;
}

export function createRealDeps(opts: RealDepsOptions): Pick<BlogRowDeps, 'evidence' | 'openChat' | 'cover' | 'finishArticle' | 'save' | 'verify' | 'structureMode'> {
  const config = loadConfig();
  const log = (summary: string) => opts.ledger.append('assemble', { summary }).catch(() => {});

  const finishArticle = async ({ blog, title, coverImageUrl }: FinishArticleParams): Promise<string> => {
    let html = blog.html;
    // Same order as blogGenLoop.ts: snapshot and landscape placeholders first, cover image last (it prepends).
    let snapshotMetrics: SnapshotMetric[] = [];
    if (blog.imageData) {
      try {
        const snap = await generateAndUploadSnapshotImage({ marketName: blog.seoTitle || title, imageData: blog.imageData });
        html = injectSnapshotImage(html, snap.url);
        snapshotMetrics = snap.metrics;
        await log(`snapshot image inserted (${snap.metrics.length} metrics)`);
      } catch (e) {
        await log(`snapshot image failed, continuing without it: ${(e as Error).message}`);
      }
    }
    if (blog.imageData2 || snapshotMetrics.length) {
      try {
        const land = await generateAndUploadLandscapeImage({ marketName: blog.seoTitle || title, heroSourceMetrics: snapshotMetrics, imageData2: blog.imageData2 });
        html = injectSnapshotImage2(html, land.url);
        await log('landscape image inserted');
      } catch (e) {
        await log(`landscape image failed, continuing without it: ${(e as Error).message}`);
      }
    }
    if (coverImageUrl) html = injectCoverImage(html, coverImageUrl);
    html = normalizeImgTags(html, { title: blog.title || title }).html;
    const stripped = stripUnresolvedImagePlaceholders(html);
    if (stripped.removed > 0) await log(`removed ${stripped.removed} unresolved image placeholder(s)`);
    html = stripped.html;
    const preferred = applyPreferredSourceCTA(html, { mode: PREFERRED_SOURCE_MODE, title: blog.title || title });
    const check = validatePreferredSourceCTA(preferred.html, PREFERRED_SOURCE_MODE);
    await log(`preferred-source CTA ${preferred.applied ? `inserted (${preferred.placement})` : `skipped (${preferred.placement})`}${check.status === 'PASS' ? '' : `; validation: ${check.issues.join(' | ')}`}`);
    return preferred.html;
  };

  return {
    structureMode: opts.structureMode,
    evidence: (input) => gatherBlogEvidence(input, { config }),
    openChat: (p) => openBlogChatSession({ title: p.title, url: p.url, structure: p.structure, ...(p.promptSuffix ? { promptSuffix: p.promptSuffix } : {}), ...(opts.blogAccount ? { accountHandle: opts.blogAccount } : {}) }),
    ...(opts.withImage
      ? {
          cover: async ({ title, url, row }) => {
            const { url: imageUrl, imageText } = await generateBlogCoverImageWithText({
              marketName: title, reportUrl: url, promptChoice: opts.imagePromptChoice ?? '1', ...(opts.imageAccount ? { accountHandle: opts.imageAccount } : {}),
            });
            if (imageUrl) await saveCoverImageUrlToPool(row, imageUrl, 'newLogic').catch(() => {});
            if (imageText) await saveNewLogicImageText(row, imageText);
            return { url: imageUrl };
          },
        }
      : {}),
    finishArticle,
    save: (row, data) =>
      saveGeneratedBlogToPool(row, {
        coverImageUrl: data.coverImageUrl, html: data.html, seoTitle: data.blog.seoTitle, metaDescription: data.blog.description,
        imageData: data.blog.imageData, imageData2: data.blog.imageData2,
      }, 'newLogic'),
    verify: (rowIndex) => verifyWrite(rowIndex, opts.withImage),
  };
}
