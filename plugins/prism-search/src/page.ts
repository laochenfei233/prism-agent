/**
 * Page reading for the content stage: one HTML request, bounded bytes, readable
 * text, and the final URL after redirects (which resolves engine link wrappers).
 *
 * @module @prism/prism-search/page
 */

import { pageTitle, readPageText } from './html.ts'
import { DEFAULT_PAGE_MAX_BYTES, httpRequest, withTimeout } from './http.ts'
import type { FetchedPage } from './provider.ts'

/** Content types whose body yields readable text. */
const READABLE_TYPES = /^(?:text\/html|application\/xhtml\+xml|text\/plain)$/

/**
 * Fetch one result page and read its text.
 * @param url - result URL, possibly an engine redirect wrapper.
 * @param request - cancellation, time bound, and text cap.
 * @returns the final URL, title, and text, or undefined when the page is unusable.
 */
export async function fetchReadablePage(
  url: string,
  request: { readonly signal?: AbortSignal; readonly timeoutMs: number; readonly maxChars: number },
): Promise<FetchedPage | undefined> {
  try {
    const response = await httpRequest({
      url,
      maxBytes: DEFAULT_PAGE_MAX_BYTES,
      signal: withTimeout(request.signal, request.timeoutMs),
    })
    if (response.status < 200 || response.status >= 300) return undefined
    if (!READABLE_TYPES.test(response.contentType)) return undefined
    const text = readPageText(response.text, request.maxChars)
    if (text.length === 0) return undefined
    const title = pageTitle(response.text)
    return { url: response.url, ...title === undefined ? {} : { title }, text }
  } catch {
    // A page that cannot be read keeps the engine's own excerpt.
    return undefined
  }
}
