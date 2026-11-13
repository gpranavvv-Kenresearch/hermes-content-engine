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
  it('retries a failed row straight away, parks it after 5 failures, and unpark makes every unfinished row eligible again', async () => {
    const s = new BlogStateStore(dir);
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect((await s.record(5, info(i % 2 ? 'needs_human' : 'skipped'), t0)).nextEligibleAt).toBe(t0);
    expect((await s.record(5, info('skipped'), t0)).nextEligibleAt).toBe(t0 + 0.05 * H);
    expect((await s.record(5, info('skipped'), t0)).status).toBe('parked');
    await s.record(6, info('needs_human', { url: 'https://k/y' }), t0);
    await s.record(7, info('written', { url: 'https://k/z' }), t0);
    expect(s.isEligible(await s.load(), 5, 'https://k/x', t0 + 1000 * H)).toBe(false);
    expect(await s.unpark()).toBe(2);
    const state = await s.load();
    expect(s.isEligible(state, 5, 'https://k/x', t0)).toBe(true);
    expect(s.isEligible(state, 6, 'https://k/y', t0)).toBe(true);
    expect(state.rows['7']!.status).toBe('written');
  });
  it('is eligible again straight away after a first failure, and waits only for a transient cool-down', async () => {
    const s = new BlogStateStore(dir);
    await s.record(7, info('skipped'), 0);
    expect(s.isEligible(await s.load(), 7, 'https://k/x', 0)).toBe(true);
    await s.record(8, info('skipped', { transient: true }), 0);
    expect(s.isEligible(await s.load(), 8, 'https://k/x', 10 * 60_000)).toBe(false);
    expect(s.isEligible(await s.load(), 8, 'https://k/x', 21 * 60_000)).toBe(true);
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
