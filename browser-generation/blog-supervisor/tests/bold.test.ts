import { describe, expect, it } from 'vitest';
import { enforceBrandAndFigureBold } from '../src/bold.js';

describe('enforceBrandAndFigureBold', () => {
  it('bolds plain Ken Research and figures in body text', () => {
    const out = enforceBrandAndFigureBold('<p>Ken Research sizes it at USD 5,200 million in 2025, growing 9.8% a year.</p>');
    expect(out).toBe('<p><strong>Ken Research</strong> sizes it at <strong>USD 5,200 million</strong> in <strong>2025</strong>, growing <strong>9.8%</strong> a year.</p>');
  });
  it('leaves existing bold, links, headings figures, list markers and placeholders alone', () => {
    const html = '<h2>Top 5 shifts in 2025</h2><p><strong>Ken Research</strong> says <strong>9.8%</strong>.</p><p><a href="https://x.com/2025">Report 2025</a></p><p>1. First point</p><img src=\'YOUR_IMAGE_URL_HERE_2\'>';
    expect(enforceBrandAndFigureBold(html)).toBe(html);
  });
  it('bolds the brand inside headings but not figures, and does not split words like H2 or 5G', () => {
    const out = enforceBrandAndFigureBold('<h1>Ken Research on 2025</h1><p>The 5G and H2 labels.</p>');
    expect(out).toBe('<h1><strong>Ken Research</strong> on 2025</h1><p>The 5G and H2 labels.</p>');
  });
});

describe('brand inside link text', () => {
  it('bolds a plain "Ken Research" inside an anchor but leaves figures in link text alone', () => {
    const out = enforceBrandAndFigureBold('<p>See the <a href="https://www.kenresearch.com/x">Ken Research Malaysia 3PL report 2025</a> and the <a href="https://www.kenresearch.com/"><strong>Ken Research</strong></a> site.</p>');
    expect(out).toBe('<p>See the <a href="https://www.kenresearch.com/x"><strong>Ken Research</strong> Malaysia 3PL report 2025</a> and the <a href="https://www.kenresearch.com/"><strong>Ken Research</strong></a> site.</p>');
  });
});
