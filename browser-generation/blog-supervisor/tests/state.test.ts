import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireBlogLock, BlogStateStore } from '../src/state.js';
import { isTransientError } from '../src/runner.js';
import { parseBlogArgs } from '../src/cli.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'blogstate-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const H = 3_600_000;
const info = (status: 'skipped' | 'written' | 'needs_human', extra = {}) => ({ url: 'https://k/x', title: 'T', status, reason: 'why', ...extra });

describe('BlogStateStore', () => {
  it('backs a failed row off for 6, 12, 24 hours and then parks it', async () => {
    const s = new BlogStateStore(dir);
    const t0 = 1_000_000;
    const a = await s.record(5, info('skipped'), t0);
    expect(a.nextEligibleAt).toBe(t0 + 6 * H);
    const b = await s.record(5, info('needs_human'), t0);
    expect(b.nextEligibleAt).toBe(t0 + 12 * H);
    const c = await s.record(5, info('skipped'), t0);
    expect(c.status).toBe('parked');
    const state = await s.load();
    expect(s.isEligible(state, 5, 'https://k/x', t0 + 1000 * H)).toBe(false);
    expect(await s.unpark()).toBe(1);
    expect(s.isEligible(await s.load(), 5, 'https://k/x', t0)).toBe(true);
  });
  it('is not eligible during the cool-down but is afterwards', async () => {
    const s = new BlogStateStore(dir);
    await s.record(7, info('skipped'), 0);
    const state = await s.load();
    expect(s.isEligible(state, 7, 'https://k/x', 5 * H)).toBe(false);
    expect(s.isEligible(state, 7, 'https://k/x', 7 * H)).toBe(true);
  });
  it('a changed URL resets the row', async () => {
    const s = new BlogStateStore(dir);
    await s.record(7, info('skipped'), 0);
    expect(s.isEligible(await s.load(), 7, 'https://k/other', 1)).toBe(true);
  });
  it('transient failures retry in 20 minutes without using an attempt, until the fourth', async () => {
    const s = new BlogStateStore(dir);
    const first = await s.record(9, info('skipped', { transient: true }), 0);
    expect(first.attempts).toBe(0);
    expect(first.nextEligibleAt).toBe(20 * 60_000);
    await s.record(9, info('skipped', { transient: true }), 0);
    await s.record(9, info('skipped', { transient: true }), 0);
    const fourth = await s.record(9, info('skipped', { transient: true }), 0);
    expect(fourth.attempts).toBe(1);
  });
  it('keeps and clears an approved draft', async () => {
    const s = new BlogStateStore(dir);
    await s.saveApprovedDraft(3, { a: 1 });
    expect(await s.loadApprovedDraft(3)).toEqual({ a: 1 });
    await s.clearApprovedDraft(3);
    expect(await s.loadApprovedDraft(3)).toBeNull();
  });
});

describe('acquireBlogLock', () => {
  it('can be taken, released and taken again', () => {
    const release = acquireBlogLock(dir);
    expect(release).not.toBeNull();
    release!();
    const again = acquireBlogLock(dir);
    expect(again).not.toBeNull();
    again!();
  });
});

describe('isTransientError', () => {
  it.each(['STALLED: ChatGPT stuck', 'EVIDENCE_FETCH_TRANSIENT: The report page did not load: Timed out', 'SEND_NOT_CONFIRMED: x', 'PREAMBLE_ONLY: x', 'Target page, context or browser has been closed', 'ECONNRESET'])('%s is transient', (m) => {
    expect(isTransientError(m)).toBe(true);
  });
  it('a report that cannot be verified is not', () => {
    expect(isTransientError('RESEARCH_BLOCKED: ChatGPT could not verify the primary report page')).toBe(false);
  });
});

describe('parseBlogArgs', () => {
  it('parses run options', () => {
    const a = parseBlogArgs(['run', '--loop', '--with-image', '--structure=rotate', '--row=12', '--limit=3', '--image-prompt=2']);
    expect(a).toMatchObject({ command: 'run', loop: true, withImage: true, structure: 'rotate', row: 12, limit: 3, imagePromptChoice: '2' });
  });
  it('defaults to the live V1.3 prompt', () => {
    delete process.env.BLOG_STRUCTURE;
    expect(parseBlogArgs(['run']).structure).toBe('v1.3');
  });
  it('rejects unknown arguments', () => {
    expect(() => parseBlogArgs(['run', '--bogus'])).toThrow();
    expect(() => parseBlogArgs(['run', '--image-prompt=3'])).toThrow();
  });
});
