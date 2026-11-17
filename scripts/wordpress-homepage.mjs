// Creates (or updates) the "Home" page on the WordPress.com site and makes it the front page.
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const base = `https://public-api.wordpress.com/rest/v1.1/sites/${env.WORDPRESS_BLOG_ID}`;
const headers = { authorization: `Bearer ${env.WORDPRESS_ACCESS_TOKEN}`, 'content-type': 'application/json' };
const call = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
  return j;
};

const INK = '#0f2742', ACCENT = '#2f5fa3', SOFT = '#f3f6fb';
const card = (t, d) => `<div style="flex:1 1 220px;background:#fff;border:1px solid #dbe3ef;border-radius:12px;padding:22px"><h3 style="margin:0 0 8px;color:${INK};font-size:18px">${t}</h3><p style="margin:0;color:#4a5b73;font-size:15px;line-height:1.55">${d}</p></div>`;

const content = `<!-- wp:html -->
<div style="font-family:Inter,Segoe UI,Arial,sans-serif;color:${INK}">
  <section style="background:linear-gradient(135deg,${INK},${ACCENT});color:#fff;border-radius:16px;padding:56px 36px;text-align:center">
    <p style="margin:0 0 10px;letter-spacing:.12em;text-transform:uppercase;font-size:13px;opacity:.85">Market Intelligence</p>
    <h1 style="margin:0 0 14px;font-size:40px;line-height:1.15;color:#fff">Insight Waves</h1>
    <p style="margin:0 auto;max-width:640px;font-size:18px;line-height:1.55;opacity:.95">Data-backed market analysis, forecasts and competitive intelligence across industries and countries.</p>
  </section>
  <section style="margin:36px 0">
    <h2 style="margin:0 0 18px;font-size:26px;color:${INK}">What you will find here</h2>
    <div style="display:flex;flex-wrap:wrap;gap:16px">
      ${card('Market sizing &amp; forecasts', 'Base-year values, growth rates and outlook for each market we cover.')}
      ${card('Competitive landscape', 'Who leads, who is rising and where the share sits.')}
      ${card('Regional insight', 'Where demand concentrates and which regions are opening up.')}
    </div>
  </section>
  <h2 style="margin:36px 0 12px;font-size:26px;color:${INK}">Latest insights</h2>
</div>
<!-- /wp:html -->

<!-- wp:latest-posts {"postsToShow":6,"displayPostDate":true,"displayPostContent":true,"excerptLength":28} /-->`;

const existing = await (await fetch(`${base}/posts?type=page&search=Home&status=publish&fields=ID,title`, { headers })).json();
const home = existing.posts?.find((p) => p.title === 'Home');
const page = home
  ? await call(`/posts/${home.ID}`, { content })
  : await call('/posts/new', { title: 'Home', type: 'page', status: 'publish', content });
await call('/settings', { show_on_front: 'page', page_on_front: String(page.ID) });
console.log(`Homepage live: ${page.URL} (page ${page.ID}); front page set.`);
