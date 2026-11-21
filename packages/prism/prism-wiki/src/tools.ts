/**
 * Model-facing vault tools over `ctx.wikiVault`.
 *
 * Five tools: a ranked search, an exact read, a write, the raw-source
 * operations, and a health check. Their schemas sit in the cached request
 * prefix, so every added tool and every added description is paid for on cold
 * start and on each profile switch.
 *
 * The model owns reading, synthesis, and authoring. Everything here is
 * mechanical: it moves text between the vault and the conversation, and a
 * refusal comes back as a result the model can act on rather than as an
 * unhandled tool error.
 *
 * @module @prism/prism-wiki/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { WikiError, WikiVaultError, brandPagePath, brandSourcePath } from './service.ts'
import type { WikiVaultService } from './service.ts'
import type {
  WikiFrontmatter,
  WikiLintKind,
  WikiPageDraft,
  WikiPagePath,
  WikiPageStatus,
  WikiPageType,
  WikiSearchFilter,
} from './types.ts'

/** Cordis plugin name for the tool registrant. */
export const name = 'prism-wiki-tools'

/** Registries this row contributes to. */
export const inject = ['tools', 'wikiVault'] as const

/** Every page kind a write accepts; the kind also selects the page's directory. */
const PAGE_TYPES = [
  'overview',
  'entity',
  'concept',
  'source',
  'comparison',
  'synthesis',
] as const satisfies readonly WikiPageType[]

/** Every page state a write accepts and a search may filter on. */
const PAGE_STATUSES = ['current', 'stub', 'superseded', 'disputed'] as const satisfies readonly WikiPageStatus[]

/** Every defect class the health check reports. */
const LINT_KINDS = [
  'orphan-page',
  'broken-link',
  'missing-page',
  'unintegrated-source',
  'missing-source',
  'frontmatter',
  'contradiction',
] as const satisfies readonly WikiLintKind[]

/** The raw-source operations `wiki_source` dispatches on. */
const SOURCE_ACTIONS = ['list', 'read', 'add', 'integrate'] as const

/**
 * Search bound sent when the model asks for none. The service clamps every
 * query to the deployment's `maxSearchResults`, so the deployment owns that
 * default rather than this tool.
 */
const DEPLOYMENT_LIMIT = Number.MAX_SAFE_INTEGER

/** What the `type` argument selects, including the directory its value fixes. */
const TYPE_DESCRIPTION = 'Page kind, which fixes the directory the path must live in: overview is the vault root as overview.md, entity is entities/, concept is concepts/, source is sources/, comparison is comparisons/, synthesis is syntheses/.'

/** One failed wiki operation, as every tool reports it. */
interface WikiToolFailure {
  /** Discriminant every wiki tool result carries. */
  readonly ok: false
  /** Stable code naming the class of failure. */
  readonly code: string
  /** What failed, prefixed with the code. */
  readonly message: string
  /** The stored page, present when a revision conflict refused the write so the caller can compare. */
  readonly current?: { readonly path: string; readonly title: string; readonly body: string; readonly revision: string }
}

/** One ranked hit as `wiki_search` reports it. */
interface WikiSearchHitValue {
  /** Vault-relative page path. */
  readonly path: string
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

/** The answer to one `wiki_search` call. */
interface WikiSearchValue {
  /** Discriminant every wiki tool result carries. */
  readonly ok: true
  /** Ranked hits, best match first. */
  readonly hits: WikiSearchHitValue[]
}

/** The answer to one `wiki_read` call. */
interface WikiReadValue {
  /** Discriminant every wiki tool result carries. */
  readonly ok: true
  /** Vault-relative page path. */
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
  readonly tags: string[]
  /** Names other pages may link by. */
  readonly aliases: string[]
  /** Author's stated certainty, or null when unstated. */
  readonly confidence: number | null
  /** Page paths this page disagrees with. */
  readonly contradicts: string[]
  /** Raw source paths this page cites, relative to `raw/`. */
  readonly sources: string[]
  /** Markdown body without the frontmatter block. */
  readonly body: string
  /** Pages this page links to. */
  readonly links: string[]
  /** Pages that link to this page. */
  readonly backlinks: string[]
}

/** The answer to one `wiki_write` call. */
interface WikiWriteValue {
  /** Discriminant every wiki tool result carries. */
  readonly ok: true
  /** Vault-relative path the page was stored at. */
  readonly path: string
  /** SHA-256 of the stored file text; the next write's `expectedRevision`. */
  readonly revision: string
  /** Whether the write brought a new page into the vault. */
  readonly created: boolean
}

/** One raw source and how far it has been integrated. */
interface WikiSourceEntryValue {
  /** Source identity, relative to `raw/`. */
  readonly path: string
  /** Whether a page cites this source. */
  readonly integrated: boolean
  /** Pages citing this source. */
  readonly pages: string[]
}

/** The answer to `wiki_source` with action `list`. */
interface WikiSourceListValue {
  /** Discriminant every wiki tool result carries. */
  readonly ok: true
  /** The answered action. */
  readonly action: 'list'
  /** Every raw source, ordered by path. */
  readonly sources: WikiSourceEntryValue[]
}

/** The answer to `wiki_source` with action `read`. */
interface WikiSourceReadValue {
  /** Discriminant every wiki tool result carries. */
  readonly ok: true
  /** The answered action. */
  readonly action: 'read'
  /** Source identity, relative to `raw/`. */
  readonly path: string
  /** The source text, bounded by the character cap. */
  readonly text: string
  /** Whether the bound cut the text short. */
  readonly truncated: boolean
}

/** The answer to `wiki_source` with action `add`. */
interface WikiSourceAddValue {
  /** Discriminant every wiki tool result carries. */
  readonly ok: true
  /** The answered action. */
  readonly action: 'add'
  /** Identity the source was registered under. */
  readonly path: string
}

/** The answer to `wiki_source` with action `integrate`. */
interface WikiSourceIntegrateValue {
  /** Discriminant every wiki tool result carries. */
  readonly ok: true
  /** The answered action. */
  readonly action: 'integrate'
  /** Source identity, relative to `raw/`. */
  readonly path: string
  /** Pages citing this source. */
  readonly pages: string[]
}

/** Every successful `wiki_source` answer. */
type WikiSourceValue =
  | WikiSourceListValue
  | WikiSourceReadValue
  | WikiSourceAddValue
  | WikiSourceIntegrateValue

/** One defect as `wiki_lint` reports it. */
interface WikiLintFindingValue {
  /** Which class of defect this is. */
  readonly kind: WikiLintKind
  /** The page to open, or null when the finding concerns the vault as a whole. */
  readonly page: string | null
  /** One line naming the defect. */
  readonly detail: string
}

/** The answer to one `wiki_lint` call. */
interface WikiLintValue {
  /** Discriminant every wiki tool result carries. */
  readonly ok: true
  /** Pages examined. */
  readonly pages: number
  /** Raw sources examined. */
  readonly sources: number
  /** Everything the pass found, ordered by kind and then by page. */
  readonly findings: WikiLintFindingValue[]
}

/**
 * Build the output branch every wiki tool returns when the vault refused the
 * operation. Called once per tool so each schema owns its own node.
 * @returns an exact-object schema for a refused operation.
 */
function failureBranch() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', const: false, required: true },
      code: { type: 'string', required: true },
      message: { type: 'string', required: true },
      current: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          title: { type: 'string', required: true },
          body: { type: 'string', required: true },
          revision: { type: 'string', required: true },
        },
      },
    },
  } as const
}

/**
 * Convert one caught value into the failure result every wiki tool returns.
 * @param error - the value thrown by a vault operation.
 * @returns the model-facing failure, or undefined for an error this tool must keep propagating.
 */
function failureOf(error: unknown): WikiToolFailure | undefined {
  if (error instanceof WikiVaultError) {
    const current = error.current
    if (current === undefined) {
      return { ok: false, code: error.code, message: `${error.code}: ${error.message}` }
    }
    return {
      ok: false,
      code: error.code,
      message: `${error.code}: ${error.message}`,
      current: { path: current.path, title: current.frontmatter.title, body: current.body, revision: current.revision },
    }
  }
  if (error instanceof WikiError) {
    return { ok: false, code: error.code, message: `${error.code}: ${error.message}` }
  }
  return undefined
}

/**
 * The failure returned when `wiki_source` lacks an argument its action needs.
 * @param action - the requested action.
 * @param needed - the arguments that action requires.
 * @returns the model-facing failure.
 */
function missingArguments(action: string, needed: string): WikiToolFailure {
  return {
    ok: false,
    code: 'PRISM_WIKI_TOOL_ARGUMENTS',
    message: `PRISM_WIKI_TOOL_ARGUMENTS: action "${action}" requires ${needed}`,
  }
}

/**
 * Whether the vault already holds a page at one path.
 *
 * A page that is present but unreadable — a hand edit left its frontmatter
 * invalid — counts as present: this answers existence, and the write that
 * follows reports any real failure itself. A service-level failure is reported
 * the same way, because the write meets it again immediately.
 * @param vault - the vault service to probe.
 * @param path - page identity to look for.
 * @returns true when the vault holds a page at that path.
 */
async function pageExists(vault: WikiVaultService, path: WikiPagePath): Promise<boolean> {
  try {
    await vault.read(path)
    return true
  } catch (error: unknown) {
    if (error instanceof WikiVaultError) return error.code !== 'WIKI_PAGE_NOT_FOUND'
    if (error instanceof WikiError) return true
    throw error
  }
}

/**
 * Today's date in the `YYYY-MM-DD` form the page frontmatter requires.
 * @returns the current calendar date, UTC.
 */
function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Bind the model-facing tool definitions to the activated vault service.
 * @param vault - the vault service exposed by the registrant context.
 * @returns the tool definitions in registration order.
 */
function createWikiTools(vault: WikiVaultService): ToolDefinition[] {
  const search = defineTool({
    name: 'wiki_search',
    description: 'Search the vault for pages by literal keywords, best match first. Use it to find what the vault already holds before answering or writing.',
    parameters: {
      query: { type: 'string', required: true, description: 'Literal keywords or an exact phrase; an empty string lists pages newest first.' },
      type: { type: 'string', enum: PAGE_TYPES, description: 'Keep only pages of this kind.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Keep only pages carrying every one of these tags.' },
      status: { type: 'string', enum: PAGE_STATUSES, description: 'Keep only pages in this state.' },
      limit: { type: 'integer', description: 'Maximum hits to return; the deployment cap still applies.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              hits: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    type: { type: 'string', enum: PAGE_TYPES, required: true },
                    status: { type: 'string', enum: PAGE_STATUSES, required: true },
                    updated: { type: 'string', required: true },
                    excerpt: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          failureBranch(),
        ],
      } as const,
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: value.message }]
        if (value.hits.length === 0) {
          return [{ type: 'text', text: 'No page matched. Try different keywords, or an empty query to list pages newest first.' }]
        }
        const lines = [`${value.hits.length} page(s), best match first:`]
        for (const hit of value.hits) {
          lines.push(`${hit.path} — ${hit.title} (${hit.type}, ${hit.status}, updated ${hit.updated})`)
          lines.push(`  ${hit.excerpt}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec): Promise<WikiSearchValue | WikiToolFailure> => {
      vault.noteSchemaDue(exec.agent)
      try {
        const filter: WikiSearchFilter = {
          limit: args.limit ?? DEPLOYMENT_LIMIT,
          ...args.type === undefined ? {} : { type: args.type },
          ...args.tags === undefined ? {} : { tags: args.tags },
          ...args.status === undefined ? {} : { status: args.status },
        }
        const hits = await vault.search(args.query, filter)
        return {
          ok: true,
          hits: hits.map(hit => ({
            path: hit.path,
            title: hit.title,
            type: hit.type,
            status: hit.status,
            updated: hit.updated,
            excerpt: hit.excerpt,
          })),
        }
      } catch (error: unknown) {
        const failure = failureOf(error)
        if (failure === undefined) throw error
        return failure
      }
    },
  })

  const read = defineTool({
    name: 'wiki_read',
    description: 'Read one page in full: its frontmatter, body, outgoing links, backlinks, and the raw sources it cites. Read a page before you revise it.',
    parameters: {
      path: { type: 'string', required: true, description: 'Vault-relative page path, for example concepts/retrieval-ranking.md.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              path: { type: 'string', required: true },
              title: { type: 'string', required: true },
              type: { type: 'string', enum: PAGE_TYPES, required: true },
              status: { type: 'string', enum: PAGE_STATUSES, required: true },
              updated: { type: 'string', required: true },
              tags: { type: 'array', required: true, items: { type: 'string' } },
              aliases: { type: 'array', required: true, items: { type: 'string' } },
              confidence: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
              contradicts: { type: 'array', required: true, items: { type: 'string' } },
              sources: { type: 'array', required: true, items: { type: 'string' } },
              body: { type: 'string', required: true },
              links: { type: 'array', required: true, items: { type: 'string' } },
              backlinks: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          failureBranch(),
        ],
      } as const,
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: value.message }]
        const lines = [
          `${value.path} — ${value.title}`,
          `${value.type} · ${value.status} · updated ${value.updated} · confidence ${value.confidence === null ? 'unstated' : value.confidence}`,
        ]
        if (value.tags.length > 0) lines.push(`tags: ${value.tags.join(', ')}`)
        if (value.aliases.length > 0) lines.push(`aliases: ${value.aliases.join(', ')}`)
        if (value.sources.length > 0) lines.push(`cites: ${value.sources.join(', ')}`)
        if (value.contradicts.length > 0) lines.push(`contradicts: ${value.contradicts.join(', ')}`)
        if (value.links.length > 0) lines.push(`links to: ${value.links.join(', ')}`)
        if (value.backlinks.length > 0) lines.push(`linked from: ${value.backlinks.join(', ')}`)
        lines.push('', value.body)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec): Promise<WikiReadValue | WikiToolFailure> => {
      vault.noteSchemaDue(exec.agent)
      try {
        const view = await vault.read(brandPagePath(args.path))
        return {
          ok: true,
          path: view.page.path,
          title: view.page.frontmatter.title,
          type: view.page.frontmatter.type,
          status: view.page.frontmatter.status,
          updated: view.page.frontmatter.updated,
          tags: [...view.page.frontmatter.tags],
          aliases: [...view.page.frontmatter.aliases],
          confidence: view.page.frontmatter.confidence,
          contradicts: [...view.page.frontmatter.contradicts],
          sources: [...view.sources],
          body: view.page.body,
          links: [...view.links],
          backlinks: [...view.backlinks],
        }
      } catch (error: unknown) {
        const failure = failureOf(error)
        if (failure === undefined) throw error
        return failure
      }
    },
  })

  const write = defineTool({
    name: 'wiki_write',
    description: 'Create or replace one vault page and return its new revision. Pass expectedRevision from an earlier read to refuse the write when the page changed meanwhile. Cite every raw source the page draws on.',
    parameters: {
      path: { type: 'string', required: true, description: 'Vault-relative page path including the .md suffix; its directory must match the kind.' },
      title: { type: 'string', required: true, description: 'Page title as a reader sees it.' },
      type: { type: 'string', enum: PAGE_TYPES, required: true, description: TYPE_DESCRIPTION },
      body: { type: 'string', required: true, description: 'Markdown body without the frontmatter block; open with one paragraph saying what the subject is.' },
      status: { type: 'string', enum: PAGE_STATUSES, description: 'Whether the claims still stand; defaults to current.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Lowercase recall tags.' },
      sources: { type: 'array', items: { type: 'string' }, description: 'Raw source paths this page cites, relative to raw/.' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Alternative names other pages may link by.' },
      contradicts: { type: 'array', items: { type: 'string' }, description: 'Page paths this page disagrees with, relative to wiki/.' },
      confidence: { type: 'number', description: 'How certain the page\'s claims are, between 0 and 1; omit when unstated.' },
      expectedRevision: { type: 'string', description: 'Revision an earlier read returned; the write is refused when the stored page no longer hashes to it.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              path: { type: 'string', required: true },
              revision: { type: 'string', required: true },
              created: { type: 'boolean', required: true },
            },
          },
          failureBranch(),
        ],
      } as const,
      render: (_args, value) => {
        if (!value.ok) {
          const current = value.current
          if (current === undefined) return [{ type: 'text', text: value.message }]
          return [{
            type: 'text',
            text: `${value.message}\nThe stored page is:\n\n${current.body}`,
          }]
        }
        return [{ type: 'text', text: `${value.created ? 'Created' : 'Replaced'} ${value.path} (revision ${value.revision}).` }]
      },
    },
    execute: async (args, exec): Promise<WikiWriteValue | WikiToolFailure> => {
      vault.noteSchemaDue(exec.agent)
      try {
        const path = brandPagePath(args.path)
        const created = !(await pageExists(vault, path))
        const frontmatter: WikiFrontmatter = {
          title: args.title,
          type: args.type,
          tags: args.tags ?? [],
          updated: today(),
          status: args.status ?? 'current',
          sources: args.sources ?? [],
          aliases: args.aliases ?? [],
          confidence: args.confidence ?? null,
          contradicts: args.contradicts ?? [],
        }
        const draft: WikiPageDraft = {
          path,
          frontmatter,
          body: args.body,
          ...args.expectedRevision === undefined ? {} : { expectedRevision: args.expectedRevision },
        }
        const page = await vault.write(draft)
        return { ok: true, path: page.path, revision: page.revision, created }
      } catch (error: unknown) {
        const failure = failureOf(error)
        if (failure === undefined) throw error
        return failure
      }
    },
  })

  const source = defineTool({
    name: 'wiki_source',
    description: 'Work with the raw sources under raw/. action list shows what is ingested, read returns one source\'s text, add registers a new source, and integrate confirms the pages that cite one.',
    parameters: {
      action: { type: 'string', enum: SOURCE_ACTIONS, required: true, description: 'Which source operation to run.' },
      path: { type: 'string', description: 'Source identity relative to raw/, required by read, add, and integrate; a leading raw/ is accepted.' },
      text: { type: 'string', description: 'Source text to store unchanged, required by add.' },
      maxChars: { type: 'integer', description: 'Largest slice read may return; the configured cap still applies.' },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              action: { type: 'string', const: 'list', required: true },
              sources: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    path: { type: 'string', required: true },
                    integrated: { type: 'boolean', required: true },
                    pages: { type: 'array', required: true, items: { type: 'string' } },
                  },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              action: { type: 'string', const: 'read', required: true },
              path: { type: 'string', required: true },
              text: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              action: { type: 'string', const: 'add', required: true },
              path: { type: 'string', required: true },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              action: { type: 'string', const: 'integrate', required: true },
              path: { type: 'string', required: true },
              pages: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          failureBranch(),
        ],
      } as const,
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: value.message }]
        if (value.action === 'list') {
          if (value.sources.length === 0) return [{ type: 'text', text: 'raw/ holds no sources.' }]
          const lines = [`${value.sources.length} source(s):`]
          for (const entry of value.sources) {
            lines.push(entry.integrated
              ? `${entry.path} — cited by ${entry.pages.join(', ')}`
              : `${entry.path} — no page cites it yet`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        }
        if (value.action === 'read') {
          const heading = `raw/${value.path}${value.truncated ? ' (truncated)' : ''}`
          return [{ type: 'text', text: `${heading}\n\n${value.text}` }]
        }
        if (value.action === 'add') {
          return [{ type: 'text', text: `Registered raw/${value.path}; no page cites it yet.` }]
        }
        return [{ type: 'text', text: `raw/${value.path} is cited by ${value.pages.join(', ')}.` }]
      },
    },
    execute: async (args, exec): Promise<WikiSourceValue | WikiToolFailure> => {
      vault.noteSchemaDue(exec.agent)
      try {
        if (args.action === 'list') {
          const sources = await vault.sources()
          return {
            ok: true,
            action: 'list',
            sources: sources.map(entry => ({
              path: entry.path,
              integrated: entry.integrated,
              pages: [...entry.pages],
            })),
          }
        }
        if (args.action === 'read') {
          if (args.path === undefined) return missingArguments('read', 'path')
          const slice = await vault.readSource(brandSourcePath(args.path), args.maxChars)
          return { ok: true, action: 'read', path: args.path, text: slice.text, truncated: slice.truncated }
        }
        if (args.action === 'add') {
          if (args.path === undefined || args.text === undefined) return missingArguments('add', 'path and text')
          const added = await vault.addSource(brandSourcePath(args.path), args.text)
          return { ok: true, action: 'add', path: added.path }
        }
        // `integrate` is the only action the schema leaves here.
        if (args.path === undefined) return missingArguments('integrate', 'path')
        const pages = await vault.confirmIntegrated(brandSourcePath(args.path))
        return { ok: true, action: 'integrate', path: args.path, pages: [...pages] }
      } catch (error: unknown) {
        const failure = failureOf(error)
        if (failure === undefined) throw error
        return failure
      }
    },
  })

  const lint = defineTool({
    name: 'wiki_lint',
    description: 'Report the vault\'s health: page and source counts and every finding, including broken links, orphans, unintegrated sources, and contradictions. Run it after a batch of writes.',
    parameters: {},
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', const: true, required: true },
              pages: { type: 'integer', required: true },
              sources: { type: 'integer', required: true },
              findings: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: { type: 'string', enum: LINT_KINDS, required: true },
                    page: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                    detail: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          failureBranch(),
        ],
      } as const,
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: value.message }]
        if (value.findings.length === 0) {
          return [{ type: 'text', text: `${value.pages} page(s) and ${value.sources} source(s); no findings.` }]
        }
        const lines = [`${value.pages} page(s), ${value.sources} source(s), ${value.findings.length} finding(s):`]
        for (const finding of value.findings) {
          lines.push(`${finding.kind}${finding.page === null ? '' : ` ${finding.page}`}: ${finding.detail}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute: async (_args, exec): Promise<WikiLintValue | WikiToolFailure> => {
      vault.noteSchemaDue(exec.agent)
      try {
        const report = await vault.lint()
        return {
          ok: true,
          pages: report.pages,
          sources: report.sources,
          findings: report.findings.map(finding => ({
            kind: finding.kind,
            page: finding.page,
            detail: finding.detail,
          })),
        }
      } catch (error: unknown) {
        const failure = failureOf(error)
        if (failure === undefined) throw error
        return failure
      }
    },
  })

  return [search, read, write, source, lint]
}

/**
 * Register the model-facing vault tools.
 * @param ctx - registrant context carrying `ctx.tools` and `ctx.wikiVault`.
 */
export function apply(ctx: Context): void {
  const vault = ctx.wikiVault
  const dispose = createWikiTools(vault).map(definition => ctx.tools.register(definition))
  ctx.effect(() => () => {
    for (const remove of dispose) remove()
  }, 'prismWiki.tools.register')
}
