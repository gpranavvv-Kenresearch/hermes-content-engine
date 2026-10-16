# Evidence layer (`src/evidence/`)

Turns allowed web pages into validated `Fact`s and checks draft text against them.
No LLM, no browser, no network in tests. Import from `src/evidence/index.ts`.

## Pipeline

search (`allowlistedSearch`) -> fetch (`createSafeFetcher`) -> `extractContent` -> `validateFetchedSource` (incl. canonical) -> `extractFacts` -> `checkClaims` on the draft.

## What is enforced (deterministic, tested)

- **Source policy** (`source-validator.ts`): http/https only; no userinfo, no IP literals, no localhost/single-label hosts, ports other than 80/443 rejected. Host normalised (lowercase, no `www`, no trailing dot, punycode via WHATWG URL). Blocked competitor hosts are checked first and for every purpose, with dot-boundary subdomain matching (`sub.imarcgroup.com` blocked, `evil-imarcgroup.com` not). Fact/citation need Ken Research, a government pattern, or `extraAllowedHosts`; planning also allows other hosts as `planning_other`. Requested, final and canonical URLs must all pass.
- **Fetcher** (`fetcher.ts`): redirects followed manually (max 5), each hop validated before it is requested, so a blocked host is never contacted. Timeout via `withTimeout`, 5 MB body cap (header and streaming), `text/html`/xhtml only, honest User-Agent. Errors are `EngineError`s (`SOURCE_BLOCKED` fatal, 429 rate_limited, 5xx/network/timeout retryable).
- **Search** (`search-providers.ts`): `includeDomains` is only a hint; every returned URL is re-validated and violations are discarded and counted.
- **Claim checking** (`claim-verifier.ts`): every material numeric claim must map to a fact or the draft gets a `hard_fail`.

## What is heuristic (regex proposes, rules decide)

- **Fact extraction** supports `market_size` (currency + amount + billion/million/trillion/bn/mn/B/M) and `cagr` (percent near "CAGR"/"compound annual growth"). crore/lakh/thousand and money without a scale are ignored. A money amount counts as market size only if the sentence mentions market/industry/sector and a value-trigger word (valued, reach, worth ...).
- **Period** is assigned to the nearest candidate in the sentence; two periods competing for one number marks it ambiguous. **Geography** comes from the sentence, then title, then URL slug, against `geography.data.ts` (extend it or pass `extraGeographies`). **Market definition** is the title text up to "Market".
- **`verified`** only when the host is Ken Research/government/explicitly allowed (this includes `extraAllowedHosts`, e.g. europa.eu), and metric, value, unit and period were extracted unambiguously from one sentence. Everything else is `unverified`. Facts with the same metric+period+geography+currency but different values (after unit conversion) are all `conflicting`. Verified means "the page says this", not "the number is true".
- **Derived** facts (`deriveCagrFact`) carry `factType: 'derived'`, formula and input ids; they are `verified` only if both inputs are.
- **Claim matching**: exact within printed precision, unit conversions, derived CAGR/total growth/multiples from two single-year market-size facts of the same currency and geography. A claim may round to fewer decimals (4.23 supports "4.2", 4.2 supports "4") but cannot add precision (4.2 does not support "4.23"). Context check: a year or geography named near the claim (nearest-claim assignment, 80 chars) that differs from the fact gives `FACT_CONTEXT_MISMATCH`.
- **Ignored on purpose**: years/dates, URLs, domains, emails, handles, hashtags, list numbers, phone-like numbers, ids, versions, times, character counts, bare integers under 10, small prices (money without scale under 1,000), "top 10 companies" labels.

## Known limits

- English only. Sentence splitting is simple; unusual abbreviations can split a sentence.
- Tables are extracted for text but facts are not read from table cells yet.
- Money without a scale >= 1,000 is a claim, but facts are only created from scaled amounts.
- 100% and similar absolute percentages are treated as claims.
- Claim wording like "about", "more than", "nearly" is not interpreted; the number is checked as written.
- Government detection relies on `governmentHostPatterns`; hosts outside those patterns (e.g. some national statistics bodies on `.org`) must be added to `extraAllowedHosts`.
- Search `includeDomains` cannot express government patterns; pass suffix hints via `extraIncludeDomains`. Post-filtering is the real control.
- Port restriction and IP-literal rejection apply to all purposes (stricter than the brief, to block SSRF).

## Only verifiable live

Real Defuddle/Readability output on real Ken Research pages, real Tavily/Exa error shapes (status extraction handles `statusCode`, `status`, `response.status` and message patterns; 432/433 for Tavily plan limits is from SDK docs), real redirect and header behaviour of target sites, and Exa `contents: { highlights: true }` option acceptance.
