/**
 * Per-Session user annotations: the record, the normalization every write and
 * import goes through, and the clipboard round-trip a model uses to draft
 * them. Persistence is the browser view store, so nothing here reaches the
 * Host, the Session log, or a model request.
 * @module @deepseek-ai/dsh-client-ui-workspace/src/client/annotations
 */

/** Priority scale shown in the editor; 1 is the most important. */
export type SessionPriority = 1 | 2 | 3 | 4 | 5

/** Priority of an annotation that never chose one. */
export const DEFAULT_PRIORITY: SessionPriority = 3

/** Tags kept per Session (the rest of the input is dropped). */
export const MAX_TAGS = 20

/** Longest tag kept, in JavaScript string units. */
export const MAX_TAG_LENGTH = 32

/** Longest note kept, in JavaScript string units. */
export const MAX_NOTE_LENGTH = 2000

/** The annotation filter choices: no filter, favorites only, review-later only. */
export type AnnotationFilter = 'all' | 'favorite' | 'reviewLater'

/** Empty annotation table; one shared identity keeps derivations memoized while nothing is annotated. */
export const NO_ANNOTATIONS: Readonly<Record<string, SessionAnnotation>> = {}

/** One Session's user annotation; every field is absent at its default. */
export interface SessionAnnotation {
  /** Marked for quick recall; independent of pin and archive. */
  favorite?: boolean
  /** Flagged as something the user still wants to revisit. */
  reviewLater?: boolean
  /** 1 (highest) through 5 (lowest); absent means {@link DEFAULT_PRIORITY}. */
  priority?: SessionPriority
  /** Trimmed, de-duplicated, capped tags in entry order. */
  tags?: readonly string[]
  /** Trimmed note, at most {@link MAX_NOTE_LENGTH} string units. */
  note?: string
}

/** An import rejected the clipboard text; `reason` is a diagnostic, not user copy. */
export class AnnotationImportError extends Error {
  /**
   * @param reason - why the text could not be read as an annotation.
   */
  constructor(reason: string) {
    super(reason)
    this.name = 'AnnotationImportError'
  }
}

/**
 * Split free-form tags on either comma spelling and normalize each one: trim,
 * drop empties, keep the first spelling of a case-insensitive duplicate, cap
 * length, and stop at {@link MAX_TAGS}.
 * @param input - raw tag text; `,` and `，` are both separators.
 * @returns normalized tags in entry order.
 */
export function parseTags(input: string): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const raw of input.split(/[,，]/)) {
    const tag = raw.trim().slice(0, MAX_TAG_LENGTH)
    if (tag === '') continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push(tag)
    if (tags.length === MAX_TAGS) break
  }
  return tags
}

/**
 * Render tags back into the editor's single-line form.
 * @param tags - stored tags, or nothing.
 * @returns comma-separated tags, or an empty string.
 */
export function formatTags(tags: readonly string[] | undefined): string {
  return (tags ?? []).join(', ')
}

/**
 * Normalize a note draft: trim, then cap at {@link MAX_NOTE_LENGTH}.
 * @param input - raw note text.
 * @returns the note, or undefined when nothing is left.
 */
export function normalizeNote(input: string): string | undefined {
  const note = input.trim().slice(0, MAX_NOTE_LENGTH)
  return note === '' ? undefined : note
}

/**
 * Whether an annotation carries nothing worth storing.
 * @param annotation - record to inspect.
 * @returns true when no field differs from its default.
 */
export function isEmptyAnnotation(annotation: SessionAnnotation): boolean {
  return annotation.favorite !== true
    && annotation.reviewLater !== true
    && (annotation.priority === undefined || annotation.priority === DEFAULT_PRIORITY)
    && (annotation.tags?.length ?? 0) === 0
    && annotation.note === undefined
}

/**
 * Structural equality, used to skip rewrites that would only re-render rows.
 * @param left - first record.
 * @param right - second record.
 * @returns true when both store the same values.
 */
export function sameAnnotation(left: SessionAnnotation, right: SessionAnnotation): boolean {
  return (left.favorite === true) === (right.favorite === true)
    && (left.reviewLater === true) === (right.reviewLater === true)
    && (left.priority ?? DEFAULT_PRIORITY) === (right.priority ?? DEFAULT_PRIORITY)
    && (left.note ?? '') === (right.note ?? '')
    && (left.tags ?? []).join('\u0000') === (right.tags ?? []).join('\u0000')
}

/**
 * Serialize an annotation in the exact fields the import reads, defaults
 * filled in, so the prompt and the import agree on one format.
 * @param annotation - record to publish.
 * @returns two-space JSON.
 */
export function annotationJson(annotation: SessionAnnotation): string {
  return JSON.stringify({
    favorite: annotation.favorite === true,
    reviewLater: annotation.reviewLater === true,
    priority: annotation.priority ?? DEFAULT_PRIORITY,
    tags: [...(annotation.tags ?? [])],
    note: annotation.note ?? '',
  }, null, 2)
}

/**
 * Fill the localized prompt template with this Session's title and current
 * annotation JSON.
 * @param template - locale text carrying `{title}` and `{json}`.
 * @param title - the Session's display title, verbatim.
 * @param annotation - current annotation to publish.
 * @returns the clipboard text.
 */
export function annotationPrompt(template: string, title: string, annotation: SessionAnnotation): string {
  return template.replaceAll('{title}', title).replaceAll('{json}', annotationJson(annotation))
}

/** Read one priority out of imported JSON, keeping only the documented scale. */
function importedPriority(value: unknown): SessionPriority {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
    ? value as SessionPriority
    : DEFAULT_PRIORITY
}

/** Editor fields before normalization: both checkbox states, a priority, and free-form text. */
export interface AnnotationDraft {
  favorite: boolean
  reviewLater: boolean
  priority: SessionPriority
  /** Raw tag text as typed; `,` and `，` are both separators. */
  tags: string
  /** Raw note text. */
  note: string
}

/**
 * Assemble the stored record from editor fields, applying every normalization
 * so the dialog and the clipboard import write the same values.
 * @param draft - the editor's raw fields.
 * @returns the annotation, with default-valued fields left out.
 */
export function composeAnnotation(draft: AnnotationDraft): SessionAnnotation {
  const annotation: SessionAnnotation = {}
  if (draft.favorite) annotation.favorite = true
  if (draft.reviewLater) annotation.reviewLater = true
  if (draft.priority !== DEFAULT_PRIORITY) annotation.priority = draft.priority
  const tags = parseTags(draft.tags)
  if (tags.length > 0) annotation.tags = tags
  const note = normalizeNote(draft.note)
  if (note !== undefined) annotation.note = note
  return annotation
}

/** Narrow parsed JSON to a plain object; arrays and primitives are not annotations. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a model's clipboard answer as an annotation. Accepts a Markdown code
 * fence, a leading byte-order mark, smart quotes, and chat text around the
 * object; unknown keys and mistyped fields are ignored rather than rejected.
 *
 * shortcut: only the first `{` through the last `}` of the text is parsed, so a
 * second object in the same block is ignored — split the import per Session if
 * that ever matters.
 * @param text - clipboard contents.
 * @returns the annotation the text describes.
 * @throws AnnotationImportError when no JSON object can be read.
 */
export function parseAnnotationImport(text: string): SessionAnnotation {
  const normalized = text.replace(/^\uFEFF/, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  const start = normalized.indexOf('{')
  const end = normalized.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new AnnotationImportError('no JSON object in the imported text')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(normalized.slice(start, end + 1))
  } catch (error) {
    throw new AnnotationImportError(`imported JSON is invalid: ${String(error)}`)
  }
  /* v8 ignore next 3 -- the slice opens with '{', so a successful parse is always an object */
  if (!isRecord(parsed)) {
    throw new AnnotationImportError('imported JSON is not an object')
  }
  const record = parsed
  const rawTags = record['tags']
  const rawNote = record['note']
  return composeAnnotation({
    favorite: record['favorite'] === true,
    reviewLater: record['reviewLater'] === true,
    priority: importedPriority(record['priority']),
    tags: Array.isArray(rawTags)
      ? rawTags.filter(tag => typeof tag === 'string').join(',')
      : typeof rawTags === 'string' ? rawTags : '',
    note: typeof rawNote === 'string' ? rawNote : '',
  })
}
