import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { suggestExpanded } from './autosuggest.js';
import { dedupeArticles, gdeltArticles } from './gdelt.js';
import { matchTrends, trendsRss } from './trends-rss.js';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main(): Promise<void> {
  const seed = arg('seed');
  if (!seed) throw new Error('Pass --seed "<market phrase>" [--topic "<short head term>"] [--country ZA] [--lang en] [--gdelt-query \'("electric bus" OR "electric buses") "South Africa"\'] [--no-gdelt]');
  const country = arg('country', 'ZA')!;
  const language = arg('lang', 'en')!;
  const gdeltQuery = arg('gdelt-query', `"${seed}"`)!;
  // Autosuggest only answers short head terms ("electric bus"); long phrases with a country return nothing. The country goes in via gl=.
  const topic = arg('topic', seed)!;
  const terms = topic.toLowerCase().split(/\s+/).filter((w) => w.length > 3);

  const sug = await suggestExpanded(topic, { country, language });
  const trends = await trendsRss(country);
  const matched = matchTrends(trends.items, [topic, ...terms]);
  const news = process.argv.includes('--no-gdelt') ? null : await gdeltArticles(gdeltQuery, { timespan: arg('timespan', '14d')! });

  const snapshot = {
    schema: 'signals-snapshot/1',
    seed, country, language, collectedAt: new Date().toISOString(),
    autosuggest: { status: sug.status, note: sug.note, count: sug.items.length, items: sug.items },
    trendsRss: { status: trends.status, note: trends.note, feedItems: trends.items.length, relevant: matched },
    gdelt: news ? { status: news.status, note: news.note, query: gdeltQuery, count: news.items.length, items: dedupeArticles(news.items) } : { status: 'SKIPPED' },
  };
  const dir = path.resolve('.cache/signals/snapshots');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${seed.replace(/\W+/g, '-').toLowerCase()}_${country}_${snapshot.collectedAt.slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify(snapshot, null, 2));

  console.log(`Autosuggest [${sug.status}] ${sug.items.length} predictions (${sug.note})`);
  for (const i of sug.items.slice(0, 15)) console.log(`  ${i.intentClass.padEnd(11)} ${i.returnedPrediction}`);
  console.log(`Trends RSS ${country} [${trends.status}] ${trends.items.length} trending, ${matched.length} relevant to "${seed}"`);
  for (const t of matched.slice(0, 5)) console.log(`  ${t.title} (${t.approxTraffic ?? 'n/a'})`);
  if (news) {
    console.log(`GDELT [${news.status}] ${news.items.length} articles${news.note ? ` (${news.note})` : ''}`);
    for (const a of dedupeArticles(news.items).slice(0, 8)) console.log(`  ${a.seenAt ?? ''} ${a.domain} | ${a.title.slice(0, 90)}`);
  }
  console.log(`Saved ${file}`);
}

main().catch((e: unknown) => { console.error(`signals: ${(e as Error).message}`); process.exitCode = 1; });
