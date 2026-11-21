/**
 * Browser client for the wiki routes: one typed request per operation, with
 * every response narrowed at this wire boundary before the page renders it.
 * Requests are document-relative so a host mount prefix keeps working.
 * @module @prism/prism-wiki/src/client/api
 */

import type {
  WikiFrontmatter, WikiLintFinding, WikiLintKind, WikiLintReport, WikiPagePath, WikiPageStatus,
  WikiPageType, WikiSearchHit,
} from '../types.ts'
import type {
  WikiLintValue, WikiListValue, WikiPagePayload, WikiPageSummary, WikiReadRequest, WikiReadValue, WikiResponse,
  WikiSaveRequest, WikiSaveValue, WikiSearchRequest, WikiSearchValue, WikiSourceRequest, WikiSourceValue,
} from '../web-contract.ts'

/** Path prefix below `/api` every request of this client addresses. */
const BASE = 'api/prism-wiki'

/** Every page kind the wire vocabulary carries. */
const PAGE_TYPES: readonly WikiPageType[] = [
  'overview', 'entity', 'concept', 'source', 'comparison', 'synthesis',
]

/** Every page state the wire vocabulary carries. */
const PAGE_STATUSES: readonly WikiPageStatus[] = ['current', 'stub', 'superseded', 'disputed']

/** Every lint-finding class the wire vocabulary carries. */
const LINT_KINDS: readonly WikiLintKind[] = [
  'orphan-page', 'broken-link', 'missing-page', 'unintegrated-source', 'missing-source', 'frontmatter',
  'contradiction',
]

/** One wiki operation failed; `code` names the failing layer. */
export class WikiRequestError extends Error {
  /**
   * @param code - Host failure code, or the client-side validation code.
   * @param message - Operator-readable failure text.
   * @param current - The stored page, present when a revision conflict refused a save.
   */
  constructor(readonly code: string, message: string, readonly current?: WikiPagePayload) {
    super(message)
    this.name = 'WikiRequestError'
  }
}

/** Wiki operations the page calls, each resolving to a narrowed value. */
export interface WikiApi {
  /** Read every page in the vault. */
  readonly list: (signal?: AbortSignal) => Promise<WikiListValue>
  /** Read one page together with its links, backlinks, and cited sources. */
  readonly read: (request: WikiReadRequest, signal?: AbortSignal) => Promise<WikiReadValue>
  /** Rank the pages one literal query matches. */
  readonly search: (request: WikiSearchRequest, signal?: AbortSignal) => Promise<WikiSearchValue>
  /** Create or replace one page, refusing a stale `expectedRevision`. */
  readonly save: (request: WikiSaveRequest, signal?: AbortSignal) => Promise<WikiSaveValue>
  /** Read a bounded slice of one raw source. */
  readonly source: (request: WikiSourceRequest, signal?: AbortSignal) => Promise<WikiSourceValue>
  /** Run the vault health pass. */
  readonly lint: (signal?: AbortSignal) => Promise<WikiLintValue>
}

/** Build the failure for a host response this client cannot read. */
function invalidResponse(subject: string): WikiRequestError {
  return new WikiRequestError('prism-wiki/invalid-response', `the host answered with an invalid ${subject}`)
}

/**
 * Whether one decoded value is this plugin's response envelope.
 * @param value - decoded JSON value.
 * @returns true for either arm of the envelope.
 */
function isEnvelope(value: unknown): value is WikiResponse<unknown> {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.ok === true) return 'value' in record
  if (record.ok !== false || typeof record.error !== 'object' || record.error === null) return false
  const error = record.error as Record<string, unknown>
  return typeof error.code === 'string' && typeof error.message === 'string'
}

/**
 * Read one named field from a decoded value.
 * @param value - decoded host value.
 * @param field - field the operation's value carries.
 * @returns the field value.
 */
function readField(value: unknown, field: string): unknown {
  if (typeof value !== 'object' || value === null || !(field in value)) throw invalidResponse(field)
  return (value as Record<string, unknown>)[field]
}

/**
 * Whether one decoded value is a member of a closed string union.
 * @param value - decoded JSON value.
 * @param allowed - every member of that union.
 * @returns true when the value is one of the members.
 */
function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && allowed.some(entry => entry === value)
}

/**
 * Read one required string field.
 * @param value - decoded host value.
 * @param field - field the operation's value carries.
 * @returns the field text.
 */
function stringField(value: unknown, field: string): string {
  const read = readField(value, field)
  if (typeof read !== 'string') throw invalidResponse(field)
  return read
}

/**
 * Read one required finite-number field.
 * @param value - decoded host value.
 * @param field - field the operation's value carries.
 * @returns the field number.
 */
function numberField(value: unknown, field: string): number {
  const read = readField(value, field)
  if (typeof read !== 'number' || !Number.isFinite(read)) throw invalidResponse(field)
  return read
}

/**
 * Read one required string-list field.
 * @param value - decoded host value.
 * @param field - field the operation's value carries.
 * @returns the field entries, in wire order.
 */
function stringListField(value: unknown, field: string): readonly string[] {
  const read = readField(value, field)
  if (!Array.isArray(read) || !read.every(entry => typeof entry === 'string')) throw invalidResponse(field)
  return read
}

/**
 * Read one required boolean field.
 * @param value - decoded host value.
 * @param field - field the operation's value carries.
 * @returns the field value.
 */
function booleanField(value: unknown, field: string): boolean {
  const read = readField(value, field)
  if (typeof read !== 'boolean') throw invalidResponse(field)
  return read
}

/**
 * Read one required member of a closed string union.
 * @param value - decoded host value.
 * @param field - field the operation's value carries.
 * @param allowed - every member of that union.
 * @returns the field member.
 */
function unionField<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  const read = readField(value, field)
  if (!isOneOf(read, allowed)) throw invalidResponse(field)
  return read
}

/**
 * Read one page path the wire carries as a plain string.
 * @param value - decoded host value.
 * @param field - field the operation's value carries.
 * @returns the path, branded for the frozen wire vocabulary.
 */
function pagePathField(value: unknown, field: string): WikiPagePath {
  return stringField(value, field) as WikiPagePath
}

/**
 * Read the nullable page path of one lint finding.
 * @param value - decoded host value.
 * @param field - field the operation's value carries.
 * @returns the page path, or null when the finding is about the vault as a whole.
 */
function nullablePagePathField(value: unknown, field: string): WikiPagePath | null {
  const read = readField(value, field)
  if (read === null) return null
  if (typeof read !== 'string') throw invalidResponse(field)
  return read as WikiPagePath
}

/**
 * Read the stated certainty of one page.
 * @param value - decoded frontmatter value.
 * @returns the number, or null when the author stated none.
 */
function confidenceField(value: unknown): number | null {
  const read = readField(value, 'confidence')
  if (read === null) return null
  if (typeof read !== 'number' || !Number.isFinite(read)) throw invalidResponse('confidence')
  return read
}

/**
 * Read one stored page's frontmatter.
 * @param value - decoded frontmatter value.
 * @returns the frontmatter with every declared field at its declared type.
 */
function readFrontmatter(value: unknown): WikiFrontmatter {
  return {
    title: stringField(value, 'title'),
    type: unionField(value, 'type', PAGE_TYPES),
    tags: stringListField(value, 'tags'),
    updated: stringField(value, 'updated'),
    status: unionField(value, 'status', PAGE_STATUSES),
    sources: stringListField(value, 'sources'),
    aliases: stringListField(value, 'aliases'),
    confidence: confidenceField(value),
    contradicts: stringListField(value, 'contradicts'),
  }
}

/**
 * Read one stored page payload.
 * @param value - decoded payload value.
 * @returns the payload with its revision.
 */
function readPayload(value: unknown): WikiPagePayload {
  return {
    path: stringField(value, 'path'),
    frontmatter: readFrontmatter(readField(value, 'frontmatter')),
    body: stringField(value, 'body'),
    revision: stringField(value, 'revision'),
  }
}

/**
 * Read one vault-tree row.
 * @param value - decoded summary value.
 * @returns the row with every declared field at its declared type.
 */
function readSummary(value: unknown): WikiPageSummary {
  return {
    path: stringField(value, 'path'),
    title: stringField(value, 'title'),
    type: unionField(value, 'type', PAGE_TYPES),
    status: unionField(value, 'status', PAGE_STATUSES),
    updated: stringField(value, 'updated'),
    tags: stringListField(value, 'tags'),
  }
}

/**
 * Read one ranked search hit.
 * @param value - decoded hit value.
 * @returns the hit with every declared field at its declared type.
 */
function readHit(value: unknown): WikiSearchHit {
  return {
    path: pagePathField(value, 'path'),
    title: stringField(value, 'title'),
    type: unionField(value, 'type', PAGE_TYPES),
    status: unionField(value, 'status', PAGE_STATUSES),
    updated: stringField(value, 'updated'),
    excerpt: stringField(value, 'excerpt'),
  }
}

/**
 * Read one lint finding.
 * @param value - decoded finding value.
 * @returns the finding with every declared field at its declared type.
 */
function readFinding(value: unknown): WikiLintFinding {
  return {
    kind: unionField(value, 'kind', LINT_KINDS),
    page: nullablePagePathField(value, 'page'),
    detail: stringField(value, 'detail'),
  }
}

/**
 * Read the vault health report.
 * @param value - decoded report value.
 * @returns the report with its findings.
 */
function readReport(value: unknown): WikiLintReport {
  const findings = readField(value, 'findings')
  if (!Array.isArray(findings)) throw invalidResponse('findings')
  return {
    pages: numberField(value, 'pages'),
    sources: numberField(value, 'sources'),
    findings: findings.map(entry => readFinding(entry)),
  }
}

/**
 * Read one array field by narrowing each entry.
 * @param value - decoded host value.
 * @param field - field the operation's value carries.
 * @param read - entry reader for that field's element type.
 * @returns the narrowed entries, in wire order.
 */
function arrayField<T>(value: unknown, field: string, read: (entry: unknown) => T): readonly T[] {
  const listed = readField(value, field)
  if (!Array.isArray(listed)) throw invalidResponse(field)
  return listed.map(entry => read(entry))
}

/**
 * Build the page's wiki client over the page's own fetch.
 * @param doFetch - page fetch, injectable for tests.
 * @returns typed wiki operations.
 */
export function createWikiApi(doFetch: typeof fetch = (input, init) => globalThis.fetch(input, init)): WikiApi {
  /** Read one envelope, turning its failure arm into a request error. */
  const readEnvelope = async (response: Response, endpoint: string): Promise<unknown> => {
    const body: unknown = await response.json()
    if (!isEnvelope(body)) throw invalidResponse(endpoint)
    if (!body.ok) throw new WikiRequestError(body.error.code, body.error.message, body.error.current)
    return body.value
  }

  /** Send one JSON request and return its envelope value. */
  const postJson = async (endpoint: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
    const response = await doFetch(`${BASE}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    })
    return await readEnvelope(response, endpoint)
  }

  return {
    async list(signal) {
      const value = await postJson('list', {}, signal)
      return { pages: arrayField(value, 'pages', readSummary) }
    },
    async read(request, signal) {
      const value = await postJson('read', request, signal)
      return {
        page: readPayload(readField(value, 'page')),
        links: stringListField(value, 'links'),
        backlinks: stringListField(value, 'backlinks'),
        sources: stringListField(value, 'sources'),
      }
    },
    async search(request, signal) {
      const value = await postJson('search', request, signal)
      return { hits: arrayField(value, 'hits', readHit) }
    },
    async save(request, signal) {
      const value = await postJson('save', request, signal)
      return { page: readPayload(readField(value, 'page')) }
    },
    async source(request, signal) {
      const value = await postJson('source', request, signal)
      return {
        path: stringField(value, 'path'),
        text: stringField(value, 'text'),
        truncated: booleanField(value, 'truncated'),
      }
    },
    async lint(signal) {
      const value = await postJson('lint', {}, signal)
      return { report: readReport(readField(value, 'report')) }
    },
  }
}
