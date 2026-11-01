/**
 * Host half of Prism Search: register one keyless `ctx.web` search provider
 * (eighteen engines, RRF fusion, page text, model ordering). It adds no tool,
 * no route, and no Session surface; the existing `web_search` tool calls it
 * once the deployment selects the `prism-search` provider.
 *
 * Page text comes from `ctx.web.fetch`, so this plugin inherits the deployment's
 * fetch policy (public-address validation, redirect rules, configured provider)
 * instead of opening its own connections to URLs taken from engine HTML.
 *
 * The Host services this half uses are read structurally (`ctx.get`), so the
 * package ships without workspace type dependencies and the Loader resolves the
 * row on any profile that mounts the web bundle.
 *
 * @module @prism/prism-search
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveOptions } from './config.ts'
import { ENGINE_SPECS } from './engines.ts'
import { pageTitle, readPageText } from './html.ts'
import { httpRequest, withTimeout } from './http.ts'
import { PrismSearchProvider } from './provider.ts'
import type { FetchedPage } from './provider.ts'
import { rerankOrder, type LlmStreamRequest } from './rerank.ts'

export { Config, resolveOptions } from './config.ts'
export type { Config as ConfigShape } from './config.ts'
export { ENGINE_SPECS } from './engines.ts'
export type { EngineHit, EngineRequest, EngineSpec } from './engines.ts'
export { fuse, RRF_K } from './fusion.ts'
export type { EngineAnswer, RankedHit } from './fusion.ts'
export { BROWSER_USER_AGENT, httpRequest } from './http.ts'
export type { HttpRequest, HttpResponse } from './http.ts'
export { DEFAULT_RESULT_LIMIT, PrismSearchError, PrismSearchProvider, PROVIDER_ID } from './provider.ts'
export type { FetchedPage, PageFetcher, PrismSearchDeps, PrismSearchOptions } from './provider.ts'
export { buildRerankPrompt, parseOrderAnswer, rerankOrder } from './rerank.ts'
export type { LlmStream, LlmStreamRequest, RerankDeps, RerankRequest, Reranker } from './rerank.ts'

/** Cordis plugin name, matching the `cordis.patch.yml` row id. */
export const name = 'prism-search'

/** The web seam this plugin contributes its search provider to. */
export const inject = ['web']

/** The web service's answer to one fetch. */
interface WebFetchResultLike {
  /** Final URL after allowed redirects. */
  readonly url: string
  /** HTTP status code. */
  readonly statusCode: number
  /** Decoded body, classified by content kind. */
  readonly body: { readonly kind: 'html' | 'text'; readonly content: string }
}

/** Structural view of the web service. */
interface WebService {
  /**
   * Register the search provider.
   * @param provider - the search provider to register.
   * @returns the disposer that unregisters it.
   */
  registerSearchProvider(provider: PrismSearchProvider): () => void
  /**
   * Retrieve one URL through the deployment's fetch provider.
   * @param request - target URL.
   * @param signal - cancellation for this retrieval.
   * @returns the fetched body.
   */
  fetch(request: { readonly url: string }, signal?: AbortSignal): Promise<WebFetchResultLike>
}

/** Structural view of the LLM service's streaming call. */
interface LlmService {
  /**
   * Start one streaming model request.
   * @param request - provider, model, messages, limits, and cancellation.
   * @returns the streamed chunks.
   */
  stream(request: LlmStreamRequest): AsyncIterable<unknown>
}

/**
 * Register the search provider with the web service.
 * @param ctx - host context carrying the web and LLM services.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const web = ctx.get('web') as WebService | undefined
  if (web === undefined) throw new Error('prism-search: the web service is required to register the search provider')

  const provider = new PrismSearchProvider({
    engines: ENGINE_SPECS,
    http: httpRequest,
    fetchPage: async (url, request): Promise<FetchedPage | undefined> => {
      try {
        const page = await web.fetch({ url }, withTimeout(request.signal, request.timeoutMs))
        if (page.statusCode < 200 || page.statusCode >= 300) return undefined
        const text = page.body.kind === 'html'
          ? readPageText(page.body.content, request.maxChars)
          : page.body.content.slice(0, request.maxChars).trim()
        if (text.length === 0) return undefined
        const title = page.body.kind === 'html' ? pageTitle(page.body.content) : undefined
        return { url: page.url, ...title === undefined ? {} : { title }, text }
      } catch {
        // A page the fetch seam refuses or cannot read keeps the engine's excerpt.
        return undefined
      }
    },
    rerank: async (rerankRequest) => {
      // The LLM service is optional at search time: without it the fused order stands.
      const llm = ctx.get('llm') as LlmService | undefined
      if (llm === undefined) return undefined
      return rerankOrder(rerankRequest, { stream: options => llm.stream(options) })
    },
    options: () => resolveOptions(config),
  })
  ctx.effect(() => web.registerSearchProvider(provider), 'prism-search: web search provider')
}
