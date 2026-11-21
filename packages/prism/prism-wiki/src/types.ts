/**
 * Shared vocabulary of the wiki vault: page identity, the frontmatter every
 * page carries, what a search returns, and what the lint report is made of.
 * @module @prism/prism-wiki/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of one wiki page: a posix path relative to the vault's `wiki/` directory, including its `.md` suffix. */
export type WikiPagePath = Branded<'WikiPagePath'>

/** Identity of one raw source: a posix path relative to the vault's `raw/` directory. */
export type WikiSourcePath = Branded<'WikiSourcePath'>

/** A page's kind, which also selects the directory the page is filed in. */
export type WikiPageType = 'overview' | 'entity' | 'concept' | 'source' | 'comparison' | 'synthesis'

/** Whether a page's claims still stand. */
export type WikiPageStatus = 'current' | 'stub' | 'superseded' | 'disputed'

/** The frontmatter the vault guarantees on every page it writes. */
export interface WikiFrontmatter {
  /** Human-facing page title. */
  readonly title: string
  /** Page kind, which fixes the page's directory. */
  readonly type: WikiPageType
  /** Lowercase recall tags. */
  readonly tags: readonly string[]
  /** ISO calendar date of the last write, `YYYY-MM-DD`. */
  readonly updated: string
  /** Whether the page's claims still stand. */
  readonly status: WikiPageStatus
  /** Raw source paths this page cites, relative to `raw/`. */
  readonly sources: readonly string[]
  /** Alternative names Obsidian resolves to this page. */
  readonly aliases: readonly string[]
  /** Author's stated certainty, or null when unstated. */
  readonly confidence: number | null
  /** Page names this page disagrees with, relative to `wiki/`. */
  readonly contradicts: readonly string[]
}

/** One page as stored. */
export interface WikiPage {
  /** Vault-relative page identity. */
  readonly path: WikiPagePath
  /** Parsed and validated frontmatter. */
  readonly frontmatter: WikiFrontmatter
  /** Markdown body with the frontmatter block removed. */
  readonly body: string
  /** SHA-256 of the complete file text; the value `expectedRevision` compares against. */
  readonly revision: string
}

/** What a write accepts for one page. */
export interface WikiPageDraft {
  /** Vault-relative page identity. */
  readonly path: WikiPagePath
  /** Frontmatter to store. */
  readonly frontmatter: WikiFrontmatter
  /** Markdown body to store. */
  readonly body: string
  /** When present, the write is refused unless the stored page hashes to this value. */
  readonly expectedRevision?: string
}

/** One ranked search result. */
export interface WikiSearchHit {
  /** Vault-relative page identity. */
  readonly path: WikiPagePath
  /** Page title. */
  readonly title: string
  /** Page kind. */
  readonly type: WikiPageType
  /** Whether the page's claims still stand. */
  readonly status: WikiPageStatus
  /** ISO calendar date of the last write. */
  readonly updated: string
  /** Text around the first match. */
  readonly excerpt: string
}

/** The narrowing `wiki_search` and the Web page apply on top of a literal query. */
export interface WikiSearchFilter {
  /** Keep only pages of this kind. */
  readonly type?: WikiPageType
  /** Keep only pages carrying every one of these tags. */
  readonly tags?: readonly string[]
  /** Keep only pages in this state. */
  readonly status?: WikiPageStatus
  /** Maximum hits to return. */
  readonly limit: number
}

/** A page together with the relations `wiki_read` reports beside it. */
export interface WikiPageView {
  /** The page itself. */
  readonly page: WikiPage
  /** Pages this page links to, as written. */
  readonly links: readonly WikiPagePath[]
  /** Pages that link to this page. */
  readonly backlinks: readonly WikiPagePath[]
  /** Raw sources this page cites. */
  readonly sources: readonly string[]
}

/** One raw source and how far it has been integrated. */
export interface WikiSourceView {
  /** Source identity, relative to `raw/`. */
  readonly path: WikiSourcePath
  /** Whether a page cites this source. */
  readonly integrated: boolean
  /** Pages citing this source. */
  readonly pages: readonly WikiPagePath[]
}

/** The classes of defect `wiki_lint` reports. */
export type WikiLintKind =
  | 'orphan-page'
  | 'broken-link'
  | 'missing-page'
  | 'unintegrated-source'
  | 'missing-source'
  | 'frontmatter'
  | 'contradiction'

/** One lint finding, addressed to the page a reader opens to act on it. */
export interface WikiLintFinding {
  /** Which class of defect this is. */
  readonly kind: WikiLintKind
  /** The page to open, or null when the finding is about the vault as a whole. */
  readonly page: WikiPagePath | null
  /** One line naming the defect. */
  readonly detail: string
}

/** The complete health report for one vault. */
export interface WikiLintReport {
  /** Pages examined. */
  readonly pages: number
  /** Raw sources examined. */
  readonly sources: number
  /** Everything the pass found, ordered by kind and then by page. */
  readonly findings: readonly WikiLintFinding[]
}

/** Vault statistics for `/wiki status`. */
export interface WikiVaultStatus {
  /** Absolute vault directory. */
  readonly vaultRoot: string
  /** Pages present. */
  readonly pages: number
  /** Raw sources present. */
  readonly sources: number
  /** Raw sources no page cites. */
  readonly pendingSources: number
  /** The newest log entry heading, or null when the log is empty. */
  readonly lastLogEntry: string | null
}
