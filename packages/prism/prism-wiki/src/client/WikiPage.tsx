/**
 * The Knowledge page over one markdown vault: the type-grouped vault tree with
 * its filters, the selected page rendered through `MarkdownText` with its
 * clickable wikilinks and its backlinks, ranked search hits, the frontmatter
 * editor, and the vault health report. Every read and write crosses the
 * injected wiki face, so the component reaches no context and owns no
 * subscription machinery.
 * @module @prism/prism-wiki/src/client/WikiPage
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Button, DisclosureRow, FileTypeIcon, Input, MarkdownDelegateProvider, MarkdownText, PathLabel, Pill,
  SegmentedTabs, StateDot, Tag, type MarkdownLabels, type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  WikiFrontmatter, WikiLintKind, WikiLintReport, WikiPageStatus, WikiPageType, WikiSearchHit,
} from '../types.ts'
import type {
  WikiLintValue, WikiListValue, WikiPageSummary, WikiReadValue, WikiSaveRequest, WikiSaveValue,
  WikiSearchRequest, WikiSearchValue, WikiSourceRequest, WikiSourceValue,
} from '../web-contract.ts'
import { WikiRequestError } from './api.ts'
import type { WikiLocaleKey } from './locales.ts'
import css from './WikiPage.module.css'

/** Lifecycle of one page-column read. */
type LoadState = 'idle' | 'loading' | 'ready'

/** Which pane of the center column the page shows. */
type ViewTab = 'page' | 'search' | 'health'

/** One page draft the editor holds while the reader edits; a conflict never discards it. */
interface WikiDraft {
  /** Vault-relative page path the save addresses. */
  readonly path: string
  readonly title: string
  readonly type: WikiPageType
  readonly status: WikiPageStatus
  /** Comma-separated tags, as typed. */
  readonly tags: string
  /** Comma-separated raw source paths, as typed. */
  readonly sources: string
  /** Comma-separated alternative names, as typed. */
  readonly aliases: string
  /** Comma-separated page names this page disagrees with, as typed. */
  readonly contradicts: string
  /** Stated certainty as typed; blank means unstated. */
  readonly confidence: string
  /** ISO calendar date of the last write. */
  readonly updated: string
  readonly body: string
  /** Revision the editor loaded; null while creating a page that has none yet. */
  readonly revision: string | null
  /** The unresolved link target this draft was opened from, or null for a drafted edit. */
  readonly origin: string | null
  /** In-place notice shown beside the retained draft; null when the last save did not conflict. */
  readonly conflict: string | null
  /** The stored page body, present when the last save conflicted, so the reader can compare the two. */
  readonly conflictStored?: string | null
}

/** One transient outcome the page reports to the frame-wide toast host. */
export interface WikiNotice {
  /** Monotonic per-show sequence; the host keys its banner on it so a repeat restarts the hold. */
  readonly seq: number
  /** Already-localized banner sentence. */
  readonly text: string
  /** Which banner tint the host renders. */
  readonly tone: 'success' | 'warning'
}

/**
 * Report one transient outcome.
 * @param text - already-localized banner sentence.
 * @param tone - success or warning banner.
 */
export type WikiNotify = (text: string, tone: WikiNotice['tone']) => void

/** Capabilities the page's apply closure provides. */
export interface WikiPageFace {
  /** Read every page in the vault. */
  readonly list: (signal?: AbortSignal) => Promise<WikiListValue>
  /** Read one page with its links, backlinks, and cited sources. */
  readonly read: (path: string, signal?: AbortSignal) => Promise<WikiReadValue>
  /** Rank the pages one literal query matches. */
  readonly search: (request: WikiSearchRequest, signal?: AbortSignal) => Promise<WikiSearchValue>
  /** Create or replace one page. */
  readonly save: (request: WikiSaveRequest, signal?: AbortSignal) => Promise<WikiSaveValue>
  /** Read a bounded slice of one raw source. */
  readonly source: (request: WikiSourceRequest, signal?: AbortSignal) => Promise<WikiSourceValue>
  /** Run the vault health pass. */
  readonly lint: (signal?: AbortSignal) => Promise<WikiLintValue>
  /** Report one transient outcome to the frame-wide toast host. */
  readonly notify: WikiNotify
}

/** Full component props assembled by the keyed `main` slot renderer. */
export type WikiPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'wikiVault'>
  & InjectFace<WikiPageFace>

/** One type group of the vault tree. */
interface WikiGroup {
  readonly type: WikiPageType
  readonly pages: readonly WikiPageSummary[]
}

/** Every page kind, in catalog order. */
const PAGE_TYPES: readonly WikiPageType[] = [
  'overview', 'entity', 'concept', 'source', 'comparison', 'synthesis',
]

/** Every page state, in dispute order. */
const PAGE_STATUSES: readonly WikiPageStatus[] = ['current', 'stub', 'superseded', 'disputed']

/** The directory each non-overview page kind is filed in, relative to `wiki/`. */
const TYPE_DIRECTORIES: Readonly<Record<Exclude<WikiPageType, 'overview'>, string>> = {
  entity: 'entities',
  concept: 'concepts',
  source: 'sources',
  comparison: 'comparisons',
  synthesis: 'syntheses',
}

/** The page kind one wiki directory files; mirrors {@link TYPE_DIRECTORIES}. */
const DIRECTORY_TYPES: Readonly<Record<string, WikiPageType>> = {
  entities: 'entity',
  concepts: 'concept',
  sources: 'source',
  comparisons: 'comparison',
  syntheses: 'synthesis',
}

/** Locale key of one page kind's label. */
const TYPE_KEYS: Record<WikiPageType, WikiLocaleKey> = {
  overview: 'typeOverview',
  entity: 'typeEntity',
  concept: 'typeConcept',
  source: 'typeSource',
  comparison: 'typeComparison',
  synthesis: 'typeSynthesis',
}

/** Locale key of one page state's label. */
const STATUS_KEYS: Record<WikiPageStatus, WikiLocaleKey> = {
  current: 'statusCurrent',
  stub: 'statusStub',
  superseded: 'statusSuperseded',
  disputed: 'statusDisputed',
}

/** Locale key of one lint-finding class's label. */
const KIND_KEYS: Record<WikiLintKind, WikiLocaleKey> = {
  'orphan-page': 'kindOrphanPage',
  'broken-link': 'kindBrokenLink',
  'missing-page': 'kindMissingPage',
  'unintegrated-source': 'kindUnintegratedSource',
  'missing-source': 'kindMissingSource',
  'frontmatter': 'kindFrontmatter',
  'contradiction': 'kindContradiction',
}

/** Hits one search asks for; the host's deployment cap still applies. */
const SEARCH_LIMIT = 30

/** Operator-readable text for one thrown value. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Split one comma-separated frontmatter field, dropping blank entries. */
function splitList(input: string): string[] {
  return input
    .split(/[,，]/u)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
}

/** Read the stated certainty field; blank means unstated. */
function parseConfidence(input: string): number | null {
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

/** The wire frontmatter one draft describes. */
function frontmatterOf(draft: WikiDraft): WikiFrontmatter {
  return {
    title: draft.title.trim(),
    type: draft.type,
    tags: splitList(draft.tags),
    updated: draft.updated.trim(),
    status: draft.status,
    sources: splitList(draft.sources),
    aliases: splitList(draft.aliases),
    confidence: parseConfidence(draft.confidence),
    contradicts: splitList(draft.contradicts),
  }
}

/** One read page as an editable draft. */
function draftOf(view: WikiReadValue): WikiDraft {
  const { frontmatter, path, body, revision } = view.page
  return {
    path,
    title: frontmatter.title,
    type: frontmatter.type,
    status: frontmatter.status,
    tags: frontmatter.tags.join(', '),
    sources: frontmatter.sources.join(', '),
    aliases: frontmatter.aliases.join(', '),
    contradicts: frontmatter.contradicts.join(', '),
    confidence: frontmatter.confidence === null ? '' : String(frontmatter.confidence),
    updated: frontmatter.updated,
    body,
    revision,
    origin: null,
    conflict: null,
  }
}

/** One empty draft for a page that does not exist yet. */
function emptyDraft(type: WikiPageType, updated: string): WikiDraft {
  return {
    path: '',
    title: '',
    type,
    status: 'stub',
    tags: '',
    sources: '',
    aliases: '',
    contradicts: '',
    confidence: '',
    updated,
    body: '',
    revision: null,
    origin: null,
    conflict: null,
  }
}

/**
 * The lowercase hyphenated form of one page name. Letters and digits of any
 * script survive, so a Chinese title keeps its own characters.
 * @param value - the page name as typed.
 * @returns the slug, or an empty string when the name carries no letters or digits.
 */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
}

/**
 * The path a new page of one kind and title takes.
 * @param title - the page title as typed.
 * @param type - the page kind, which selects the directory.
 * @returns the vault-relative path, or an empty string while the title has no usable name.
 */
function derivePath(title: string, type: WikiPageType): string {
  if (type === 'overview') return 'overview.md'
  const slug = slugify(title)
  return slug === '' ? '' : `${TYPE_DIRECTORIES[type]}/${slug}.md`
}

/**
 * Whether one draft path is still the one its title and kind derive, so typing a
 * title may keep it in step. A path the reader typed is never overwritten.
 * @param path - the path currently in the draft.
 * @param title - the title currently in the draft.
 * @param type - the kind currently in the draft.
 * @returns true when the path is empty or still derived.
 */
function isDerivedPath(path: string, title: string, type: WikiPageType): boolean {
  return path === '' || path === derivePath(title, type)
}

/**
 * One new draft for a wikilink target that resolves to no page: the vault's
 * conventions say such a link is a request for the page it names.
 * @param target - the link target as written in the body.
 * @returns the draft, with its title and path filled in where they can be derived.
 */
function draftFromTarget(target: string): WikiDraft {
  const withoutSuffix = target.trim().replace(/\\/gu, '/').replace(/\.md$/iu, '')
  const slash = withoutSuffix.lastIndexOf('/')
  const directory = slash < 0 ? '' : withoutSuffix.slice(0, slash)
  const stem = slash < 0 ? withoutSuffix : withoutSuffix.slice(slash + 1)
  const known = DIRECTORY_TYPES[directory]
  const type = known ?? 'concept'
  const slug = slugify(stem)
  // A target under a directory this vault does not own is filed as a concept,
  // because the page's kind fixes the directory it may live in.
  const base = known === undefined ? TYPE_DIRECTORIES.concept : directory
  return {
    ...emptyDraft(type, todayText()),
    path: slug === '' ? '' : `${base}/${slug}.md`,
    title: stem,
    origin: withoutSuffix,
  }
}

/** Today as the `YYYY-MM-DD` the vault's frontmatter carries. */
function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

/** One page kind from a form control's value, keeping the current kind for an unknown value. */
function pageTypeOf(value: string, fallback: WikiPageType): WikiPageType {
  return PAGE_TYPES.find(type => type === value) ?? fallback
}

/** One page state from a form control's value, keeping the current state for an unknown value. */
function statusOf(value: string, fallback: WikiPageStatus): WikiPageStatus {
  return PAGE_STATUSES.find(status => status === value) ?? fallback
}

/** The tag tint one page state renders with. */
function statusTone(status: WikiPageStatus): TagTone {
  if (status === 'current') return 'success'
  if (status === 'disputed') return 'warning'
  return status === 'stub' ? 'info' : 'neutral'
}

/** The tag tint one lint-finding class renders with. */
function kindTone(kind: WikiLintKind): TagTone {
  if (kind === 'broken-link' || kind === 'missing-page') return 'danger'
  if (kind === 'frontmatter') return 'neutral'
  return kind === 'unintegrated-source' ? 'info' : 'warning'
}

/** A wiki path without its `.md` suffix. */
function stripMarkdownSuffix(path: string): string {
  const trimmed = path.toLowerCase()
  return trimmed.endsWith('.md') ? trimmed.slice(0, -3) : trimmed
}

/**
 * The vault path one wikilink name addresses, so a link written the Obsidian
 * way (`[[Attention]]`) reaches the page its author meant.
 * @param target - the link target as written in the body.
 * @param pages - every page in the vault.
 * @returns the stored path, or undefined when no page answers to that name.
 */
function resolvePagePath(target: string, pages: readonly WikiPageSummary[]): string | undefined {
  const needle = target.trim().toLowerCase()
  if (needle.length === 0) return undefined
  const bare = stripMarkdownSuffix(needle)
  const found = pages.find((entry) => {
    const path = entry.path.toLowerCase()
    const entryBare = stripMarkdownSuffix(entry.path)
    const name = entryBare.slice(entryBare.lastIndexOf('/') + 1)
    const title = entry.title.toLowerCase()
    return path === needle || entryBare === bare || name === bare || title === bare || title === needle
  })
  return found?.path
}

/**
 * Percent-encode one wikilink target into a Markdown destination the renderer's
 * file delegate decodes back verbatim. The written case is kept, so a target
 * that resolves to no page still names the page the author asked for.
 * @param target - the target as written, with any heading or block anchor.
 * @returns the local `.md` destination.
 */
function wikilinkDestination(target: string): string {
  const bare = target.split(/[#^]/u)[0] ?? ''
  const trimmed = bare.trim()
  const path = trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

/** One link text with the characters that would end it escaped. */
function escapeLinkText(text: string): string {
  return text.replace(/([\\[\]])/gu, '\\$1')
}

/** The fence marker opening a fenced code block on one line, or null. */
function fenceOpening(line: string): string | null {
  const match = /^(`{3,}|~{3,})/u.exec(line.trimStart())
  return match === null ? null : match[1] ?? null
}

/** Whether one line closes the fence the given marker opened. */
function fenceClosing(line: string, marker: string): boolean {
  const closing = fenceOpening(line)
  return closing !== null && closing.charAt(0) === marker.charAt(0) && closing.length >= marker.length
}

/** The index of the next backtick run of exactly `width`, or -1. */
function backtickRun(body: string, from: number, width: number): number {
  let index = from
  while (index < body.length) {
    if (body.charAt(index) !== '`') {
      index += 1
      continue
    }
    let run = index
    while (body.charAt(run) === '`') run += 1
    if (run - index === width) return index
    index = run
  }
  return -1
}

/** One `[[...]]` body as a local Markdown link, keeping its written label. */
function wikilinkMarkdown(inner: string): string {
  const bar = inner.indexOf('|')
  const target = (bar < 0 ? inner : inner.slice(0, bar)).trim()
  const label = (bar < 0 ? inner : inner.slice(bar + 1)).trim()
  if (target.length === 0) return `[[${inner}]]`
  const text = label.length === 0 ? target : label
  return `[${escapeLinkText(text)}](${wikilinkDestination(target)})`
}

/**
 * Rewrite the body's `[[wikilinks]]` into local Markdown links, so the shared
 * renderer draws them and its file delegate receives the click. Fenced code
 * blocks and inline code spans are copied verbatim, so a wikilink written
 * inside code stays literal.
 * @param body - the page body as stored.
 * @returns the body with every wikilink replaced by a local Markdown link.
 */
function rewriteWikilinks(body: string): string {
  const out: string[] = []
  let index = 0
  let fence: string | null = null
  while (index < body.length) {
    const stop = body.indexOf('\n', index)
    const line = stop < 0 ? body.slice(index) : body.slice(index, stop + 1)
    if (fence !== null) {
      out.push(line)
      index += line.length
      if (fenceClosing(line, fence)) fence = null
      continue
    }
    if (index === 0 || body.charAt(index - 1) === '\n') {
      const opening = fenceOpening(line)
      if (opening !== null) {
        out.push(line)
        index += line.length
        fence = opening
        continue
      }
    }
    const character = body.charAt(index)
    if (character === '`') {
      let run = index
      while (body.charAt(run) === '`') run += 1
      const close = backtickRun(body, run, run - index)
      const after = close < 0 ? run : close + (run - index)
      out.push(body.slice(index, after))
      index = after
      continue
    }
    const close = character === '[' && body.charAt(index + 1) === '[' ? body.indexOf(']]', index + 2) : -1
    if (close >= 0) {
      out.push(wikilinkMarkdown(body.slice(index + 2, close)))
      index = close + 2
      continue
    }
    out.push(character)
    index += 1
  }
  return out.join('')
}

/** Keep the pages one tree filter matches, in catalog order. */
function matchesFilter(
  page: WikiPageSummary,
  needle: string,
  type: WikiPageType | null,
  status: WikiPageStatus | null,
): boolean {
  if (type !== null && page.type !== type) return false
  if (status !== null && page.status !== status) return false
  if (needle.length === 0) return true
  return page.title.toLocaleLowerCase().includes(needle) || page.path.toLocaleLowerCase().includes(needle)
}

/** Group the given pages by kind, in catalog order, dropping empty groups. */
function groupPages(pages: readonly WikiPageSummary[]): WikiGroup[] {
  const groups: WikiGroup[] = []
  for (const type of PAGE_TYPES) {
    const members = pages.filter(page => page.type === type)
    if (members.length > 0) groups.push({ type, pages: members })
  }
  return groups
}

/**
 * Render the Knowledge page.
 * @param props - the keyed main panel's standard seats, this namespace's translator, and the wiki face.
 * @returns the page element tree.
 */
export function WikiPage(props: WikiPageProps): ReactNode {
  const { t, list, read, search, save, source, lint, notify } = props
  const [pages, setPages] = useState<readonly WikiPageSummary[]>([])
  const [listState, setListState] = useState<LoadState>('loading')
  const [filter, setFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState<WikiPageType | null>(null)
  const [statusFilter, setStatusFilter] = useState<WikiPageStatus | null>(null)
  const [collapsed, setCollapsed] = useState<readonly WikiPageType[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [page, setPage] = useState<WikiReadValue | null>(null)
  const [pageState, setPageState] = useState<LoadState>('idle')
  const [tab, setTab] = useState<ViewTab>('page')
  const [failure, setFailure] = useState<string | null>(null)
  const [draft, setDraft] = useState<WikiDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [hits, setHits] = useState<readonly WikiSearchHit[] | null>(null)
  const [lintState, setLintState] = useState<LoadState>('idle')
  const [report, setReport] = useState<WikiLintReport | null>(null)
  const [sourceView, setSourceView] = useState<WikiSourceValue | null>(null)
  const [sourceLoading, setSourceLoading] = useState<string | null>(null)
  const [treeOpen, setTreeOpen] = useState(false)
  const [autoOpened, setAutoOpened] = useState(false)

  /** Re-read the whole vault tree. */
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const value = await list()
      setPages(value.pages)
      setListState('ready')
    } catch (error) {
      setListState('ready')
      setFailure(t('loadFailed', { reason: reasonOf(error) }))
    }
  }, [list, t])

  useEffect(() => { void refresh() }, [refresh])

  /** Open one vault page in the center column. */
  const openPage = useCallback(async (path: string): Promise<void> => {
    setSelected(path)
    setTab('page')
    setDraft(null)
    setPage(null)
    setSourceView(null)
    setPageState('loading')
    setFailure(null)
    try {
      setPage(await read(path))
    } catch (error) {
      setFailure(t('pageFailed', { reason: reasonOf(error) }))
    } finally {
      setPageState('ready')
    }
  }, [read, t])

  /**
   * Follow one wikilink. A target that resolves to no page opens the editor on
   * a draft for it, because in this vault such a link is a request for the page.
   * @param target - the link target as written.
   */
  const openTarget = useCallback((target: string | null): void => {
    if (target === null) return
    const resolved = resolvePagePath(target, pages)
    if (resolved !== undefined) {
      void openPage(resolved)
      return
    }
    setSelected(null)
    setPage(null)
    setTab('page')
    setSourceView(null)
    setFailure(null)
    setDraft(draftFromTarget(target))
  }, [openPage, pages])

  // The rewritten wikilinks are local Markdown destinations, so the renderer's
  // file delegate is the one click path into this vault.
  const openFile = useCallback((path: string): void => { openTarget(path) }, [openTarget])

  // The catalog's front door is `overview.md`: opening it makes the first look
  // at the vault show what the vault is for, instead of an empty center column.
  useEffect(() => {
    if (autoOpened || listState !== 'ready') return
    setAutoOpened(true)
    if (pages.some(entry => entry.path === 'overview.md')) void openPage('overview.md')
  }, [autoOpened, listState, openPage, pages])

  /** Rank the pages the current query matches. */
  const runSearch = useCallback(async (): Promise<void> => {
    setTab('search')
    setSearching(true)
    setFailure(null)
    try {
      setHits((await search({ query: query.trim(), limit: SEARCH_LIMIT })).hits)
    } catch (error) {
      setFailure(t('searchFailed', { reason: reasonOf(error) }))
    } finally {
      setSearching(false)
    }
  }, [query, search, t])

  /** Run the vault health pass. */
  const runLint = useCallback(async (): Promise<void> => {
    setLintState('loading')
    setFailure(null)
    try {
      setReport((await lint()).report)
    } catch (error) {
      setFailure(t('lintFailed', { reason: reasonOf(error) }))
    } finally {
      setLintState('ready')
    }
  }, [lint, t])

  // The health tab pays for its pass the first time it is opened. A pass that
  // failed leaves the tab settled, so the reader retries with its own button.
  useEffect(() => {
    if (tab !== 'health' || lintState !== 'idle') return
    void runLint()
  }, [lintState, runLint, tab])

  /** Read one raw source the open page cites, into the panel beside its list. */
  const openSource = useCallback(async (path: string): Promise<void> => {
    setSourceLoading(path)
    setFailure(null)
    try {
      setSourceView(await source({ path }))
    } catch (error) {
      setFailure(t('sourceFailed', { reason: reasonOf(error) }))
    } finally {
      setSourceLoading(null)
    }
  }, [source, t])

  /** Update the open draft through its latest value. */
  const patchDraft = useCallback((patch: (current: WikiDraft) => WikiDraft): void => {
    setDraft(current => (current === null ? current : patch(current)))
  }, [])

  /** Toggle one type group of the vault tree. */
  const toggleGroup = useCallback((type: WikiPageType): void => {
    setCollapsed(current => (current.includes(type)
      ? current.filter(entry => entry !== type)
      : [...current, type]))
  }, [])

  /** Store the open draft, echoing the revision it loaded. */
  const onSave = useCallback(async (): Promise<void> => {
    if (draft === null) return
    const path = draft.path.trim()
    if (path.length === 0) {
      setFailure(t('invalidPath'))
      return
    }
    if (draft.title.trim().length === 0) {
      setFailure(t('invalidTitle'))
      return
    }
    // A new draft carries no revision to echo, so an existing path would be
    // replaced without the editor ever seeing what it overwrote.
    if (draft.revision === null && pages.some(entry => entry.path === path)) {
      setFailure(t('pageExists', { path }))
      return
    }
    setSaving(true)
    setFailure(null)
    try {
      const stored = await save({
        path,
        frontmatter: frontmatterOf(draft),
        body: draft.body,
        ...(draft.revision === null ? {} : { expectedRevision: draft.revision }),
      })
      setDraft(null)
      await refresh()
      await openPage(stored.page.path)
      notify(t('saved', { path }), 'success')
    } catch (error) {
      // A refused save keeps every keystroke: the conflict is reported beside
      // the draft, and nothing else is discarded either.
      if (error instanceof WikiRequestError && error.code === 'prism-wiki/revision-conflict') {
        const conflict = t('conflict')
        patchDraft(current => ({ ...current, conflict, conflictStored: error.current?.body ?? null }))
      } else {
        notify(t('saveFailed', { reason: reasonOf(error) }), 'warning')
      }
    } finally {
      setSaving(false)
    }
  }, [draft, notify, openPage, pages, patchDraft, refresh, save, t])

  /**
   * Retitle the open draft. A new page's path follows the title while the path
   * is still the one the title derives; a path the reader typed stays put.
   * @param title - the title as typed.
   */
  const onTitleChange = useCallback((title: string): void => {
    patchDraft((current) => {
      if (current.revision !== null) return { ...current, title }
      const derived = isDerivedPath(current.path, current.title, current.type)
      return derived ? { ...current, title, path: derivePath(title, current.type) } : { ...current, title }
    })
  }, [patchDraft])

  /**
   * Refile the open draft under another kind, moving a derived path with it.
   * @param type - the kind the reader selected.
   */
  const onTypeChange = useCallback((type: WikiPageType): void => {
    patchDraft((current) => {
      if (current.revision !== null) return { ...current, type }
      const derived = isDerivedPath(current.path, current.title, current.type)
      return derived ? { ...current, type, path: derivePath(current.title, type) } : { ...current, type }
    })
  }, [patchDraft])

  const markdownLabels = useMemo<MarkdownLabels>(() => ({
    code: {
      copyLabel: t('codeCopy'),
      copiedLabel: t('codeCopied'),
      toolbarLabels: { codeLabel: t('codeBlock'), wrapLabel: t('codeWrap'), unwrapLabel: t('codeUnwrap') },
    },
    footnotes: t('footnotes'),
  }), [t])

  const visible = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase()
    return pages.filter(entry => matchesFilter(entry, needle, typeFilter, statusFilter))
  }, [filter, pages, statusFilter, typeFilter])

  const groups = useMemo(() => groupPages(visible), [visible])

  const body = page === null ? '' : page.page.body
  const markdown = useMemo(() => rewriteWikilinks(body), [body])
  const frontmatter = page === null ? null : page.page.frontmatter
  const findings = report === null ? [] : report.findings
  const filtered = typeFilter !== null || statusFilter !== null

  return (
    <section className={css.page} aria-busy={listState === 'loading' || pageState === 'loading'}>
      <header className={css.head}>
        <div className={css.headText}>
          <h1 className={css.title}>{t('title')}</h1>
          <p className={css.intro}>{t('intro')}</p>
        </div>
        <div className={css.toolbar}>
          {/* The catalog column folds away under the narrow breakpoint; this
              toggle is the only way back to it there. */}
          <Button
            variant="outline"
            className={css.treeToggle}
            aria-expanded={treeOpen}
            aria-controls="wiki-vault-tree"
            onClick={() => { setTreeOpen(open => !open) }}
          >
            {t('tree')}
          </Button>
          <Input
            type="search"
            className={css.search as string}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            value={query}
            onChange={(event) => { setQuery(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              void runSearch()
            }}
          />
          <Button variant="outline" disabled={searching} onClick={() => { void runSearch() }}>
            {searching ? t('searching') : t('search')}
          </Button>
          <Button variant="outline" onClick={() => { void refresh() }}>{t('refresh')}</Button>
          <Button
            variant="primary"
            onClick={() => {
              setTab('page')
              setDraft(emptyDraft('concept', todayText()))
            }}
          >
            {t('newPage')}
          </Button>
        </div>
      </header>

      {failure !== null && (
        <p className={css.failure} role="alert">
          <span>{failure}</span>
          <button type="button" className={css.dismiss} onClick={() => { setFailure(null) }}>{t('dismiss')}</button>
        </p>
      )}

      <div className={css.body}>
        <nav id="wiki-vault-tree" className={css.tree} data-open={treeOpen ? 'true' : undefined} aria-label={t('tree')}>
          <Input
            type="search"
            className={css.filter as string}
            placeholder={t('filter')}
            aria-label={t('filter')}
            value={filter}
            onChange={(event) => { setFilter(event.target.value) }}
          />
          <div className={css.filters}>
            <div className={css.filterGroup}>
              <span className={css.filterLabel}>{t('filterType')}</span>
              <div className={css.pills}>
                {PAGE_TYPES.map(type => (
                  <Pill
                    key={type}
                    active={typeFilter === type}
                    onClick={() => { setTypeFilter(current => (current === type ? null : type)) }}
                  >
                    {t(TYPE_KEYS[type])}
                  </Pill>
                ))}
              </div>
            </div>
            <div className={css.filterGroup}>
              <span className={css.filterLabel}>{t('filterStatus')}</span>
              <div className={css.pills}>
                {PAGE_STATUSES.map(status => (
                  <Pill
                    key={status}
                    active={statusFilter === status}
                    onClick={() => { setStatusFilter(current => (current === status ? null : status)) }}
                  >
                    {t(STATUS_KEYS[status])}
                  </Pill>
                ))}
              </div>
            </div>
            {filtered && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setTypeFilter(null)
                  setStatusFilter(null)
                }}
              >
                {t('clearFilters')}
              </Button>
            )}
          </div>

          {listState === 'loading' && (
            <p className={css.placeholder}><StateDot state="ongoing" /><span>{t('loading')}</span></p>
          )}
          {listState === 'ready' && pages.length === 0 && (
            <p className={css.placeholder}>{t('vaultEmpty')}</p>
          )}
          {listState === 'ready' && pages.length === 0 && (
            <p className={css.hint}>{t('vaultEmptyHint')}</p>
          )}
          {listState === 'ready' && pages.length > 0 && visible.length === 0 && (
            <p className={css.placeholder}>{t('treeEmpty')}</p>
          )}
          {groups.map(group => (
            <DisclosureRow
              key={group.type}
              icon={<FileTypeIcon kind="folder" size={14} />}
              title={t(TYPE_KEYS[group.type])}
              open={!collapsed.includes(group.type)}
              expandable
              onToggle={() => { toggleGroup(group.type) }}
              collapsedContent={(
                <span className={css.groupCount}>{t('pagesInGroup', { count: String(group.pages.length) })}</span>
              )}
            >
              <ul className={css.rows}>
                {group.pages.map(entry => (
                  <li key={entry.path}>
                    <button
                      type="button"
                      className={css.row}
                      data-selected={selected === entry.path || undefined}
                      aria-current={selected === entry.path ? 'true' : undefined}
                      onClick={() => { void openPage(entry.path) }}
                    >
                      <FileTypeIcon path={entry.path} size={14} />
                      <span className={css.rowText}>
                        <span className={css.rowTitle}>{entry.title}</span>
                        <PathLabel path={entry.path} className={css.rowPath} />
                      </span>
                      <Tag tone={statusTone(entry.status)}>{t(STATUS_KEYS[entry.status])}</Tag>
                    </button>
                  </li>
                ))}
              </ul>
            </DisclosureRow>
          ))}
        </nav>

        <div className={css.detail}>
          <SegmentedTabs<ViewTab>
            label={t('tabsLabel')}
            value={tab}
            onChange={setTab}
            items={[
              { value: 'page', label: t('tabPage'), id: 'wiki-tab-page', panelId: 'wiki-panel-page' },
              { value: 'search', label: t('tabSearch'), id: 'wiki-tab-search', panelId: 'wiki-panel-search' },
              { value: 'health', label: t('tabHealth'), id: 'wiki-tab-health', panelId: 'wiki-panel-health' },
            ]}
          />
          <div
            className={css.panel}
            role="tabpanel"
            id={`wiki-panel-${tab}`}
            aria-labelledby={`wiki-tab-${tab}`}
          >
            {tab === 'page' && draft !== null && (
              <div className={css.editor}>
                <h2 className={css.sectionTitle}>
                  {draft.revision !== null
                    ? t('editorEdit')
                    : draft.origin === null ? t('editorNew') : t('editorNewFrom', { target: draft.origin })}
                </h2>
                {draft.conflict !== null && (
                  <p className={css.conflict} role="alert">
                    <span>{draft.conflict}</span>
                    <button
                      type="button"
                      className={css.dismiss}
                      onClick={() => { patchDraft(current => ({ ...current, conflict: null })) }}
                    >
                      {t('dismiss')}
                    </button>
                  </p>
                )}
                <div className={css.fieldRow}>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('fieldTitle')}</span>
                    <Input
                      value={draft.title}
                      placeholder={t('fieldTitlePlaceholder')}
                      onChange={(event) => { onTitleChange(event.target.value) }}
                    />
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('fieldPath')}</span>
                    <Input
                      value={draft.path}
                      placeholder={t('fieldPathPlaceholder')}
                      disabled={draft.revision !== null}
                      onChange={(event) => {
                        const path = event.target.value
                        patchDraft(current => ({ ...current, path }))
                      }}
                    />
                  </label>
                </div>
                <div className={css.fieldRow}>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('fieldType')}</span>
                    <select
                      className={css.select}
                      value={draft.type}
                      onChange={(event) => { onTypeChange(pageTypeOf(event.target.value, draft.type)) }}
                    >
                      {PAGE_TYPES.map(type => (
                        <option key={type} value={type}>{t(TYPE_KEYS[type])}</option>
                      ))}
                    </select>
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('fieldStatus')}</span>
                    <select
                      className={css.select}
                      value={draft.status}
                      onChange={(event) => {
                        const value = event.target.value
                        patchDraft(current => ({ ...current, status: statusOf(value, current.status) }))
                      }}
                    >
                      {PAGE_STATUSES.map(status => (
                        <option key={status} value={status}>{t(STATUS_KEYS[status])}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className={css.fieldRow}>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('fieldUpdated')}</span>
                    <Input
                      value={draft.updated}
                      onChange={(event) => {
                        const updated = event.target.value
                        patchDraft(current => ({ ...current, updated }))
                      }}
                    />
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('fieldConfidence')}</span>
                    <Input
                      value={draft.confidence}
                      placeholder={t('fieldConfidencePlaceholder')}
                      onChange={(event) => {
                        const confidence = event.target.value
                        patchDraft(current => ({ ...current, confidence }))
                      }}
                    />
                  </label>
                </div>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('fieldTags')}</span>
                  <Input
                    value={draft.tags}
                    placeholder={t('fieldTagsPlaceholder')}
                    onChange={(event) => {
                      const tags = event.target.value
                      patchDraft(current => ({ ...current, tags }))
                    }}
                  />
                </label>
                <label className={css.field}>
                  <span className={css.fieldLabel}>{t('fieldSources')}</span>
                  <Input
                    value={draft.sources}
                    placeholder={t('fieldSourcesPlaceholder')}
                    onChange={(event) => {
                      const sources = event.target.value
                      patchDraft(current => ({ ...current, sources }))
                    }}
                  />
                </label>
                <div className={css.fieldRow}>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('fieldAliases')}</span>
                    <Input
                      value={draft.aliases}
                      placeholder={t('fieldAliasesPlaceholder')}
                      onChange={(event) => {
                        const aliases = event.target.value
                        patchDraft(current => ({ ...current, aliases }))
                      }}
                    />
                  </label>
                  <label className={css.field}>
                    <span className={css.fieldLabel}>{t('fieldContradicts')}</span>
                    <Input
                      value={draft.contradicts}
                      placeholder={t('fieldContradictsPlaceholder')}
                      onChange={(event) => {
                        const contradicts = event.target.value
                        patchDraft(current => ({ ...current, contradicts }))
                      }}
                    />
                  </label>
                </div>
                <div className={css.field}>
                  <span className={css.fieldLabel}>{t('fieldBody')}</span>
                  {draft.conflictStored == null ? (
                    <textarea
                      className={css.textarea}
                      aria-label={t('fieldBody')}
                      placeholder={t('fieldBodyPlaceholder')}
                      value={draft.body}
                      onChange={(event) => {
                        const next = event.target.value
                        patchDraft(current => ({ ...current, body: next }))
                      }}
                    />
                  ) : (
                    <div className={css.compare}>
                      <label className={css.compareColumn}>
                        <span className={css.fieldLabel}>{t('conflictDraft')}</span>
                        <textarea
                          className={css.textarea}
                          aria-label={t('fieldBody')}
                          value={draft.body}
                          onChange={(event) => {
                            const next = event.target.value
                            patchDraft(current => ({ ...current, body: next }))
                          }}
                        />
                      </label>
                      <div className={css.compareColumn}>
                        <span className={css.fieldLabel}>{t('conflictStored')}</span>
                        <pre className={css.conflictStored}>{draft.conflictStored}</pre>
                      </div>
                    </div>
                  )}
                </div>
                <div className={css.actions}>
                  <Button variant="primary" disabled={saving} onClick={() => { void onSave() }}>
                    {saving ? t('saving') : t('save')}
                  </Button>
                  <Button variant="ghost" onClick={() => { setDraft(null) }}>{t('cancel')}</Button>
                </div>
              </div>
            )}

            {tab === 'page' && draft === null && pageState === 'loading' && (
              <p className={css.placeholder}><StateDot state="ongoing" /><span>{t('pageLoading')}</span></p>
            )}
            {tab === 'page' && draft === null && pageState !== 'loading' && page === null && (
              <p className={css.placeholder}>{t('detailPlaceholder')}</p>
            )}
            {tab === 'page' && draft === null && page !== null && frontmatter !== null && (
              <article className={css.article}>
                <div className={css.articleHead}>
                  <h2 className={css.articleTitle}>{frontmatter.title}</h2>
                  <Tag tone="quiet">{t(TYPE_KEYS[frontmatter.type])}</Tag>
                  <Tag tone={statusTone(frontmatter.status)}>{t(STATUS_KEYS[frontmatter.status])}</Tag>
                  <Button variant="ghost" onClick={() => { setDraft(draftOf(page)) }}>{t('edit')}</Button>
                </div>
                <div className={css.metaLine}>
                  <span className={css.metaLabel}>{t('updated')}</span>
                  <span className={css.metaValue}>{frontmatter.updated}</span>
                  <PathLabel path={page.page.path} className={css.metaPath} />
                </div>
                {frontmatter.tags.length > 0 && (
                  <div className={css.pills}>
                    {frontmatter.tags.map(tag => <Tag key={tag} tone="outline">{tag}</Tag>)}
                  </div>
                )}
                <div className={css.markdown}>
                  <MarkdownDelegateProvider openFile={openFile}>
                    <MarkdownText text={markdown} labels={markdownLabels} />
                  </MarkdownDelegateProvider>
                </div>
                <section className={css.section}>
                  <h3 className={css.sectionTitle}>{t('backlinks')}</h3>
                  {page.backlinks.length === 0
                    ? <p className={css.placeholder}>{t('noBacklinks')}</p>
                    : (
                      <ul className={css.chips}>
                        {page.backlinks.map(link => (
                          <li key={link}>
                            <button
                              type="button"
                              className={css.chip}
                              onClick={() => { void openPage(link) }}
                            >
                              {link}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                </section>
                <section className={css.section}>
                  <h3 className={css.sectionTitle}>{t('sources')}</h3>
                  {page.sources.length === 0
                    ? <p className={css.placeholder}>{t('noSources')}</p>
                    : (
                      <ul className={css.chips}>
                        {page.sources.map(rawPath => (
                          <li key={rawPath}>
                            <button
                              type="button"
                              className={css.chip}
                              aria-pressed={sourceView?.path === rawPath}
                              disabled={sourceLoading === rawPath}
                              onClick={() => { void openSource(rawPath) }}
                            >
                              {sourceLoading === rawPath ? t('sourceLoading') : rawPath}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  {sourceView !== null && (
                    <div className={css.sourcePanel}>
                      <div className={css.sourceHead}>
                        <PathLabel path={`raw/${sourceView.path}`} className={css.sourcePath} />
                        {sourceView.truncated && <span className={css.hint}>{t('sourceTruncated')}</span>}
                        <button type="button" className={css.dismiss} onClick={() => { setSourceView(null) }}>
                          {t('dismiss')}
                        </button>
                      </div>
                      <pre className={css.sourceText}>{sourceView.text}</pre>
                    </div>
                  )}
                </section>
              </article>
            )}

            {tab === 'search' && (
              <div className={css.columns}>
                <h2 className={css.sectionTitle}>{t('searchTitle')}</h2>
                {searching && (
                  <p className={css.placeholder}><StateDot state="ongoing" /><span>{t('searching')}</span></p>
                )}
                {!searching && hits === null && (
                  <>
                    <p className={css.placeholder}>{t('searchEmpty')}</p>
                    <p className={css.hint}>{t('searchHint')}</p>
                  </>
                )}
                {!searching && hits !== null && hits.length === 0 && (
                  <p className={css.placeholder}>{t('searchNone')}</p>
                )}
                {!searching && hits !== null && hits.length > 0 && (
                  <>
                    <p className={css.hint}>{t('hitsCount', { count: String(hits.length) })}</p>
                    <ul className={css.hits}>
                      {hits.map(hit => (
                        <li key={hit.path}>
                          <button
                            type="button"
                            className={css.hit}
                            onClick={() => { void openPage(hit.path) }}
                          >
                            <span className={css.hitHead}>
                              <FileTypeIcon path={hit.path} size={14} />
                              <span className={css.rowTitle}>{hit.title}</span>
                              <Tag tone={statusTone(hit.status)}>{t(STATUS_KEYS[hit.status])}</Tag>
                            </span>
                            <PathLabel path={hit.path} className={css.hitPath} />
                            <span className={css.hitExcerpt}>{hit.excerpt}</span>
                            <span className={css.hitMeta}>{hit.updated}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}

            {tab === 'health' && (
              <div className={css.columns}>
                <div className={css.healthHead}>
                  <h2 className={css.sectionTitle}>{t('healthTitle')}</h2>
                  <Button variant="outline" disabled={lintState === 'loading'} onClick={() => { void runLint() }}>
                    {lintState === 'loading' ? t('linting') : t('lint')}
                  </Button>
                </div>
                <p className={css.hint}>
                  {report === null
                    ? t('healthIntro')
                    : t('lintSummary', { pages: String(report.pages), sources: String(report.sources) })}
                </p>
                {lintState === 'loading' && (
                  <p className={css.placeholder}><StateDot state="ongoing" /><span>{t('linting')}</span></p>
                )}
                {lintState === 'ready' && report !== null && findings.length === 0 && (
                  <p className={css.placeholder}>{t('lintClean')}</p>
                )}
                {findings.length > 0 && (
                  <ul className={css.findings}>
                    {findings.map((finding, index) => {
                      const target = finding.page
                      return (
                        <li key={`${finding.kind}:${target ?? ''}:${String(index)}`}>
                          <button
                            type="button"
                            className={css.finding}
                            disabled={target === null}
                            onClick={() => { openTarget(target) }}
                          >
                            <Tag tone={kindTone(finding.kind)}>{t(KIND_KEYS[finding.kind])}</Tag>
                            <span className={css.findingDetail}>{finding.detail}</span>
                            {target !== null && <PathLabel path={target} className={css.findingPath} />}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
