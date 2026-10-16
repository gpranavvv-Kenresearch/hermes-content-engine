import { describe, expect, it } from 'vitest';
import { auditLegacyPosts, formatAuditMarkdown, mapSheetRows, parseCsv, rowsToObjects, type LegacyPost } from '../../src/shadow/index.js';
import { config, utmLink } from '../fixtures/validation/helpers.js';

describe('csv', () => {
  it('parses quotes, doubled quotes, embedded newlines, CRLF and a BOM', () => {
    const csv = '﻿id,post,note\r\n1,"Hello, ""world""\nsecond line",ok\r\n2,plain,\r\n';
    const rows = parseCsv(csv);
    expect(rows).toEqual([
      ['id', 'post', 'note'],
      ['1', 'Hello, "world"\nsecond line', 'ok'],
      ['2', 'plain', ''],
    ]);
    expect(rowsToObjects(rows)[0]).toEqual({ id: '1', post: 'Hello, "world"\nsecond line', note: 'ok' });
  });

  it('handles a file without a trailing newline and drops empty trailing rows', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\n1,2\n\n\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('mapSheetRows', () => {
  const rows = [
    { ID: '7', URL: 'https://www.kenresearch.com/r', 'X Post': 'tweet text', 'FB Post': 'fb text', 'LinkedIn Post': '' },
    { ID: '8', URL: 'https://www.kenresearch.com/r2', 'X Post': '', 'FB Post': '', 'LinkedIn Post': 'li text' },
  ];

  it('guesses common column names and skips empty cells', () => {
    const { posts, matchedColumns } = mapSheetRows(rows);
    expect(matchedColumns).toMatchObject({ x: 'X Post', facebook: 'FB Post', linkedin: 'LinkedIn Post', url: 'URL', id: 'ID' });
    expect(posts.map((p) => p.id)).toEqual(['7:x', '7:facebook', '8:linkedin']);
    expect(posts[0]).toMatchObject({ platform: 'x', reportUrl: 'https://www.kenresearch.com/r' });
  });

  it('honours explicit column names and warns when they are missing', () => {
    const { warnings, matchedColumns } = mapSheetRows([{ A: 'x1', B: 'y' }], { x: 'A', facebook: 'Nope' });
    expect(matchedColumns.x).toBe('A');
    expect(warnings.join(' ')).toMatch(/"Nope" for facebook was not found/);
  });

  it('warns clearly when no post column can be found', () => {
    const { posts, warnings } = mapSheetRows([{ Foo: '1', Bar: '2' }]);
    expect(posts).toEqual([]);
    expect(warnings.join(' ')).toMatch(/no post columns matched; headers seen: Foo \| Bar/);
  });
});

describe('auditLegacyPosts', () => {
  const good = `Ken Research finds the Examplestan widget market shifting toward premium segments. Full outlook: ${utmLink('x')} #Widgets #Examplestan`;
  const posts: LegacyPost[] = [
    { id: 'p1', platform: 'x', text: good },
    { id: 'p2', platform: 'x', text: `Per Mordor Intelligence the widget market is large. ${utmLink('x')} #Widgets` },
    { id: 'p3', platform: 'x', text: 'No link at all here, just hype and a long enough sentence to avoid being trivially short. #Widgets' },
    { id: 'p4', platform: 'facebook', text: `${'Widget market insight sentence. '.repeat(90)}${utmLink('facebook')} #A #B #C #D #E #F` },
    { id: 'p5', platform: 'x', text: good }, // exact duplicate of p1
  ];
  const report = auditLegacyPosts(posts, config, { now: () => new Date('2026-10-13T00:00:00Z') });

  it('flags the specific hard problems, per post', () => {
    const byId = Object.fromEntries(report.posts.map((p) => [p.id, p]));
    expect(byId.p1!.hardCodes).toEqual([]);
    expect(byId.p2!.hardCodes).toContain('COMPETITOR_MENTION');
    expect(byId.p3!.hardCodes).toContain('MISSING_SOURCE_LINK');
    expect(byId.p4!.hardCodes).toContain('OVER_HARD_LIMIT');
    expect(byId.p5!.hardCodes).toContain('EXACT_DUPLICATE');
  });

  it('aggregates counts, platforms and example ids', () => {
    expect(report.total).toBe(5);
    expect(report.hardFailPosts).toBe(4);
    expect(report.passedHardChecks).toBe(1);
    expect(report.byPlatform.x).toEqual({ total: 4, hardFailPosts: 3 });
    expect(report.byCode.COMPETITOR_MENTION).toMatchObject({ severity: 'hard_fail', count: 1, exampleIds: ['p2'] });
    expect(report.claimsAudited).toBe(false);
  });

  it('renders a markdown summary that states claims were not audited', () => {
    const md = formatAuditMarkdown(report);
    expect(md).toContain('Posts audited: 5');
    expect(md).toContain('Numeric claims were NOT audited');
    expect(md).toContain('| COMPETITOR_MENTION | hard_fail | 1 | p2 |');
  });
});
