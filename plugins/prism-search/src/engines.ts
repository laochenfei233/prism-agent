/**
 * The keyless engine catalog: how to ask each of the eighteen supported search
 * engines and how to read its answer. HTML engines share one anchor harvester;
 * API engines parse their JSON.
 *
 * A spec never performs I/O. The provider runs the request with the deployment's
 * timeout and cancellation, so every parser stays a pure function of the body.
 *
 * @module @prism/prism-search/engines
 */

import { anchors, isCJK, stripTags, type Anchor } from './html.ts'
import { absoluteUrl, isAssetUrl, isHost, isHttpUrl, normalizeUrl, unwrapRedirect } from './urls.ts'

/** One result as an engine returned it. */
export interface EngineHit {
  /** Absolute destination URL, with the engine's redirect wrapper already removed. */
  readonly url: string
  /** Result title with markup removed. */
  readonly title?: string
  /** Engine-provided excerpt. */
  readonly snippet?: string
  /** Provider-supplied ISO-8601 timestamp, when the engine returns one. */
  readonly publishedAt?: string
}

/** One HTTP request an engine needs. */
export interface EngineRequest {
  /** Absolute request URL. */
  readonly url: string
  /** POST for form endpoints; GET otherwise. */
  readonly method?: 'GET' | 'POST'
  /** Form body for POST requests. */
  readonly body?: string
  /** Engine-specific headers merged over the browser defaults. */
  readonly headers?: Readonly<Record<string, string>>
}

/** One search engine. */
export interface EngineSpec {
  /** Stable engine id, recorded on every fused result. */
  readonly id: string
  /**
   * Build the request for one query.
   * @param query - the user's query.
   * @returns the request the provider sends.
   */
  build(query: string): EngineRequest
  /**
   * Read one engine answer.
   * @param body - decoded response body.
   * @param finalUrl - the response URL after redirects, used to resolve links.
   * @returns the engine's results in its own rank order.
   */
  parse(body: string, finalUrl: string): EngineHit[]
}

/** Results kept per engine before fusion; more than the seam's cap so fusion has material. */
const PER_ENGINE_LIMIT = 10

/** Chinese locale parameters for queries that contain CJK text. */
function locale(query: string): { readonly language: string; readonly region: string } {
  return isCJK(query)
    ? { language: 'zh-CN', region: 'zh-CN' }
    : { language: 'en', region: 'en-US' }
}

/** One result anchor filter for engines whose markup marks its result links. */
interface HarvestOptions {
  /** Page URL used to resolve relative links. */
  readonly base: string
  /** Extra per-anchor filter; default accepts every anchor. */
  readonly pick?: (anchor: Anchor) => boolean
  /** Hosts that never carry a result destination (the engine itself). */
  readonly skipHosts?: readonly string[]
  /** Minimum title length; drops navigation and icon links. */
  readonly minTitle?: number
  /** Maximum excerpt length taken from the text after the link. */
  readonly maxSnippet?: number
}

/**
 * Read a result page through its anchors: resolve and unwrap each destination,
 * drop engine navigation, asset files, and duplicates, and take the text that
 * follows the link as the excerpt.
 * @param html - result page markup.
 * @param options - link filter, excluded hosts, and text bounds.
 * @returns up to {@link PER_ENGINE_LIMIT} results in document order.
 */
export function harvest(html: string, options: HarvestOptions): EngineHit[] {
  const found = anchors(html)
  const skipHosts = new Set(options.skipHosts ?? [])
  const minTitle = options.minTitle ?? 6
  const maxSnippet = options.maxSnippet ?? 280
  const seen = new Set<string>()
  const candidates: { anchor: Anchor; url: string; title: string }[] = []
  for (const anchor of found) {
    if (options.pick !== undefined && !options.pick(anchor)) continue
    const title = anchor.text.trim()
    if (title.length < minTitle || title.length > 300) continue
    const absolute = absoluteUrl(anchor.href, options.base)
    if (absolute === undefined) continue
    const url = unwrapRedirect(absolute)
    if (!isHttpUrl(url) || isAssetUrl(url)) continue
    if (skipHosts.size > 0 && isHost(url, skipHosts)) continue
    const key = normalizeUrl(url)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ anchor, url, title })
    if (candidates.length >= PER_ENGINE_LIMIT) break
  }
  return candidates.map(({ anchor, url, title }, index) => {
    // The excerpt is the text between this result's link and the next substantial
    // link, so navigation and site-link anchors do not cut it short.
    const nextStart = candidates[index + 1]?.anchor.start ?? html.length
    const snippet = stripTags(html.slice(anchor.end, Math.min(anchor.end + 900, nextStart))).slice(0, maxSnippet).trim()
    return { url, title, ...snippet.length === 0 ? {} : { snippet } }
  })
}

/** Parse a JSON body, yielding undefined for an HTML error or captcha page. */
function jsonBody(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    // Engines answer a blocked request with HTML; that body has no results.
    return undefined
  }
}

/** Narrow a JSON value to an object. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Narrow a JSON value to an array. */
function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

/** A non-empty string member. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** The first non-empty string among several candidates. */
function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    const text = stringOf(value)
    if (text !== undefined) return text
  }
  return undefined
}

/** A finite number member. */
function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** An ISO-8601 timestamp from a Unix epoch given in seconds. */
function isoFromSeconds(value: unknown): string | undefined {
  const seconds = numberOf(value)
  return seconds === undefined ? undefined : new Date(seconds * 1000).toISOString()
}

/** The engine list, in the order results are requested. */
export const ENGINE_SPECS: readonly EngineSpec[] = [
  {
    id: 'google',
    build: (query) => ({
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}&num=20&hl=${locale(query).language}`,
    }),
    parse: (html, base) => harvest(html, { base, skipHosts: ['google.com'] }),
  },
  {
    id: 'bing',
    build: (query) => ({
      url: `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=20&mkt=${locale(query).region}`,
    }),
    parse: (html, base) => harvest(html, { base, skipHosts: ['bing.com'] }),
  },
  {
    id: 'duckduckgo',
    build: (query) => ({
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=${isCJK(query) ? 'cn-zh' : 'us-en'}`,
    }),
    parse: (html, base) => harvest(html, { base, pick: anchor => /result__a/.test(anchor.attrs), skipHosts: ['duckduckgo.com'] }),
  },
  {
    id: 'brave',
    build: (query) => ({ url: `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web` }),
    parse: (html, base) => harvest(html, { base, skipHosts: ['brave.com'] }),
  },
  {
    id: 'startpage',
    build: (query) => ({ url: `https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}` }),
    parse: (html, base) => harvest(html, { base, skipHosts: ['startpage.com'] }),
  },
  {
    id: 'yahoo',
    build: (query) => ({ url: `https://search.yahoo.com/search?p=${encodeURIComponent(query)}&n=20` }),
    parse: (html, base) => harvest(html, { base, skipHosts: ['yahoo.com'] }),
  },
  {
    id: 'yandex',
    build: (query) => ({ url: `https://yandex.com/search/?text=${encodeURIComponent(query)}` }),
    parse: (html, base) => harvest(html, { base, skipHosts: ['yandex.com', 'yandex.ru', 'yandex.net'] }),
  },
  {
    id: 'mojeek',
    build: (query) => ({ url: `https://www.mojeek.com/search?q=${encodeURIComponent(query)}` }),
    parse: (html, base) => harvest(html, { base, skipHosts: ['mojeek.com'] }),
  },
  {
    id: 'marginalia',
    build: (query) => ({ url: `https://search.marginalia.nu/search?query=${encodeURIComponent(query)}` }),
    parse: (html, base) => harvest(html, { base, skipHosts: ['marginalia.nu'] }),
  },
  {
    id: 'qwant',
    build: (query) => ({
      url: `https://api.qwant.com/v3/search/web?q=${encodeURIComponent(query)}&count=${PER_ENGINE_LIMIT}&locale=${isCJK(query) ? 'zh_CN' : 'en_US'}&offset=0&device=desktop&safesearch=1`,
      headers: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    }),
    parse: (body) => {
      const items = arrayOf(objectOf(objectOf(objectOf(jsonBody(body))?.['data'])?.['result'])?.['items'])
      const hits: EngineHit[] = []
      for (const item of items) {
        const entry = objectOf(item)
        const url = firstString(entry?.['url'], entry?.['link'])
        const title = firstString(entry?.['title'], entry?.['name'])
        if (url === undefined || title === undefined || !isHttpUrl(url)) continue
        const snippet = stringOf(entry?.['desc']) ?? stringOf(entry?.['description'])
        const publishedAt = firstString(entry?.['date'], entry?.['published_at'])
        hits.push({
          url,
          title: stripTags(title),
          ...snippet === undefined ? {} : { snippet: stripTags(snippet) },
          ...publishedAt === undefined ? {} : { publishedAt },
        })
        if (hits.length >= PER_ENGINE_LIMIT) break
      }
      return hits
    },
  },
  {
    id: 'baidu',
    build: (query) => ({ url: `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=20` }),
    parse: (html, base) => harvest(html, { base, pick: anchor => /^https?:\/\/www\.baidu\.com\/link\?/.test(anchor.href) || anchor.href.startsWith('/link?') }),
  },
  {
    id: 'sogou',
    build: (query) => ({ url: `https://www.sogou.com/web?query=${encodeURIComponent(query)}` }),
    parse: (html, base) => harvest(html, { base, pick: anchor => /^\/link\?url=/.test(anchor.href) || /sogou\.com\/link\?url=/.test(anchor.href) }),
  },
  {
    id: 'so360',
    build: (query) => ({ url: `https://www.so.com/s?q=${encodeURIComponent(query)}` }),
    parse: (html, base) => harvest(html, { base, pick: anchor => /^https?:\/\/www\.so\.com\/link\?/.test(anchor.href) || anchor.href.startsWith('/link?') }),
  },
  {
    id: 'bilibili',
    build: (query) => ({
      url: `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}&page=1`,
      headers: { accept: 'application/json', referer: 'https://www.bilibili.com/' },
    }),
    parse: (body) => {
      const items = arrayOf(objectOf(objectOf(jsonBody(body))?.['data'])?.['result'])
      const hits: EngineHit[] = []
      for (const item of items) {
        const entry = objectOf(item)
        const url = stringOf(entry?.['arcurl'])
        const title = stringOf(entry?.['title'])
        if (url === undefined || title === undefined || !isHttpUrl(url)) continue
        const snippet = stringOf(entry?.['description'])
        const publishedAt = isoFromSeconds(entry?.['pubdate'])
        hits.push({
          url,
          title: stripTags(title),
          ...snippet === undefined ? {} : { snippet: stripTags(snippet) },
          ...publishedAt === undefined ? {} : { publishedAt },
        })
        if (hits.length >= PER_ENGINE_LIMIT) break
      }
      return hits
    },
  },
  {
    id: 'wikipedia',
    build: (query) => ({
      url: `https://${isCJK(query) ? 'zh' : 'en'}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${PER_ENGINE_LIMIT}&srprop=snippet%7Ctimestamp&srsearch=${encodeURIComponent(query)}`,
      headers: { accept: 'application/json' },
    }),
    parse: (body, finalUrl) => {
      const host = new URL(finalUrl).hostname.split('.')[0] ?? 'en'
      const items = arrayOf(objectOf(objectOf(jsonBody(body))?.['query'])?.['search'])
      const hits: EngineHit[] = []
      for (const item of items) {
        const entry = objectOf(item)
        const title = stringOf(entry?.['title'])
        if (title === undefined) continue
        const snippet = stringOf(entry?.['snippet'])
        const publishedAt = stringOf(entry?.['timestamp'])
        hits.push({
          url: `https://${host}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
          title,
          ...snippet === undefined ? {} : { snippet: stripTags(snippet) },
          ...publishedAt === undefined ? {} : { publishedAt },
        })
        if (hits.length >= PER_ENGINE_LIMIT) break
      }
      return hits
    },
  },
  {
    id: 'github',
    build: (query) => ({
      url: `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${PER_ENGINE_LIMIT}&sort=stars&order=desc`,
      headers: { accept: 'application/vnd.github+json' },
    }),
    parse: (body) => {
      const items = arrayOf(objectOf(jsonBody(body))?.['items'])
      const hits: EngineHit[] = []
      for (const item of items) {
        const entry = objectOf(item)
        const url = firstString(entry?.['html_url'])
        const title = firstString(entry?.['full_name'], entry?.['name'])
        if (url === undefined || title === undefined || !isHttpUrl(url)) continue
        const snippet = stringOf(entry?.['description'])
        const publishedAt = stringOf(entry?.['pushed_at'])
        hits.push({
          url,
          title,
          ...snippet === undefined ? {} : { snippet },
          ...publishedAt === undefined ? {} : { publishedAt },
        })
        if (hits.length >= PER_ENGINE_LIMIT) break
      }
      return hits
    },
  },
  {
    id: 'hackernews',
    build: (query) => ({
      url: `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${PER_ENGINE_LIMIT}&tags=story`,
      headers: { accept: 'application/json' },
    }),
    parse: (body) => {
      const items = arrayOf(objectOf(jsonBody(body))?.['hits'])
      const hits: EngineHit[] = []
      for (const item of items) {
        const entry = objectOf(item)
        const title = firstString(entry?.['title'], entry?.['story_title'])
        const url = firstString(entry?.['url'], entry?.['story_url'])
          ?? (stringOf(entry?.['objectID']) === undefined ? undefined : `https://news.ycombinator.com/item?id=${String(entry?.['objectID'])}`)
        if (url === undefined || title === undefined || !isHttpUrl(url)) continue
        const snippet = stringOf(entry?.['story_text']) ?? stringOf(entry?.['comment_text'])
        const publishedAt = firstString(entry?.['created_at'])
        hits.push({
          url,
          title,
          ...snippet === undefined ? {} : { snippet: stripTags(snippet) },
          ...publishedAt === undefined ? {} : { publishedAt },
        })
        if (hits.length >= PER_ENGINE_LIMIT) break
      }
      return hits
    },
  },
  {
    id: 'stackexchange',
    build: (query) => ({
      url: `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&pagesize=${PER_ENGINE_LIMIT}&site=stackoverflow&q=${encodeURIComponent(query)}`,
      headers: { accept: 'application/json' },
    }),
    parse: (body) => {
      const items = arrayOf(objectOf(jsonBody(body))?.['items'])
      const hits: EngineHit[] = []
      for (const item of items) {
        const entry = objectOf(item)
        const url = stringOf(entry?.['link'])
        const title = stringOf(entry?.['title'])
        if (url === undefined || title === undefined || !isHttpUrl(url)) continue
        const tags = arrayOf(entry?.['tags']).map(tag => stringOf(tag)).filter((tag): tag is string => tag !== undefined)
        const publishedAt = isoFromSeconds(entry?.['creation_date'])
        hits.push({
          url,
          title: stripTags(title),
          ...tags.length === 0 ? {} : { snippet: tags.join(' ') },
          ...publishedAt === undefined ? {} : { publishedAt },
        })
        if (hits.length >= PER_ENGINE_LIMIT) break
      }
      return hits
    },
  },
]
