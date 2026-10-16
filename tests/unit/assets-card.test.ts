import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CARD_SIZES,
  CardInputError,
  FontNotFoundError,
  RENDER_VERSION,
  findFontPath,
  fontAvailable,
  formatFactValue,
  formatNumber,
  getAssetRecord,
  isAllowedFactSource,
  readFontFamily,
  renderStatCard,
  resolveFont,
  saveAsset,
  validateCardInput,
} from '../../src/assets/index.js';
import { MemoryStore } from '../../src/store/store.js';
import { FAKE_COMPETITOR_URL, FAKE_GOV_URL, makeFact } from '../fixtures/assets/facts.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const now = new Date('2026-02-02T00:00:00.000Z');

describe('assets: pure helpers (no font needed)', () => {
  it('formats numbers without locale variance', () => {
    expect(formatNumber(1234567.891, 1)).toBe('1,234,567.9');
    expect(formatNumber(12, undefined)).toBe('12');
    expect(formatNumber(-0.04, 1)).toBe('0.0');
    expect(formatNumber(-3.5)).toBe('-3.5');
  });

  it('shows the unit next to the value', () => {
    expect(formatFactValue(makeFact())).toBe('12.5 USD billion');
    expect(formatFactValue(makeFact({ value: 8.2, unit: 'percent' }))).toBe('8.2%');
  });

  it('applies the source policy to fact sources', () => {
    expect(isAllowedFactSource('https://www.kenresearch.com/x')).toBe(true);
    expect(isAllowedFactSource(FAKE_GOV_URL)).toBe(true);
    expect(isAllowedFactSource(FAKE_COMPETITOR_URL)).toBe(false);
    expect(isAllowedFactSource('https://random-blog.example.com/x')).toBe(false);
    expect(isAllowedFactSource('https://kenresearch.com.evil.example/x')).toBe(false);
    expect(isAllowedFactSource('ftp://www.kenresearch.com/x')).toBe(false);
    expect(isAllowedFactSource('not a url')).toBe(false);
  });

  it('reports a clear typed error when no font exists', () => {
    expect(findFontPath({}, ['Z:/nope/one.ttf'])).toBeNull();
    expect(() => resolveFont({ CE_FONT_PATH: 'Z:/nope/missing.ttf' }, ['Z:/nope/one.ttf'])).toThrow(FontNotFoundError);
  });

  it('readFontFamily falls back safely on garbage', () => {
    expect(readFontFamily(Buffer.from('not a font'))).toBe('sans-serif');
  });
});

describe('assets: card input rules (rejected before any rendering)', () => {
  const base = { title: 'Fake Widgets', sourceLabel: 'Ken Research' };

  it('rejects unverified facts', async () => {
    for (const status of ['unverified', 'conflicting'] as const) {
      await expect(renderStatCard({ ...base, facts: [makeFact({ verificationStatus: status })] })).rejects.toBeInstanceOf(CardInputError);
    }
  });

  it('rejects competitor and unknown sources', async () => {
    await expect(renderStatCard({ ...base, facts: [makeFact({ sourceUrl: FAKE_COMPETITOR_URL })] })).rejects.toBeInstanceOf(CardInputError);
    await expect(renderStatCard({ ...base, facts: [makeFact({ sourceUrl: 'https://someblog.example.com/p' })] })).rejects.toBeInstanceOf(CardInputError);
  });

  it('rejects missing period or geography (they must be visible)', () => {
    const { issues } = validateCardInput({ ...base, facts: [makeFact({ period: undefined, geography: undefined })] });
    expect(issues.join('\n')).toMatch(/period is missing/);
    expect(issues.join('\n')).toMatch(/geography is missing/);
  });

  it('rejects empty facts, empty title, bad size and collects every issue', () => {
    const { issues } = validateCardInput({ facts: [], title: ' ', sourceLabel: '', size: { width: 10, height: 10 } });
    expect(issues.length).toBeGreaterThanOrEqual(4);
  });

  it('rejects a chart that uses facts not on the card', () => {
    const chart = { svg: '', png: Buffer.alloc(0), width: 10, height: 10, factIds: ['OTHER'] };
    const { issues } = validateCardInput({ ...base, facts: [makeFact()], chart });
    expect(issues.join('\n')).toMatch(/OTHER/);
  });

  it('error carries all issues and is a fatal EngineError', async () => {
    const err = await renderStatCard({ ...base, facts: [makeFact({ verificationStatus: 'unverified', sourceUrl: FAKE_COMPETITOR_URL })] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CardInputError);
    expect((err as CardInputError).issues.length).toBe(2);
    expect((err as CardInputError).category).toBe('fatal');
  });
});

describe.skipIf(!fontAvailable)('assets: card rendering (needs a font)', () => {
  const input = { facts: [makeFact(), makeFact({ id: 'F2', metric: 'cagr', value: 8.2, unit: 'percent', period: '2025-2030', sourceUrl: FAKE_GOV_URL })], title: 'Fake Zorbland Widgets', sourceLabel: 'Ken Research', now };

  it('renders a PNG with a record', async () => {
    const { png, record } = await renderStatCard(input);
    expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(record.width).toBe(CARD_SIZES.landscape.width);
    expect(record.height).toBe(CARD_SIZES.landscape.height);
    expect(record.factIds).toEqual(['F1', 'F2']);
    expect(record.renderVersion).toBe(RENDER_VERSION);
    expect(record.fileName).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(record.createdAt).toBe(now.toISOString());
  });

  it('is deterministic: identical input gives identical bytes and file name', async () => {
    const a = await renderStatCard(input);
    const b = await renderStatCard({ ...input, now: new Date('2030-01-01T00:00:00Z') });
    expect(a.png.equals(b.png)).toBe(true);
    expect(a.record.fileName).toBe(b.record.fileName);
  });

  it('changes bytes when content or theme changes', async () => {
    const a = await renderStatCard(input);
    const b = await renderStatCard({ ...input, theme: 'dark' });
    const c = await renderStatCard({ ...input, facts: [makeFact({ value: 99 })] });
    expect(a.record.fileName).not.toBe(b.record.fileName);
    expect(a.record.fileName).not.toBe(c.record.fileName);
  });

  it('supports the square size', async () => {
    const { record } = await renderStatCard({ ...input, size: CARD_SIZES.square });
    expect([record.width, record.height]).toEqual([1080, 1080]);
  });

  it('stores PNG and record through the Store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ce-assets-'));
    try {
      const store = new MemoryStore();
      const asset = await renderStatCard(input);
      const { pngPath, id } = await saveAsset(store, asset, dir);
      expect((await readFile(pngPath)).equals(asset.png)).toBe(true);
      expect(await getAssetRecord(store, id)).toEqual(asset.record);
      await saveAsset(store, asset, dir); // idempotent
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses unsafe file names in the store', async () => {
    const store = new MemoryStore();
    const asset = await renderStatCard(input);
    await expect(saveAsset(store, { png: asset.png, record: { ...asset.record, fileName: '../evil.png' } }, tmpdir())).rejects.toThrow(/unsafe/i);
  });
});
