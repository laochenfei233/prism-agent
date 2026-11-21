/**
 * Engine wrapper resolution. Baidu, Sogou, and 360 return opaque `/link?...`
 * destinations that only their own redirect reveals. The probe contacts the
 * engine host alone with redirects unfollowed, and the revealed destination is
 * then fetched through the web seam, so the deployment's address policy still
 * decides what may be read.
 *
 * @module @prism/prism-search/redirect
 */

import { httpRequest, withTimeout, type HttpRequest } from './http.ts'
import { absoluteUrl, isHttpUrl } from './urls.ts'

/** Hosts whose `/link` endpoints wrap a destination this reader cannot decode. */
const WRAPPER_HOSTS: readonly string[] = ['baidu.com', 'sogou.com', 'so.com']

/** Body bound for a redirect probe; a wrapper answers with headers and no useful body. */
const PROBE_MAX_BYTES = 64_000

/** One probe's cancellation and deadline. */
export interface WrapperRequest {
  /** The surrounding search's cancellation. */
  readonly signal?: AbortSignal
  /** Deadline for the probe. */
  readonly timeoutMs: number
}

/**
 * The wrapper host a URL belongs to, when it is one of the known engines.
 * @param url - result URL.
 * @returns the matching wrapper host, or undefined for an ordinary result URL.
 */
export function wrapperHostOf(url: string): string | undefined {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    // Not a URL, so it cannot be an engine wrapper.
    return undefined
  }
  return WRAPPER_HOSTS.find(candidate => host === candidate || host.endsWith(`.${candidate}`))
}

/**
 * Ask one engine wrapper where it points, without following the redirect.
 * @param url - the wrapper URL taken from the engine's result page.
 * @param request - the surrounding cancellation and deadline.
 * @param http - transport; defaults to the browser-like HTTP client.
 * @returns the HTTP(S) destination, or undefined when the wrapper answers nothing usable.
 */
export async function resolveEngineRedirect(
  url: string,
  request: WrapperRequest,
  http: (request: HttpRequest) => Promise<{ readonly location?: string }> = httpRequest,
): Promise<string | undefined> {
  if (wrapperHostOf(url) === undefined) return undefined
  try {
    const response = await http({
      url,
      redirect: 'manual',
      maxBytes: PROBE_MAX_BYTES,
      signal: withTimeout(request.signal, request.timeoutMs),
    })
    const location = response.location
    if (location === undefined) return undefined
    const target = absoluteUrl(location, url)
    if (target === undefined || !isHttpUrl(target) || wrapperHostOf(target) !== undefined) return undefined
    return target
  } catch {
    // A wrapper that cannot be probed keeps its own URL and the engine excerpt.
    return undefined
  }
}
