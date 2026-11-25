/**
 * Wire vocabulary shared by the wiki Host routes and the browser half. These
 * types describe JSON that crosses the Connection fetch registry, so every
 * field is plain JSON: no functions, no class instances, no branded values
 * leaking into the browser bundle.
 * @module @prism/prism-wiki/web-contract
 */

import type {
  WikiFrontmatter, WikiLintReport, WikiPageType, WikiPageStatus, WikiSearchHit,
} from './types.ts'

/** One failed wiki request, named by a stable code. */
export interface WikiFailure {
  /** Machine-readable discriminant the page branches on. */
  readonly code: string
  /** One plain-language sentence shown to the reader. */
  readonly message: string
  /** The stored page, present when a revision conflict refused a save so the editor can show it. */
  readonly current?: WikiPagePayload
}

/** The envelope every wiki route answers with. */
export type WikiResponse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WikiFailure }

/** One row of the vault tree. */
export interface WikiPageSummary {
  /** Vault-relative page path, including its `.md` suffix. */
  readonly path: string
  /** Page title. */
  readonly title: string
  /** Page kind. */
  readonly type: WikiPageType
  /** Whether the page's claims still stand. */
  readonly status: WikiPageStatus
  /** ISO calendar date of the last write. */
  readonly updated: string
  /** Recall tags. */
  readonly tags: readonly string[]
}

/** One page as the page renders it. */
export interface WikiPagePayload {
  /** Vault-relative page path. */
  readonly path: string
  /** Parsed frontmatter. */
  readonly frontmatter: WikiFrontmatter
  /** Markdown body. */
  readonly body: string
  /** SHA-256 of the complete file text; the value a save must echo back. */
  readonly revision: string
}

/** The body of a read request. */
export interface WikiReadRequest {
  /** Vault-relative page path. */
  readonly path: string
}

/** The answer to a read request. */
export interface WikiReadValue {
  /** The requested page. */
  readonly page: WikiPagePayload
  /** Paths this page links to. */
  readonly links: readonly string[]
  /** Paths linking to this page. */
  readonly backlinks: readonly string[]
  /** Raw sources this page cites. */
  readonly sources: readonly string[]
}

/** The answer to a list request. */
export interface WikiListValue {
  /** Every page in the vault. */
  readonly pages: readonly WikiPageSummary[]
}

/** The body of a search request. */
export interface WikiSearchRequest {
  /** Literal query text; an empty string lists pages newest first. */
  readonly query: string
  /** Keep only pages of this kind. */
  readonly type?: WikiPageType
  /** Keep only pages carrying every one of these tags. */
  readonly tags?: readonly string[]
  /** Keep only pages in this state. */
  readonly status?: WikiPageStatus
  /** Requested hit count; the deployment cap still applies. */
  readonly limit?: number
}

/** The answer to a search request. */
export interface WikiSearchValue {
  /** Ranked hits. */
  readonly hits: readonly WikiSearchHit[]
}

/** The body of a save request. */
export interface WikiSaveRequest {
  /** Vault-relative page path. */
  readonly path: string
  /** Frontmatter to store. */
  readonly frontmatter: WikiFrontmatter
  /** Markdown body to store. */
  readonly body: string
  /** Revision the editor loaded; a mismatch is refused instead of overwriting. */
  readonly expectedRevision?: string
}

/** The answer to a save request. */
export interface WikiSaveValue {
  /** The stored page, carrying its new revision. */
  readonly page: WikiPagePayload
}

/** The body of a raw-source read request. */
export interface WikiSourceRequest {
  /** Source identity relative to `raw/`. */
  readonly path: string
  /** Requested character bound; the deployment cap still applies. */
  readonly maxChars?: number
}

/** The answer to a raw-source read request. */
export interface WikiSourceValue {
  /** Source identity relative to `raw/`. */
  readonly path: string
  /** The source text, bounded by the character cap. */
  readonly text: string
  /** Whether the bound cut the text short. */
  readonly truncated: boolean
}

/** The answer to a lint request. */
export interface WikiLintValue {
  /** The vault health report. */
  readonly report: WikiLintReport
}
