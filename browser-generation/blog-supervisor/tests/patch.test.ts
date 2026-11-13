import { describe, expect, it } from 'vitest';
import { applyPatch } from '../src/patch.js';

const blog = { html: '<h1>T</h1><p>Market was <strong>USD 5,200 million</strong> in 2025.</p><p>Ken Research says so.</p>', seoTitle: 'Old title', description: 'Old description' };

describe('applyPatch', () => {
  it('replaces exact, unique text and can swap the SEO title and meta description', () => {
    const r = applyPatch(blog, {
      edits: [{ find: 'USD 5,200 million</strong> in 2025', replace: 'USD 5,080 million</strong> in 2024' }, { find: 'Ken Research says', replace: '<strong>Ken Research</strong> says' }],
      seoTitle: 'New title',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.blog.html).toContain('USD 5,080 million</strong> in 2024');
      expect(r.blog.html).toContain('<strong>Ken Research</strong> says');
      expect(r.blog.seoTitle).toBe('New title');
      expect(r.blog.description).toBe('Old description');
      expect(r.applied).toBe(3);
    }
  });
  it('refuses the whole patch when text is missing, ambiguous or adds a script, and changes nothing', () => {
    expect(applyPatch(blog, { edits: [{ find: 'not there', replace: 'x' }] }).ok).toBe(false);
    expect(applyPatch(blog, { edits: [{ find: '<p>', replace: '<p class="a">' }] }).ok).toBe(false);
    expect(applyPatch(blog, { edits: [{ find: 'Old', replace: '<script>x</script>' }] }).ok).toBe(false);
    expect(applyPatch(blog, {}).ok).toBe(false);
    expect(blog.html).toContain('USD 5,200 million');
  });
});
