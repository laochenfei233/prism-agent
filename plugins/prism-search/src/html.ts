/**
 * Dependency-free HTML reading for search-engine pages: entity decoding, tag
 * stripping, anchor extraction, and readable page text. Engines answer with
 * markup this package does not control, so every helper here is tolerant of
 * truncated or reordered pages and never throws.
 *
 * @module @prism/prism-search/html
 */

/** Named entities common enough to matter in titles and snippets. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  middot: '·',
  copy: '©',
  reg: '®',
  times: '×',
}

/** Replace numeric and the common named HTML entities. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match: string, body: string): string => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/** Remove markup, decode entities, and collapse whitespace. */
export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/** One anchor found in a page, with the offsets of its markup. */
export interface Anchor {
  /** Resolved `href` attribute, still markup-encoded. */
  readonly href: string
  /** The anchor's raw attribute text, used by per-engine link markers. */
  readonly attrs: string
  /** Visible anchor text with markup removed. */
  readonly text: string
  /** Offset of the opening `<a`. */
  readonly start: number
  /** Offset just past the closing `</a>`. */
  readonly end: number
}

/**
 * Every anchor in the page, in document order.
 * @param html - page markup.
 * @returns the anchors with stable offsets.
 */
export function anchors(html: string): Anchor[] {
  const found: Anchor[] = []
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const attrs = match[1] ?? ''
    const href = attribute(attrs, 'href')
    if (href === undefined || href.length === 0) continue
    found.push({
      href: decodeEntities(href),
      attrs,
      text: stripTags(match[2] ?? ''),
      start: match.index,
      end: pattern.lastIndex,
    })
  }
  return found
}

/** Read one attribute value from an opening tag's attribute text. */
function attribute(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = pattern.exec(attrs)
  if (match === null) return undefined
  return match[1] ?? match[2] ?? match[3]
}

/**
 * The readable text of a page: scripts, styles, comments, and tags removed,
 * whitespace collapsed, capped at `limit` characters.
 * @param html - page markup.
 * @param limit - maximum returned characters.
 * @returns the page text, possibly empty.
 */
export function readPageText(html: string, limit: number): string {
  const withoutHidden = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  const text = decodeEntities(
    withoutHidden
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/section|\/article)[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return text.length <= limit ? text : text.slice(0, limit).trimEnd()
}

/**
 * The page's `<title>` text, when the page has one.
 * @param html - page markup.
 * @returns the title text or undefined.
 */
export function pageTitle(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (match === null) return undefined
  const title = stripTags(match[1] ?? '')
  return title.length === 0 ? undefined : title
}

/** Whether the query contains CJK characters, which selects Chinese engine parameters. */
export function isCJK(text: string): boolean {
  return /[\u3000-\u9fff\uf900-\ufaff]/.test(text)
}
