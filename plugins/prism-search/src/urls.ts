/**
 * URL handling for search results: absolute resolution, engine redirect
 * unwrapping, and the normalized identity used to deduplicate one result
 * returned by several engines.
 *
 * @module @prism/prism-search/urls
 */

/** Query parameters that only track the click, never the destination. */
const TRACKING_PARAMETERS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'spm', 'from', 'ref', 'ref_src', 'ref_url', 'source', 's',
])

/** File extensions that are never a search result page. */
const ASSET_EXTENSIONS = /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|ico|webp|bmp|woff2?|ttf|eot|mp4|mp3|zip|gz)$/i

/**
 * Resolve a possibly relative link against the page it came from.
 * @param href - the link as written in the page.
 * @param base - the page's final URL.
 * @returns the absolute URL, or undefined when it cannot be resolved.
 */
export function absoluteUrl(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).href
  } catch {
    // A malformed href is markup this reader cannot use; the caller skips it.
    return undefined
  }
}

/**
 * Whether a URL uses an HTTP(S) scheme.
 * @param url - candidate URL.
 * @returns true for http: and https: only.
 */
export function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://')
}

/**
 * Whether a URL points at a static asset rather than a result page.
 * @param url - candidate URL.
 * @returns true when its path ends in a known asset extension.
 */
export function isAssetUrl(url: string): boolean {
  try {
    return ASSET_EXTENSIONS.test(new URL(url).pathname)
  } catch {
    // An unparsable value cannot be fetched, so treating it as an asset drops it.
    return true
  }
}

/**
 * Whether the URL's host is one of the excluded hosts or a subdomain of one.
 * @param url - candidate URL.
 * @param hosts - registrable hosts such as `google.com`.
 * @returns true when the host matches.
 */
export function isHost(url: string, hosts: ReadonlySet<string>): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    for (const excluded of hosts) {
      if (host === excluded || host.endsWith(`.${excluded}`)) return true
    }
    return false
  } catch {
    // Unparsable URL: no host to compare, so it is not excluded here.
    return false
  }
}

/**
 * The deduplication identity of a result URL: lower-case host without `www.`,
 * fragment and tracking parameters removed, trailing slash removed.
 * @param url - result URL.
 * @returns the normalized key, or the input when it cannot be parsed.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.has(key.toLowerCase())) parsed.searchParams.delete(key)
    }
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '')
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    return parsed.href
  } catch {
    // Keep an unparsable URL distinct instead of merging every malformed value.
    return url
  }
}

/**
 * Follow one engine's own redirect wrapper to the destination it encodes.
 * DuckDuckGo (`uddg`), Google (`/url?q=`), Bing (`/ck/a` with base64url `u`),
 * and Yahoo (`/RU=`) wrap every result link this way.
 * @param url - absolute anchor target.
 * @returns the decoded destination, or the input when it is not a known wrapper.
 */
export function unwrapRedirect(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // Not a URL at all: nothing to unwrap.
    return url
  }
  const host = parsed.hostname.toLowerCase()
  if (host.endsWith('duckduckgo.com')) {
    const target = parsed.searchParams.get('uddg')
    if (target !== null && target.length > 0) return target
  }
  if (host.endsWith('google.com') && parsed.pathname === '/url') {
    const target = parsed.searchParams.get('q') ?? parsed.searchParams.get('url')
    if (target !== null && target.length > 0) return target
  }
  if (host.endsWith('bing.com') && parsed.pathname.startsWith('/ck/a')) {
    const encoded = parsed.searchParams.get('u')
    if (encoded !== null && encoded.startsWith('a1')) {
      const decoded = decodeBase64Url(encoded.slice(2))
      if (decoded !== undefined) return decoded
    }
  }
  if (host === 'r.search.yahoo.com') {
    const target = /\/RU=([^/]+)\//.exec(parsed.pathname)?.[1]
    if (target !== undefined) {
      try {
        return decodeURIComponent(target)
      } catch {
        // A partially encoded destination is still the destination.
        return target
      }
    }
  }
  return url
}

/** Decode a base64url payload into an HTTP URL, when it is one. */
function decodeBase64Url(value: string): string | undefined {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    return isHttpUrl(decoded) ? decoded : undefined
  } catch {
    // Invalid base64 is an engine payload this reader cannot decode.
    return undefined
  }
}
