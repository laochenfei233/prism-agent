/**
 * The `prism-search` web search provider: fan out to the keyless engines, fuse
 * their rankings, read the top pages, and order the result by a model the user
 * selected in Models. Registered with `ctx.web`; it exposes no tool of its own.
 *
 * @module @prism/prism-search/provider
 */

import type { EngineHit, EngineSpec } from './engines.ts'
import { dedupeByUrl, fuse, type EngineAnswer, type RankedHit } from './fusion.ts'
import { withTimeout, type HttpRequest, type HttpResponse } from './http.ts'
import type { Reranker } from './rerank.ts'

/** Stable provider id; also the value the web service's `searchProvider` names. */
export const PROVIDER_ID = 'prism-search'

/** Results returned when the caller sets no `maxResults`. */
export const DEFAULT_RESULT_LIMIT = 10

/** How many pages are fetched at once. */
const PAGE_CONCURRENCY = 4

/** Resolved search controls for one search. */
export interface PrismSearchOptions {
  /** Provider route of the model that orders results; empty disables ordering. */
  readonly rerankProvider: string
  /** Model id of that model; empty disables ordering. */
  readonly rerankModel: string
  /** Pages fetched for their text; 0 disables fetching. */
  readonly fetchTopN: number
  /** Per-engine time bound. */
  readonly engineTimeoutMs: number
  /** Per-page time bound. */
  readonly fetchTimeoutMs: number
  /** Time bound for the ordering call. */
  readonly rerankTimeoutMs: number
  /** Characters kept from one page's readable text. */
  readonly maxSnippetChars: number
  /** Candidates offered to the ordering model. */
  readonly maxRerankCandidates: number
}

/** One page fetched for its readable text. */
export interface FetchedPage {
  /** Final URL after redirects. */
  readonly url: string
  /** The page's `<title>`, when it has one. */
  readonly title?: string
  /** Readable text, already capped. */
  readonly text: string
}

/** Fetch one result page for its text; resolves undefined when it cannot be read. */
export type PageFetcher = (
  url: string,
  request: { readonly signal?: AbortSignal; readonly timeoutMs: number; readonly maxChars: number },
) => Promise<FetchedPage | undefined>

/** One result the web service can return. */
interface WebSourceLike {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
  readonly publishedAt?: string
}

/** Outcome the web service consumes. */
interface WebSearchResultLike {
  readonly sources: readonly WebSourceLike[]
  readonly truncated: boolean
}

/** Collaborators the Host entry supplies. */
export interface PrismSearchDeps {
  /** The keyless engine catalog. */
  readonly engines: readonly EngineSpec[]
  /** HTTP transport for engine requests. */
  readonly http: (request: HttpRequest) => Promise<HttpResponse>
  /** Page text reader. */
  readonly fetchPage: PageFetcher
  /** The selected model's ordering call. */
  readonly rerank: Reranker
  /** The current controls, snapshotted once per search. */
  readonly options: () => PrismSearchOptions
}

/** A search failure the tool layer reports to the user. */
export class PrismSearchError extends Error {
  /**
   * @param message - actionable failure text.
   * @param code - stable machine-routing code.
   */
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'PrismSearchError'
  }
}

/** The `prism-search` search provider. */
export class PrismSearchProvider {
  /** Stable provider id the web service selects by. */
  readonly id = PROVIDER_ID

  /** @param deps - engine catalog, transport, page reader, ordering call, and controls. */
  constructor(private readonly deps: PrismSearchDeps) {}

  /** Availability is constant: the engines need no credential, so selection never depends on state. */
  available(): boolean {
    return true
  }

  /**
   * Run one search across every engine and return its ordered sources.
   * @param request - the query and the caller's result cap.
   * @param signal - cancellation from the tool call.
   * @returns the sources capped to `maxResults`, with `truncated` set when cut.
   * @throws {@link PrismSearchError} when every engine failed, produced nothing, or the call was cancelled.
   */
  async search(
    request: { readonly query: string; readonly maxResults?: number },
    signal?: AbortSignal,
  ): Promise<WebSearchResultLike> {
    const options = this.deps.options()
    throwIfAborted(signal)
    const query = request.query.trim()
    if (query.length === 0) throw new PrismSearchError('Prism Search needs a non-empty query.', 'prism-search/empty-query')

    const answers = await this.recall(query, options, signal)
    throwIfAborted(signal)
    const fused = fuse(answers)
    if (fused.length === 0) {
      throw new PrismSearchError(
        `Prism Search queried ${this.deps.engines.length} engines and received no results.`
        + ' Check the network, or select another search provider in Settings > Web search.',
        'prism-search/no-results',
      )
    }

    const enriched = dedupeByUrl(await this.enrich(fused, options, signal, request.maxResults))
    throwIfAborted(signal)
    const ordered = await this.order(query, enriched, options, signal)
    throwIfAborted(signal)

    const limit = request.maxResults === undefined ? DEFAULT_RESULT_LIMIT : Math.max(0, request.maxResults)
    const visible = ordered.slice(0, limit)
    return { sources: visible.map(sourceOf), truncated: ordered.length > visible.length }
  }

  /** Ask every engine in parallel; a failed or empty engine contributes nothing. */
  private async recall(query: string, options: PrismSearchOptions, signal?: AbortSignal): Promise<EngineAnswer[]> {
    const settled = await Promise.all(this.deps.engines.map(async (engine): Promise<EngineAnswer> => ({
      engine: engine.id,
      hits: await this.runEngine(engine, query, options, signal),
    })))
    return settled.filter(answer => answer.hits.length > 0)
  }

  /** Run one engine request, returning no results for any failure. */
  private async runEngine(
    engine: EngineSpec,
    query: string,
    options: PrismSearchOptions,
    signal?: AbortSignal,
  ): Promise<EngineHit[]> {
    try {
      const request = engine.build(query)
      const response = await this.deps.http({
        url: request.url,
        ...request.method === undefined ? {} : { method: request.method },
        ...request.body === undefined ? {} : { body: request.body },
        ...request.headers === undefined ? {} : { headers: request.headers },
        signal: withTimeout(signal, options.engineTimeoutMs),
      })
      if (response.status < 200 || response.status >= 300) return []
      return engine.parse(response.text, response.url)
    } catch {
      // A blocked, captcha-walled, or timed-out engine contributes no results.
      return []
    }
  }

  /** Replace the top results' excerpts with their pages' readable text. */
  private async enrich(
    hits: readonly RankedHit[],
    options: PrismSearchOptions,
    signal: AbortSignal | undefined,
    maxResults: number | undefined,
  ): Promise<RankedHit[]> {
    // The caller never sees more than its own bound, so pages beyond it are
    // fetched only when the ordering model could lift them into view.
    const visibleBound = maxResults === undefined ? hits.length : Math.max(0, maxResults)
    const count = Math.min(Math.max(0, options.fetchTopN), hits.length, visibleBound)
    if (count === 0) return [...hits]
    const head = hits.slice(0, count)
    const tail = hits.slice(count)
    let cursor = 0
    const workers = Array.from({ length: Math.min(PAGE_CONCURRENCY, count) }, async () => {
      for (;;) {
        const index = cursor
        cursor += 1
        const hit = head[index]
        if (index >= head.length || hit === undefined) return
        const page = await this.deps.fetchPage(hit.url, {
          ...signal === undefined ? {} : { signal },
          timeoutMs: options.fetchTimeoutMs,
          maxChars: options.maxSnippetChars,
        })
        if (page === undefined) continue
        const title = hit.title ?? page.title
        head[index] = {
          ...hit,
          url: page.url,
          ...title === undefined ? {} : { title },
          ...page.text.length === 0 ? {} : { snippet: page.text },
        }
      }
    })
    await Promise.all(workers)
    return [...head, ...tail]
  }

  /** Apply the selected model's order to the candidates, keeping fusion order on any failure. */
  private async order(
    query: string,
    hits: readonly RankedHit[],
    options: PrismSearchOptions,
    signal?: AbortSignal,
  ): Promise<RankedHit[]> {
    if (options.rerankProvider.length === 0 || options.rerankModel.length === 0) return [...hits]
    const count = Math.min(Math.max(1, options.maxRerankCandidates), hits.length)
    if (count < 2) return [...hits]
    const head = hits.slice(0, count)
    const permutation = await this.deps.rerank({
      query,
      hits: head,
      provider: options.rerankProvider,
      model: options.rerankModel,
      timeoutMs: options.rerankTimeoutMs,
      ...signal === undefined ? {} : { signal },
    })
    if (permutation === undefined || permutation.length !== head.length) return [...hits]
    const reordered = permutation
      .map(index => head[index])
      .filter((hit): hit is RankedHit => hit !== undefined)
    if (reordered.length === 0) return [...hits]
    return [...reordered, ...hits.slice(count)]
  }
}

/** Project one fused result onto the web service's source fields. */
function sourceOf(hit: RankedHit): WebSourceLike {
  return {
    url: hit.url,
    ...hit.title === undefined || hit.title.length === 0 ? {} : { title: hit.title },
    ...hit.snippet === undefined || hit.snippet.length === 0 ? {} : { snippet: hit.snippet },
    ...hit.publishedAt === undefined || hit.publishedAt.length === 0 ? {} : { publishedAt: hit.publishedAt },
  }
}

/** Throw the caller's cancellation reason before starting more work. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted !== true) return
  throw signal.reason instanceof Error ? signal.reason : new PrismSearchError('Prism Search was cancelled.', 'prism-search/aborted')
}
