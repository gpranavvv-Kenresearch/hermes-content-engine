// WordPress.com OAuth helper.
//   node scripts/wordpress-auth.mjs            -> prints the login URL
//   node scripts/wordpress-auth.mjs "<url>"    -> exchanges the ?code= from the callback URL for a token
import { readFileSync, appendFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const { WORDPRESS_CLIENT_ID: id, WORDPRESS_CLIENT_SECRET: secret, WORDPRESS_REDIRECT_URI: redirect } = env;
if (!id || !secret || !redirect) throw new Error('Set WORDPRESS_CLIENT_ID / _SECRET / _REDIRECT_URI in .env');

const arg = process.argv[2];
if (!arg) {
  const q = new URLSearchParams({ client_id: id, redirect_uri: redirect, response_type: 'code' });
  console.log(`Open this URL, click Approve:\n\nhttps://public-api.wordpress.com/oauth2/authorize?${q}\n`);
  process.exit(0);
}

const code = arg.includes('code=') ? new URL(arg).searchParams.get('code') : arg;
const res = await fetch('https://public-api.wordpress.com/oauth2/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code', code }),
});
const data = await res.json();
if (!res.ok || !data.access_token) { console.error('Token exchange failed:', data); process.exit(1); }
appendFileSync(new URL('../.env', import.meta.url), `\nWORDPRESS_ACCESS_TOKEN=${data.access_token}\nWORDPRESS_BLOG_ID=${data.blog_id ?? ''}\nWORDPRESS_BLOG_URL=${data.blog_url ?? ''}\n`);
console.log(`Saved token to .env. Site: ${data.blog_url} (blog_id ${data.blog_id})`);
