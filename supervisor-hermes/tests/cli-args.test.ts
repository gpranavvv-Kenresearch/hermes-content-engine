import { describe, expect, it } from 'vitest';
import { parseRunArgs } from '../src/cli.js';

describe('parseRunArgs', () => {
  it('parses platform, count and defaults', () => {
    expect(parseRunArgs(['--platform', 'li', '--count', '3'])).toMatchObject({
      platform: 'linkedin',
      count: 3,
      writeSheet: false,
      supplementary: 'ken-gov',
      maxRegenerations: 2,
      maxRetries: 3,
      maxHermesCalls: 20,
    });
  });
  it('accepts --write-sheet, --keyword and --background', () => {
    expect(parseRunArgs(['--platform', 'fb', '--write-sheet', '--keyword', 'a b', '--background'])).toMatchObject({
      platform: 'facebook',
      writeSheet: true,
      keyword: 'a b',
      supplementary: 'all',
    });
  });
  it('--retry-skipped is off by default and on when given', () => {
    expect(parseRunArgs(['--platform', 'li']).retrySkipped).toBe(false);
    expect(parseRunArgs(['--platform', 'li', '--retry-skipped']).retrySkipped).toBe(true);
  });
  it('rejects a bad platform, a bad count and --count with --row', () => {
    expect(() => parseRunArgs(['--platform', 'instagram'])).toThrow();
    expect(() => parseRunArgs(['--platform', 'li', '--count', '0'])).toThrow();
    expect(() => parseRunArgs(['--platform', 'li', '--count', '26'])).toThrow();
    expect(() => parseRunArgs(['--platform', 'li', '--count', '2', '--row', '9'])).toThrow();
  });
  it('requires a platform and rejects stray arguments', () => {
    expect(() => parseRunArgs([])).toThrow();
    expect(() => parseRunArgs(['--platform', 'li', 'oops'])).toThrow();
  });
  it('accepts X batches and the twitter alias with an explicit Sheet handoff', () => {
    expect(parseRunArgs(['--platform', 'x', '--count', '10', '--write-sheet'])).toMatchObject({ platform: 'x', count: 10, writeSheet: true });
    expect(parseRunArgs(['--platform', 'twitter'])).toMatchObject({ platform: 'x', writeSheet: false });
  });
  it('accepts Tumblr through the same supervised runner', () => {
    expect(parseRunArgs(['--platform', 'tumblr', '--count', '25'])).toMatchObject({ platform: 'tumblr', count: 25, writeSheet: false });
  });
});
