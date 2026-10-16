# Repository research — 16 October 2026

Inspected public metadata, licenses, READMEs and relevant scraper/data-model files before implementation. No unlicensed code was copied. The universal TypeScript adapter uses the project's existing tooling and applies the reviewed repositories' public-URL techniques.

| Repository | Inspected revision / license | Finding and decision |
| --- | --- | --- |
| [x-tweet-fetcher](https://github.com/ythx-101/x-tweet-fetcher) | Active 16 Oct 2026 / MIT | Exact match for X single-post collection without login or key. Hermes uses its FxTwitter route pattern and normalized counters, then falls back to public X HTML. |
| [facebook-scraper](https://github.com/kevinzg/facebook-scraper) | Public repository / MIT | Direct `post_urls` approach validates the public-URL design and supported likes/reactions/comments/shares. Hermes keeps the implementation in TypeScript and leaves unavailable values null. |
| [linkedin-scraper-js](https://github.com/Dulain23/linkedin-scraper-js) | Public repository / MIT | Playwright selector patterns informed LinkedIn visible-text/counter extraction. Hermes first reads direct public JSON-LD/HTML and does not import a login session. |
| [skraper](https://github.com/sokomishalov/skraper) | Public repository / Apache-2.0 | Provider registry and normalized post/statistics model informed the universal adapter. It covers Facebook, X and Tumblr; LinkedIn remains a dedicated provider. |
| [Postiz app](https://github.com/gitroomhq/postiz-app) | `08b1e6b46f49bb92442123a2522d7f666a65d4f7`, AGPL-3.0 | Facebook/LinkedIn analytics require account permissions and exact IDs. Architecture reference; no backend deployment or publisher migration. Preserve native reach/impression definitions. |
| [Postiz agent](https://github.com/gitroomhq/postiz-agent) | `86e02524377cc60a6cd6ef67fd10a3caeade8d2c`, AGPL-3.0 in LICENSE | Analytics uses a known Postiz post ID and authenticated service, not an arbitrary URL. No nonworking service dependency was added. |
| [Twikit](https://github.com/d60/twikit) | `c3b7220866f8582009fe2d1155b6fe92192a2711`, MIT | X models separate views/replies/counters. Unofficial session/internal-API dependency; reference only. |
| [twscrape](https://github.com/vladkens/twscrape) | `568844df82af956df5970bcf7ff84dd5ba729eb0`, MIT | Authorized sessions are required; missing views can remain nullable. No cookie extraction/account pool added. |
| [tumblr.js](https://github.com/tumblr/tumblr.js) | `c86b722a8e8bb0729f9160fb03b36f7d1685c1ba`, Apache-2.0 | Official JS API client shows blog/post lookup. Native adapter keeps note_count as aggregate notes. |
| [Tweepy](https://github.com/tweepy/tweepy) | `c1978d643ecce491929084e4290b35f57e4921ad`, MIT | Official X API-client patterns separate public/owner data and failures. Native TS lookup avoids another runtime. |
| [marketingskills](https://github.com/coreyhaines31/marketingskills) | Previously reviewed `55ff469422c3592dac45bcad08dfb40221981c02`, MIT | Source-specific buyer relevance becomes one proposed experiment within the approved format pool, not imported market facts. |

Official contracts consulted:

- [X metrics](https://docs.x.com/x-api/fundamentals/metrics): public versus authenticated private metrics and availability windows.
- [LinkedIn member analytics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics): permission, share/ugcPost entity, query types and TOTAL aggregation.
- [LinkedIn organization statistics](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics): organization context and organic statistics.
- [Tumblr API](https://www.tumblr.com/docs/en/api/v2): blog/post identity and aggregate notes.
- [Meta Insights](https://developers.facebook.com/docs/graph-api/reference/insights/): retrieval was unavailable in this research session. Basic fields/configurable mappings are fixture-tested; exact live Page access/version/insight names remain to be verified.

Public repositories can collect only what a public URL exposes. Private impressions, reach and owner analytics still require an official account or dated export. Missing public metrics are preserved as null and never interpreted as zero.
