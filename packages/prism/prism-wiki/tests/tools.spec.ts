/**
 * The five model-facing vault tools, driven through the real tool registry.
 *
 * A case here asserts what the model observes: the schema it is offered, the
 * text a call returns, the durable page left on disk, and the schema frame the
 * session owes after it touched the vault. Disposal is asserted too, because a
 * registry contribution that outlives its fiber breaks reloads.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  SCHEMA_FRAME_MARKER,
  WIKI_TOOL_NAMES,
  callTool,
  createAgent,
  mountVault,
  mountWiki,
  parameterNames,
  proposeStep,
  schemaFrames,
  toolSchema,
  toolText,
  valueJson,
  wikiToolNames,
  writePage,
} from './fixtures/harness.ts'
import * as WikiTools from '../src/tools.ts'

const owned = new Set<Context>()
const vaults = new Set<string>()

afterEach(async () => {
  await Promise.all([...owned].map(ctx => ctx.fiber.dispose()))
  owned.clear()
  await Promise.all([...vaults].map(dir => rm(dir, { recursive: true, force: true })))
  vaults.clear()
})

/** One empty directory this suite owns as a vault. */
async function scratchVault(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'prism-wiki-tools-'))
  vaults.add(dir)
  return dir
}

/** Boot the plugin's real registries over one fresh vault. */
async function boot(): Promise<{ readonly ctx: Context; readonly root: string }> {
  const root = await scratchVault()
  const ctx = await mountWiki({ vaultRoot: root })
  owned.add(ctx)
  return { ctx, root }
}

/** Every tool with the exact argument names its schema declares. */
const TOOL_PARAMETERS: ReadonlyArray<[string, string[]]> = [
  ['wiki_search', ['query', 'type', 'tags', 'status', 'limit']],
  ['wiki_read', ['path']],
  [
    'wiki_write',
    [
      'path', 'title', 'type', 'body', 'status', 'tags', 'sources', 'aliases', 'contradicts', 'confidence',
      'expectedRevision',
    ],
  ],
  ['wiki_source', ['action', 'path', 'text', 'maxChars']],
  ['wiki_lint', []],
]

/** One call per tool, used to prove every tool marks the session as owing the schema. */
const SCHEMA_DEBT_CALLS: ReadonlyArray<{ readonly name: string; readonly arguments: Record<string, unknown> }> = [
  { name: 'wiki_search', arguments: { query: 'anything' } },
  { name: 'wiki_read', arguments: { path: 'concepts/absent.md' } },
  { name: 'wiki_write', arguments: { path: 'concepts/debt.md', title: 'Debt', type: 'concept', body: 'Body.' } },
  { name: 'wiki_source', arguments: { action: 'list' } },
  { name: 'wiki_lint', arguments: {} },
]

describe('registration', () => {
  it('registers exactly the five model-facing vault tools', async () => {
    const { ctx } = await boot()

    expect(wikiToolNames(ctx)).toEqual([...WIKI_TOOL_NAMES])
  })

  it.each(TOOL_PARAMETERS)('%s declares exactly the arguments it accepts', async (name, keys) => {
    const { ctx } = await boot()
    const schema = toolSchema(ctx, name)
    if (schema === undefined) throw new Error(`no registered schema for ${name}`)

    expect(parameterNames(schema)).toEqual(keys)
  })

  it('removes every tool when the contributing fiber is disposed', async () => {
    const ctx = new Context()
    owned.add(ctx)
    await mountVault(ctx, { vaultRoot: await scratchVault() })
    const fiber = await ctx.plugin(WikiTools)
    expect(wikiToolNames(ctx)).toEqual([...WIKI_TOOL_NAMES])

    await fiber.dispose()

    expect(wikiToolNames(ctx)).toEqual([])
  })
})

describe('writing and reading pages', () => {
  it('round-trips a page through the vault, the disk, and search', async () => {
    const { ctx, root } = await boot()
    const agent = createAgent('tools-round-trip')

    const written = await writePage(ctx, agent, {
      path: 'concepts/retrieval-ranking.md',
      title: 'Retrieval ranking',
      type: 'concept',
      body: 'Ranking orders the candidate set before the model reads it.',
      tags: ['retrieval'],
    })

    expect(written.isError).toBe(false)
    expect(valueJson(written)).toContain('"created":true')
    expect(await readFile(join(root, 'wiki', 'concepts', 'retrieval-ranking.md'), 'utf8'))
      .toContain('title: Retrieval ranking')

    const read = await callTool(ctx, 'wiki_read', { path: 'concepts/retrieval-ranking.md' }, agent)
    expect(toolText(read)).toContain('concepts/retrieval-ranking.md — Retrieval ranking')
    expect(toolText(read)).toContain('Ranking orders the candidate set')

    const found = await callTool(ctx, 'wiki_search', { query: 'retrieval ranking' }, agent)
    expect(toolText(found)).toContain('concepts/retrieval-ranking.md')
  })

  it('finds a page by a CJK query', async () => {
    const { ctx } = await boot()
    const agent = createAgent('tools-cjk')
    await writePage(ctx, agent, {
      path: 'concepts/knowledge-vault.md',
      title: '知识库',
      type: 'concept',
      body: 'LLM wiki 增量构建持久化知识库，而不是每次都重新推导。',
      tags: ['wiki'],
    })

    const found = await callTool(ctx, 'wiki_search', { query: '知识库' }, agent)

    expect(toolText(found)).toContain('concepts/knowledge-vault.md')
    expect(toolText(found)).toContain('知识库')
  })

  it('narrows a search by the filter the model supplied', async () => {
    const { ctx } = await boot()
    const agent = createAgent('tools-filter')
    await writePage(ctx, agent, {
      path: 'concepts/shared-concept.md', title: 'Shared concept', type: 'concept', body: 'A shared term.', tags: ['x'],
    })
    await writePage(ctx, agent, {
      path: 'entities/shared-entity.md', title: 'Shared entity', type: 'entity', body: 'A shared term.', tags: ['x'],
    })

    const narrowed = await callTool(ctx, 'wiki_search', { query: 'shared term', type: 'entity' }, agent)

    expect(toolText(narrowed)).toContain('entities/shared-entity.md')
    expect(toolText(narrowed)).not.toContain('concepts/shared-concept.md')
  })

  it('returns the revision conflict instead of throwing when the expected revision is stale', async () => {
    const { ctx, root } = await boot()
    const agent = createAgent('tools-conflict')
    const first = await writePage(ctx, agent, {
      path: 'concepts/kept.md', title: 'Kept', type: 'concept', body: 'Original body.',
    })
    const revision = /"revision":"([0-9a-f]{64})"/u.exec(valueJson(first))?.[1]
    if (revision === undefined) throw new Error(`the write returned no revision: ${valueJson(first)}`)

    const stale = await callTool(ctx, 'wiki_write', {
      path: 'concepts/kept.md',
      title: 'Kept',
      type: 'concept',
      body: 'Overwritten body.',
      expectedRevision: '0'.repeat(64),
    }, agent)

    expect(stale.isError).toBe(false)
    expect(toolText(stale)).toContain('WIKI_REVISION_CONFLICT')
    expect(valueJson(stale)).toContain('"code":"WIKI_REVISION_CONFLICT"')
    // The refusal carries the page that is actually stored, so the caller can compare.
    expect(valueJson(stale)).toContain('"current"')
    expect(valueJson(stale)).toContain('Original body.')
    expect(await readFile(join(root, 'wiki', 'concepts', 'kept.md'), 'utf8')).toContain('Original body.')

    // The conflict is about the revision, not a blanket refusal: the revision
    // the first write returned is still accepted.
    const replaced = await callTool(ctx, 'wiki_write', {
      path: 'concepts/kept.md',
      title: 'Kept',
      type: 'concept',
      body: 'Replaced body.',
      expectedRevision: revision,
    }, agent)

    expect(valueJson(replaced)).toContain('"created":false')
    expect(await readFile(join(root, 'wiki', 'concepts', 'kept.md'), 'utf8')).toContain('Replaced body.')
  })

  it('rejects a page whose path disagrees with its kind', async () => {
    const { ctx } = await boot()
    const agent = createAgent('tools-misfiled')

    const refused = await callTool(ctx, 'wiki_write', {
      path: 'entities/misfiled.md', title: 'Misfiled', type: 'concept', body: 'Body.',
    }, agent)

    expect(refused.isError).toBe(false)
    expect(valueJson(refused)).toContain('WIKI_FRONTMATTER_INVALID')
  })
})

describe('raw sources', () => {
  it('reports an added source as unintegrated and refuses to integrate it', async () => {
    const { ctx } = await boot()
    const agent = createAgent('tools-source-open')

    const added = await callTool(ctx, 'wiki_source', {
      action: 'add', path: 'notes/paper.md', text: 'The paper says so.',
    }, agent)
    expect(toolText(added)).toContain('Registered raw/notes/paper.md')

    const listed = await callTool(ctx, 'wiki_source', { action: 'list' }, agent)
    expect(valueJson(listed)).toContain('"path":"notes/paper.md"')
    expect(valueJson(listed)).toContain('"integrated":false')

    const refused = await callTool(ctx, 'wiki_source', { action: 'integrate', path: 'notes/paper.md' }, agent)
    expect(refused.isError).toBe(false)
    expect(toolText(refused)).toContain('PRISM_WIKI_SOURCE_NOT_INTEGRATED')
  })

  it('reads a bounded slice of a source and integrates it once a page cites it', async () => {
    const { ctx } = await boot()
    const agent = createAgent('tools-source-integrated')
    await callTool(ctx, 'wiki_source', { action: 'add', path: 'notes/paper.md', text: 'The paper says so.' }, agent)

    const slice = await callTool(ctx, 'wiki_source', { action: 'read', path: 'notes/paper.md', maxChars: 9 }, agent)
    expect(toolText(slice)).toContain('The paper')
    expect(valueJson(slice)).toContain('"truncated":true')

    await writePage(ctx, agent, {
      path: 'sources/paper.md',
      title: 'The paper',
      type: 'source',
      body: 'Notes drawn from the paper.',
      sources: ['notes/paper.md'],
    })

    const integrated = await callTool(ctx, 'wiki_source', { action: 'integrate', path: 'notes/paper.md' }, agent)
    expect(valueJson(integrated)).toContain('"action":"integrate"')
    expect(valueJson(integrated)).toContain('sources/paper.md')
    expect(valueJson(await callTool(ctx, 'wiki_source', { action: 'list' }, agent))).toContain('"integrated":true')
  })

  it('reports the health of the vault', async () => {
    const { ctx } = await boot()
    const agent = createAgent('tools-lint')
    await writePage(ctx, agent, { path: 'concepts/one.md', title: 'One', type: 'concept', body: 'One body.' })
    await callTool(ctx, 'wiki_source', { action: 'add', path: 'notes/note.md', text: 'A note.' }, agent)

    const report = await callTool(ctx, 'wiki_lint', {}, agent)

    expect(valueJson(report)).toContain('"ok":true')
    expect(valueJson(report)).toContain('"pages":1')
    expect(toolText(report)).toContain('1 page(s)')
    // A finding about the vault as a whole names no page; a page finding does.
    expect(toolText(report)).toContain('orphan-page concepts/one.md:')
    expect(toolText(report)).toContain('unintegrated-source: ')
  })
})

describe('the vault schema debt', () => {
  it('owes nothing to a session that has not touched the vault', async () => {
    const { ctx } = await boot()
    const agent = createAgent('tools-untouched')

    expect(schemaFrames(await proposeStep(ctx, agent))).toEqual([])
  })

  it.each(SCHEMA_DEBT_CALLS)('$name marks its session as owing the vault schema exactly once', async (call) => {
    const { ctx } = await boot()
    const agent = createAgent(`tools-debt-${call.name}`)

    await callTool(ctx, call.name, call.arguments, agent)

    const owed = schemaFrames(await proposeStep(ctx, agent))
    expect(owed).toHaveLength(1)
    expect(owed.join('\n')).toContain(SCHEMA_FRAME_MARKER)
    expect(owed.join('\n')).toContain('# Wiki schema')
    expect(schemaFrames(await proposeStep(ctx, agent))).toEqual([])
  })

  it('delivers the vault\'s own edited schema rather than a shipped copy', async () => {
    const root = await scratchVault()
    await writeFile(join(root, 'AGENTS.md'), '# House rules\n\nKeep pages short.\n', 'utf8')
    const ctx = await mountWiki({ vaultRoot: root })
    owned.add(ctx)
    const agent = createAgent('tools-edited-schema')

    await callTool(ctx, 'wiki_lint', {}, agent)

    expect(schemaFrames(await proposeStep(ctx, agent)).join('\n')).toContain('Keep pages short.')
  })

  it('skips the frame instead of failing the step when the schema file is gone', async () => {
    const root = await scratchVault()
    const ctx = await mountWiki({ vaultRoot: root })
    owned.add(ctx)
    const agent = createAgent('tools-missing-schema')

    await callTool(ctx, 'wiki_lint', {}, agent)
    await rm(join(root, 'AGENTS.md'), { force: true })

    const decision = await proposeStep(ctx, agent)
    expect(decision.kind).toBe('enter')
    expect(schemaFrames(decision)).toEqual([])
    // The debt is settled: a repaired vault does not replay the frame.
    expect(schemaFrames(await proposeStep(ctx, agent))).toEqual([])
  })

  it('skips the frame when the deployment configured no vault root', async () => {
    const ctx = new Context()
    owned.add(ctx)
    await mountVault(ctx, { vaultRoot: '' })
    const agent = createAgent('tools-no-root')

    ctx.wikiVault.noteSchemaDue(agent)

    expect(schemaFrames(await proposeStep(ctx, agent))).toEqual([])
  })

  it('fails the step when the schema read fails for a reason the vault does not own', async () => {
    const root = await scratchVault()
    const ctx = await mountWiki({ vaultRoot: root })
    owned.add(ctx)
    const agent = createAgent('tools-broken-schema')

    await callTool(ctx, 'wiki_lint', {}, agent)
    await rm(join(root, 'AGENTS.md'), { force: true })
    await mkdir(join(root, 'AGENTS.md'))

    await expect(proposeStep(ctx, agent)).rejects.toThrow(/EISDIR|directory/iu)
  })
})

describe('wiki_source argument gaps', () => {
  it.each([
    ['read', { action: 'read' }, 'path'],
    ['add without a path', { action: 'add', text: 'Text.' }, 'path and text'],
    ['add without text', { action: 'add', path: 'notes/x.md' }, 'path and text'],
    ['integrate', { action: 'integrate' }, 'path'],
  ])('refuses %s that is missing its argument', async (label, args, needed) => {
    const { ctx } = await boot()
    const agent = createAgent(`tools-arg-gap-${label}`)

    const refused = await callTool(ctx, 'wiki_source', args, agent)

    expect(refused.isError).toBe(false)
    expect(valueJson(refused)).toContain('PRISM_WIKI_TOOL_ARGUMENTS')
    expect(valueJson(refused)).toContain(needed)
  })

  it('renders an untruncated source read without the truncated mark', async () => {
    const { ctx } = await boot()
    const agent = createAgent('tools-source-whole')
    await callTool(ctx, 'wiki_source', { action: 'add', path: 'notes/whole.md', text: 'Whole text.' }, agent)

    const slice = await callTool(ctx, 'wiki_source', { action: 'read', path: 'notes/whole.md', maxChars: 100 }, agent)

    expect(toolText(slice)).toContain('raw/notes/whole.md\n')
    expect(toolText(slice)).not.toContain('(truncated)')
  })
})

describe('search rendering and narrowing', () => {
  it('renders the empty answer when no page matches', async () => {
    const { ctx } = await boot()
    const agent = createAgent('tools-search-empty')

    const empty = await callTool(ctx, 'wiki_search', { query: 'nothing at all' }, agent)

    expect(toolText(empty)).toContain('No page matched')
  })

  it('narrows by the tags and status the model supplies', async () => {
    const { ctx } = await boot()
    const agent = createAgent('tools-search-tags-status')
    await writePage(ctx, agent, {
      path: 'concepts/matching.md', title: 'Matching', type: 'concept', body: 'Shared text.', tags: ['wanted'],
    })
    await writePage(ctx, agent, {
      path: 'concepts/other.md', title: 'Other', type: 'concept', body: 'Shared text.', tags: ['unwanted'],
    })

    const narrowed = await callTool(ctx, 'wiki_search', {
      query: 'shared text', tags: ['wanted'], status: 'current',
    }, agent)

    expect(valueJson(narrowed)).toContain('concepts/matching.md')
    expect(valueJson(narrowed)).not.toContain('concepts/other.md')
  })
})

describe('read rendering of a fully populated page', () => {
  it('renders every frontmatter field and relation the page carries', async () => {
    const { ctx } = await boot()
    const agent = createAgent('tools-read-rich')
    await callTool(ctx, 'wiki_source', { action: 'add', path: 'notes/note.md', text: 'A note.' }, agent)
    await callTool(ctx, 'wiki_write', {
      path: 'concepts/rich.md',
      title: 'Rich',
      type: 'concept',
      body: 'See [[Beta]].',
      tags: ['one', 'two'],
      aliases: ['Rich Page'],
      sources: ['notes/note.md'],
      contradicts: ['concepts/beta.md'],
      confidence: 0.5,
    }, agent)
    await writePage(ctx, agent, { path: 'concepts/beta.md', title: 'Beta', type: 'concept', body: 'See [[Rich Page]].' })

    const text = toolText(await callTool(ctx, 'wiki_read', { path: 'concepts/rich.md' }, agent))

    expect(text).toContain('confidence 0.5')
    expect(text).toContain('tags: one, two')
    expect(text).toContain('aliases: Rich Page')
    expect(text).toContain('cites: notes/note.md')
    expect(text).toContain('contradicts: concepts/beta.md')
    expect(text).toContain('links to: concepts/beta.md')
    expect(text).toContain('linked from: concepts/beta.md')
  })

  it('treats a page that exists but cannot be parsed as present, and replaces it', async () => {
    const { ctx, root } = await boot()
    const agent = createAgent('tools-write-over-broken')
    await ctx.wikiVault.ready()
    await writeFile(join(root, 'wiki', 'concepts', 'broken.md'), 'not a page at all\n', 'utf8')

    const replaced = await callTool(ctx, 'wiki_write', {
      path: 'concepts/broken.md', title: 'Repaired', type: 'concept', body: 'Repaired body.',
    }, agent)

    expect(valueJson(replaced)).toContain('"created":false')
    expect(await readFile(join(root, 'wiki', 'concepts', 'broken.md'), 'utf8')).toContain('Repaired body.')
  })
})

describe('failures a tool does not classify', () => {
  it('reports a vault without a configured root as a failed operation', async () => {
    const ctx = await mountWiki({ vaultRoot: '' })
    owned.add(ctx)
    const agent = createAgent('tools-no-root')

    const refused = await callTool(ctx, 'wiki_write', {
      path: 'concepts/never.md', title: 'Never', type: 'concept', body: 'Body.',
    }, agent)

    expect(refused.isError).toBe(false)
    expect(valueJson(refused)).toContain('PRISM_WIKI_NO_VAULT_ROOT')
    expect(toolText(refused)).toContain('PRISM_WIKI_NO_VAULT_ROOT')

    const lint = await callTool(ctx, 'wiki_lint', {}, agent)
    expect(toolText(lint)).toContain('PRISM_WIKI_NO_VAULT_ROOT')

    const search = await callTool(ctx, 'wiki_search', { query: 'anything' }, agent)
    expect(toolText(search)).toContain('PRISM_WIKI_NO_VAULT_ROOT')

    const read = await callTool(ctx, 'wiki_read', { path: 'concepts/never.md' }, agent)
    expect(toolText(read)).toContain('PRISM_WIKI_NO_VAULT_ROOT')
  })

  it.each([
    ['wiki_read', (path: string) => ({ path })],
    ['wiki_write', (path: string) => ({ path, title: 'Solid', type: 'concept', body: 'Body.' })],
  ])('raises %s over a page path the filesystem does not classify', async (name, argsOf) => {
    const { ctx, root } = await boot()
    const agent = createAgent(`tools-unclassified-${name}`)
    await ctx.wikiVault.ready()
    await mkdir(join(root, 'wiki', 'concepts', 'solid.md'))

    const raised = await callTool(ctx, name, argsOf('concepts/solid.md'), agent)

    expect(raised.isError).toBe(true)
    expect(toolText(raised)).toMatch(/EISDIR|directory/iu)
  })

  it('raises a source read the filesystem does not classify', async () => {
    const { ctx, root } = await boot()
    const agent = createAgent('tools-unclassified-source')
    await ctx.wikiVault.ready()
    await mkdir(join(root, 'raw', 'notes', 'solid.md'), { recursive: true })

    const raised = await callTool(ctx, 'wiki_source', { action: 'read', path: 'notes/solid.md' }, agent)

    expect(raised.isError).toBe(true)
    expect(toolText(raised)).toMatch(/EISDIR|directory/iu)
  })

  it('raises a search whose cache location is not a database file', async () => {
    const { ctx, root } = await boot()
    const agent = createAgent('tools-unclassified-search')
    await ctx.wikiVault.ready()
    await mkdir(join(root, '.wiki', 'index.db'), { recursive: true })
    // The recovery path discards the cache file; an occupied directory cannot be discarded.
    await writeFile(join(root, '.wiki', 'index.db', 'keeper.txt'), 'occupied', 'utf8')

    const raised = await callTool(ctx, 'wiki_search', { query: 'anything' }, agent)

    expect(raised.isError).toBe(true)
    expect(toolText(raised)).toMatch(/ENOTEMPTY|directory|index\.db/iu)
  })

  it('raises a lint pass whose vault cannot be opened', async () => {
    const root = await scratchVault()
    // A directory named AGENTS.md passes the adoption check, then cannot be seeded.
    await mkdir(join(root, 'AGENTS.md'))
    const ctx = await mountWiki({ vaultRoot: root })
    owned.add(ctx)
    const agent = createAgent('tools-unclassified-lint')

    const raised = await callTool(ctx, 'wiki_lint', {}, agent)

    expect(raised.isError).toBe(true)
    expect(toolText(raised)).toMatch(/AGENTS\.md|EPERM|EISDIR|ENOTEMPTY|EEXIST/iu)
  })
})
