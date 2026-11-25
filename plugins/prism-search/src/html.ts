/**
 * Dependency-free HTML reading for search-engine pages: entity decoding, tag
 * stripping, anchor extraction, and readable page text. Engines answer with
 * markup this package does not control, so every helper here is tolerant of
 * truncated or reordered pages and never throws. Every reader walks the page
 * in one linear pass: the previous lazy-quantifier regexes spent quadratic
 * time on adversarial pages, which stalled the shared event loop.
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

/** One scanner segment: a run of text, a tag, a comment, or raw element content. */
interface HtmlSegment {
  readonly kind: 'text' | 'tag' | 'comment' | 'rawtext'
  /** The segment's raw markup, as written in the page. */
  readonly text: string
  /** Offset of the segment's first character. */
  readonly start: number
  /** Offset just past the segment. */
  readonly end: number
}

/** Elements whose content is dropped by the readable-text pass. */
const RAW_TEXT_ELEMENTS: readonly string[] = ['script', 'style', 'noscript', 'svg']

/** Closing tags that readPageText renders as line breaks. */
const BREAKING_TAG = /<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/section|\/article)[^>]*>/i

/** Whether the tag text opens `name` (`<name` followed by a non-name character). */
function opensTag(tag: string, name: string): boolean {
  if (!tag.toLowerCase().startsWith(`<${name}`)) return false
  const next = tag[name.length + 1]
  return next === undefined || !/[a-z0-9_]/.test(next)
}

/** Whether the tag text closes `name` (`</name` followed by a non-name character). */
function closesTag(tag: string, name: string): boolean {
  if (!tag.toLowerCase().startsWith(`</${name}`)) return false
  const next = tag[name.length + 2]
  return next === undefined || !/[a-z0-9_]/.test(next)
}

/**
 * Split the page into a linear run of segments, so every reader sees text,
 * tags, comments, and raw element content without backtracking.
 * @param html - page markup.
 * @returns the segments in document order.
 */
function scanSegments(html: string): HtmlSegment[] {
  const segments: HtmlSegment[] = []
  const lower = html.toLowerCase()
  let cursor = 0
  while (cursor < html.length) {
    const lt = lower.indexOf('<', cursor)
    if (lt === -1) {
      segments.push({ kind: 'text', text: html.slice(cursor), start: cursor, end: html.length })
      break
    }
    if (lt > cursor) segments.push({ kind: 'text', text: html.slice(cursor, lt), start: cursor, end: lt })
    if (lower.startsWith('<!--', lt)) {
      const close = lower.indexOf('-->', lt + 4)
      const end = close === -1 ? html.length : close + 3
      segments.push({ kind: 'comment', text: html.slice(lt, end), start: lt, end })
      cursor = end
      continue
    }
    const rawName = RAW_TEXT_ELEMENTS.find(name => opensTag(lower.slice(lt, lt + name.length + 2), name))
    if (rawName !== undefined) {
      const openerEnd = lower.indexOf('>', lt)
      if (openerEnd === -1) {
        // A truncated opener has no closer to find: the rest of the page is
        // one malformed tag.
        segments.push({ kind: 'tag', text: html.slice(lt), start: lt, end: html.length })
        break
      }
      const closer = lower.indexOf(`</${rawName}`, openerEnd)
      if (closer === -1) {
        // A truncated raw element keeps its content out of every reader.
        segments.push({ kind: 'tag', text: html.slice(lt, openerEnd + 1), start: lt, end: openerEnd + 1 })
        segments.push({ kind: 'rawtext', text: html.slice(openerEnd + 1), start: openerEnd + 1, end: html.length })
        break
      }
      const closerEnd = lower.indexOf('>', closer)
      const stop = closerEnd === -1 ? html.length : closerEnd + 1
      segments.push({ kind: 'tag', text: html.slice(lt, openerEnd + 1), start: lt, end: openerEnd + 1 })
      segments.push({ kind: 'rawtext', text: html.slice(openerEnd + 1, closer), start: openerEnd + 1, end: closer })
      segments.push({ kind: 'tag', text: html.slice(closer, stop), start: closer, end: stop })
      cursor = stop
      continue
    }
    const gt = lower.indexOf('>', lt)
    if (gt === -1) {
      // A stray `<` with no `>` stays literal, as the tag-strip regex did.
      segments.push({ kind: 'text', text: html.slice(lt, lt + 1), start: lt, end: lt + 1 })
      cursor = lt + 1
      continue
    }
    segments.push({ kind: 'tag', text: html.slice(lt, gt + 1), start: lt, end: gt + 1 })
    cursor = gt + 1
  }
  return segments
}

/** Remove markup, decode entities, and collapse whitespace. */
export function stripTags(html: string): string {
  let out = ''
  for (const segment of scanSegments(html)) {
    // Raw element content stays (only tags are removed), as the tag-strip regex did.
    out += segment.kind === 'tag' || segment.kind === 'comment' ? ' ' : decodeEntities(segment.text)
  }
  return out.replace(/\s+/g, ' ').trim()
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
 * Every anchor in the page, in document order. The first `</a>` closes an
 * anchor, and an anchor with no closer is never reported.
 * @param html - page markup.
 * @returns the anchors with stable offsets.
 */
export function anchors(html: string): Anchor[] {
  const found: Anchor[] = []
  let open: { readonly attrs: string; readonly start: number; inner: string } | undefined
  for (const segment of scanSegments(html)) {
    if (open === undefined) {
      if (segment.kind === 'tag' && opensTag(segment.text, 'a')) {
        open = { attrs: segment.text.slice(2, -1), start: segment.start, inner: '' }
      }
      continue
    }
    if (segment.kind === 'tag') {
      if (!closesTag(segment.text, 'a')) continue
      const href = attribute(open.attrs, 'href')
      if (href !== undefined && href.length > 0) {
        found.push({
          href: decodeEntities(href),
          attrs: open.attrs,
          text: stripTags(open.inner),
          start: open.start,
          end: segment.end,
        })
      }
      open = undefined
      continue
    }
    open.inner += segment.text
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
  let out = ''
  for (const segment of scanSegments(html)) {
    if (segment.kind === 'rawtext' || segment.kind === 'comment') {
      out += ' '
      continue
    }
    if (segment.kind === 'tag') {
      out += BREAKING_TAG.test(segment.text) ? '\n' : ' '
      continue
    }
    out += segment.text
  }
  const text = decodeEntities(out)
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
  return text.length <= limit ? text : text.slice(0, limit).trimEnd()
}

/**
 * The page's `<title>` text, when the page has one with a closer.
 * @param html - page markup.
 * @returns the title text or undefined.
 */
export function pageTitle(html: string): string | undefined {
  let open = false
  let closed = false
  let inner = ''
  for (const segment of scanSegments(html)) {
    if (segment.kind !== 'tag') {
      if (open) inner += segment.kind === 'rawtext' ? ' ' : segment.text
      continue
    }
    if (open) {
      if (closesTag(segment.text, 'title')) {
        closed = true
        break
      }
      // A nested tag between the title tags is markup, not title text.
      inner += ' '
      continue
    }
    open = opensTag(segment.text, 'title')
  }
  if (!open || !closed) return undefined
  const title = stripTags(inner)
  return title.length === 0 ? undefined : title
}

/** Whether the query contains CJK characters, which selects Chinese engine parameters. */
export function isCJK(text: string): boolean {
  return /[\u3000-\u9fff\uf900-\ufaff]/.test(text)
}
