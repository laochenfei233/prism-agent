# prism-search

English | [中文](README.zh.md)

A Prism plugin that adds a keyless, local web search provider to
`web_search`. It queries 18 free search engines in parallel, fuses their
rankings with reciprocal rank fusion, reads the top pages, and orders the result
with a model the user picked in **Models**. It registers into the existing
`ctx.web` capability seam, so the shipped `web_search` tool, its card, its
timeout policy, and its truncation are reused unchanged.

## Engines

Google, Bing, DuckDuckGo, Brave, Startpage, Yahoo, Yandex, Mojeek, Marginalia,
Qwant, Baidu, Sogou, 360 Search, Bilibili, Wikipedia, GitHub, Hacker News, and
Stack Exchange. No engine needs an account or an API key. Chinese queries use
Chinese engine parameters and `zh.wikipedia.org`; other queries use English.

## How one search runs

1. Every engine receives the query in parallel with its own timeout and the
   caller's cancellation; a blocked, captcha-walled, or timed-out engine
   contributes nothing.
2. Results merge by RRF (`1 / (60 + rank)`), deduplicated on a normalized URL
   (tracking parameters, fragment, trailing slash, `www.` removed).
3. The top `fetchTopN` results are fetched concurrently through the deployment's
   fetch provider (so its address and redirect policy applies) and their readable
   page text replaces the engine excerpt; the final URL after redirects replaces
   the engine's link wrapper.
4. When a model is configured, the top `maxRerankCandidates` results go to it as
   one auxiliary call that returns a JSON order; the fused order survives when
   the call or its answer is unusable.
5. Sources are capped to the caller's `maxResults`.

## Settings

The plugin adds one **Settings → Search** section:

- **Provide web_search through Prism Search** writes `web.searchProvider`
  (`prism-search`, or the composed default when turned off).
- **Ordering model** lists every model the deployment currently advertises in
  Models; nothing is hardcoded. The choice is stored in the plugin's own
  settings (`rerankProvider`, `rerankModel`) and applies to the next search.

## Install into a profile

Build the package once, then install the folder as a profile dependency:

```sh
pnpm install && pnpm build
dsh plugin --profile web add /path/to/prism-search
```

Restart the service. Then open Settings → Search, enable the provider, and
(optionally) pick an ordering model. A profile whose `web` row pins another
search provider keeps using it until the switch is enabled.

## Configuration

Row `prism-search`; every field is volatile, so a saved value applies without a
restart. Defaults suit a desktop connection.

| Field | Default | Meaning |
|---|---|---|
| `rerankProvider` | `''` | Provider route of the ordering model; empty disables ordering |
| `rerankModel` | `''` | Model id of the ordering model |
| `fetchTopN` | `8` | Pages fetched for their text; `0` disables fetching |
| `engineTimeoutMs` | `8000` | Per-engine time bound |
| `fetchTimeoutMs` | `8000` | Per-page time bound |
| `rerankTimeoutMs` | `20000` | Time bound for the ordering call |
| `maxSnippetChars` | `1200` | Characters kept from one page's text |
| `maxRerankCandidates` | `12` | Candidates offered to the ordering model |

## Build

```sh
pnpm install
pnpm build        # lib/index.js (Host) and lib/client.js (browser half)
pnpm typecheck
pnpm test         # unit tests, no network
pnpm smoke        # built artifact: registration plus one stubbed search
```

## Known limitations

- **HTML scraping is best effort.** Engines change their markup and some block
  data-centre or unusual clients; those engines return nothing for a search
  while the others still answer. No engine is required for a result.
- **No JavaScript rendering.** Pages whose text exists only after client-side
  rendering keep the engine excerpt.
- **No Session event for the ordering call.** An out-of-tree plugin cannot write
  Session events (the persistence reader refuses unknown non-`plugin:` types),
  so the auxiliary request is not logged as an event. Its prompt is a pure
  function of the logged `web_search` arguments, the logged sources, and this
  package's fixed template, so it stays reconstructable from the Session log.
- **Baidu, Sogou, and 360 wrapper links** resolve to the destination only after
  the page fetch succeeds; without it the source URL stays the engine wrapper.
