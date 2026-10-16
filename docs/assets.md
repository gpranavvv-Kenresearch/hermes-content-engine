# Data-card assets

Code: `src/assets/`. Free tools only: Satori (layout), `@resvg/resvg-js` (SVG to PNG), Vega-Lite and Vega (charts,
headless). No browser, no network.

## Pipeline

```
verified facts --> chart.ts (vega-lite spec -> vega SVG -> resvg PNG) --+
                                                                        +--> card-renderer.ts (satori element tree -> SVG -> resvg PNG) --> asset-store.ts
verified facts -------------------------------------------------------+
```

Satori is used with plain `{ type, props }` element objects (no React/JSX). The chart PNG is embedded in the card
as an `<img>` data URI.

## Input rule (non-negotiable)

Only facts that are `verificationStatus: 'verified'` **and** whose `sourceUrl` passes the source policy (Ken
Research or government hosts, competitors blocked, same rules as `src/config/source-policy.config.ts`) may be
rendered or charted. Value, unit, period and geography must all be visible on the card, so a fact missing a period
or geography is rejected rather than rendered without it.

On any violation `renderStatCard` throws `CardInputError` (and the chart builders throw `ChartInputError`) listing
every problem found; **no image is produced**. Validation happens before fonts or renderers are touched.

## API

```ts
renderStatCard({ facts, title, sourceLabel, size?, theme?, chart?, now? })
  : Promise<{ png: Buffer; record: AssetRecord }>
// size: CARD_SIZES.landscape (1200x630, default) | CARD_SIZES.square (1080x1080) | custom 200..4000
// theme: 'light' | 'dark'

AssetRecord = { fileName, factIds, renderVersion, width, height, createdAt }
// fileName = "<sha256 of the PNG bytes>.png"; renderVersion = RENDER_VERSION ("stat-card-1")

buildBarSpec(facts, { title, categoryField?, width?, height? }, family?)   // vega-lite spec
buildLineSpec(facts, options, family?)
renderBarChart(facts, options) / renderLineChart(facts, options) : Promise<ChartImage>
// ChartImage = { svg, png, width, height, factIds }; passed as `chart` to renderStatCard

saveAsset(store, { png, record }, assetDir = 'output/assets') : Promise<{ pngPath, id }>
getAssetRecord(store, id) / listAssetRecords(store)

resolveFont() / findFontPath() / fontAvailable
```

Chart rules: one unit across all facts, unique x labels, bar needs >= 1 point and line >= 2, at most 24 points.
Bar charts default to geography on the x axis, line charts to period (sorted); override with `categoryField`.
`factIds` on the chart must be a subset of the card's facts.

## Determinism

Identical input gives identical PNG bytes (tested), so the content hash in `fileName` is stable and re-rendering
is idempotent. `createdAt` is in the record only, never in the pixels; pass `now` for a fixed record. Numbers are
formatted without ICU (`formatNumber`), so locale does not change output. Bump `RENDER_VERSION` when the layout
changes, since identical facts would otherwise hash differently without any record of why.

## Storage

`saveAsset` writes `<assetDir>/<hash>.png` (temp file then rename, so a crash never leaves half a file) and the
`AssetRecord` JSON through the `Store` interface under collection `assets`, id = hash. File names must match
`^[a-f0-9]{64}\.png$`; anything else is refused.

## Fonts

Satori and resvg need an actual font file. Resolution order: `CE_FONT_PATH` (if the file exists), then
`C:/Windows/Fonts/segoeui.ttf`, `arial.ttf`, `calibri.ttf`, `tahoma.ttf`, `verdana.ttf`, then a few Linux/macOS
paths. If none exists, `FontNotFoundError` lists what was tried. On a server without those fonts, point
`CE_FONT_PATH` at a font you are licensed to use. Tests that render use `describe.skipIf(!fontAvailable)`.
The font family name is read from the font file's own name table, so any TTF/OTF/TTC works.

## Limits

- One font weight is loaded, so no bold. Colour, size and spacing carry the hierarchy.
- Latin text only unless `CE_FONT_PATH` points at a font covering other scripts.
- Up to 6 facts per card; long titles wrap but are not truncated, so keep them short.
- The card shows facts and their source label and hosts. It cannot prove the fact is right; that is the evidence
  layer's job. Rendering simply refuses anything that layer did not verify.
- An image on a post does not guarantee reach, search inclusion or AI citation.
