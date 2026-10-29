import { describe, expect, it } from 'vitest';
import { injectCoverImage, moveImagesBelowFirstH2 } from '../../src/coordinator/blogGenLoop.js';

const IMG = '<img src="YOUR_IMAGE_URL_HERE" alt="Snapshot">';

describe('moveImagesBelowFirstH2', () => {
  it('moves an image placed after the intro to after the first paragraph of the first H2', () => {
    const html = `<h1>Title</h1>\n<p>Intro one.</p>\n<p>Intro two.</p>\n${IMG}\n<h2>First</h2>\n<p>A.</p>\n<p>B.</p>\n<h2>Second</h2>\n<p>C.</p>`;
    const out = moveImagesBelowFirstH2(html);
    expect(out.indexOf('<img')).toBeGreaterThan(out.indexOf('<h2>First</h2>'));
    expect(out.indexOf('<img')).toBeLessThan(out.indexOf('<p>B.</p>'));
    expect(out.indexOf('<img')).toBeGreaterThan(out.indexOf('<p>A.</p>'));
    expect(out.match(/<img/g)).toHaveLength(1);
  });

  it('leaves images that are already inside an H2 alone', () => {
    const html = `<h1>T</h1>\n<p>Intro.</p>\n<h2>One</h2>\n<p>A.</p>\n${IMG}\n<h2>Two</h2>\n<p>B.</p>`;
    expect(moveImagesBelowFirstH2(html)).toBe(html);
  });

  it('does nothing when there is no H2, and keeps the cover above the H1', () => {
    expect(moveImagesBelowFirstH2(`<h1>T</h1><p>x</p>${IMG}`)).toBe(`<h1>T</h1><p>x</p>${IMG}`);
    const out = injectCoverImage(moveImagesBelowFirstH2(`<h1>T</h1><p>i</p>${IMG}<h2>A</h2><p>a</p>`), 'cover.png');
    expect(out.startsWith('<img src="cover.png">')).toBe(true);
    expect(out.indexOf('YOUR_IMAGE_URL_HERE')).toBeGreaterThan(out.indexOf('<h2>A</h2>'));
  });
});
