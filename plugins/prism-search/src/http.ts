/**
 * The HTTP boundary for engines and page fetching: one browser-like request,
 * a bounded body read, and a combined cancellation/timeout signal.
 *
 * @module @prism/prism-search/http
 */

/** Browser user agent; every keyless engine rejects or degrades a bare Node client. */
export const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Default body cap for one engine response. */
export const DEFAULT_ENGINE_MAX_BYTES = 2_000_000

/** Default body cap for one fetched page. */
export const DEFAULT_PAGE_MAX_BYTES = 4_000_000

/** One outbound request. */
export interface HttpRequest {
  /** Absolute request URL. */
  readonly url: string
  /** HTTP method; GET unless an engine's form endpoint requires POST. */
  readonly method?: 'GET' | 'POST'
  /** Form body for POST requests. */
  readonly body?: string
  /** Extra headers merged over the browser defaults. */
  readonly headers?: Readonly<Record<string, string>>
  /** Body cap in bytes. */
  readonly maxBytes?: number
  /** Cancellation for this request, already carrying its timeout. */
  readonly signal?: AbortSignal
}

/** One response after decoding. */
export interface HttpResponse {
  /** Final URL after redirects. */
  readonly url: string
  /** HTTP status code. */
  readonly status: number
  /** Response `content-type`, lower-case, without parameters. */
  readonly contentType: string
  /** Decoded body, capped at the request's byte bound. */
  readonly text: string
}

/**
 * Perform one request and read a bounded body.
 * @param request - URL, method, headers, body, byte bound, and signal.
 * @returns the final URL, status, content type, and decoded text.
 * @throws the underlying fetch failure or abort reason.
 */
export async function httpRequest(request: HttpRequest): Promise<HttpResponse> {
  const response = await fetch(request.url, {
    method: request.method ?? 'GET',
    redirect: 'follow',
    headers: {
      'user-agent': BROWSER_USER_AGENT,
      'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...request.headers,
    },
    ...request.body === undefined ? {} : { body: request.body },
    ...request.signal === undefined ? {} : { signal: request.signal },
  })
  const text = await readCapped(response, request.maxBytes ?? DEFAULT_ENGINE_MAX_BYTES)
  return {
    // A response constructed without a URL (a stub or an in-memory answer)
    // reports none; the request URL is then the only base relative links have.
    url: response.url.length === 0 ? request.url : response.url,
    status: response.status,
    contentType: (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '',
    text,
  }
}

/** Read a response body up to `maxBytes`, cancelling the stream at the bound. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      text += decoder.decode(value, { stream: true })
      if (received >= maxBytes) {
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  return text + decoder.decode()
}

/**
 * Combine the caller's signal with a per-request timeout.
 * @param signal - the surrounding search's signal, when it has one.
 * @param timeoutMs - this request's own time bound.
 * @returns a signal that aborts on either.
 */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}
