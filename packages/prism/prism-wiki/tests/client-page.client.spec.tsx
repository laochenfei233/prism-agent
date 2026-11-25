// @vitest-environment jsdom
/**
 * Knowledge page presentation: the vault tree, the reader with its wikilinks
 * and backlinks, ranked search, and the editor's save and conflict surfaces.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
// Type-only: activate the `main` keyed slot and the global standard seats this
// page's composed props derive from.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { WikiRequestError } from '../src/client/api.ts'
// Type-only: activate this namespace's dictionary merge.
import type {} from '../src/client/index.tsx'
import { WikiPage, type WikiPageFace, type WikiPageProps } from '../src/client/WikiPage.tsx'
import { en } from '../src/client/locales.ts'
import type { WikiFrontmatter, WikiPagePath, WikiPageStatus, WikiSearchHit } from '../src/types.ts'
import type {
  WikiLintValue, WikiListValue, WikiPageSummary, WikiReadValue, WikiSaveRequest, WikiSaveValue,
  WikiSearchValue, WikiSourceRequest, WikiSourceValue,
} from '../src/web-contract.ts'

afterEach(cleanup)

/** One page the fixture vault serves. */
interface FixturePage {
  readonly title: string
  readonly body: string
  readonly backlinks: readonly string[]
}

/** The two interlinked pages this vault holds. */
const PAGES: Readonly<Record<string, FixturePage>> = {
  'concepts/alpha.md': {
    title: 'Alpha',
    body: 'Alpha body.\n\nSee [[Beta]].',
    backlinks: ['concepts/beta.md'],
  },
  'concepts/beta.md': {
    title: 'Beta',
    body: 'Beta body.',
    backlinks: ['concepts/alpha.md'],
  },
}

/** Brand one vault-relative page path. */
const pagePath = (value: string): WikiPagePath => brandString<WikiPagePath>(value)

/** The frontmatter of one served page. */
function frontmatter(title: string): WikiFrontmatter {
  return {
    title,
    type: 'concept',
    tags: ['alpha'],
    updated: '2026-10-07',
    status: 'current',
    sources: [],
    aliases: [],
    confidence: null,
    contradicts: [],
  }
}

/** One vault-tree row as the host answers it. */
function summary(path: string, status: WikiPageStatus = 'current'): WikiPageSummary {
  const page = PAGES[path]
  return {
    path,
    title: page === undefined ? path : page.title,
    type: 'concept',
    status,
    updated: '2026-10-07',
    tags: ['alpha'],
  }
}

/** One page read as the host answers it. */
function readValue(path: string): WikiReadValue {
  const page = PAGES[path] ?? { title: path, body: '', backlinks: [] }
  return {
    page: { path, frontmatter: frontmatter(page.title), body: page.body, revision: 'rev-1' },
    links: [],
    backlinks: [...page.backlinks],
    sources: [],
  }
}

/** One ranked hit as the host answers it. */
const hit: WikiSearchHit = {
  path: pagePath('concepts/alpha.md'),
  title: 'Alpha',
  type: 'concept',
  status: 'current',
  updated: '2026-10-07',
  excerpt: 'the needle excerpt',
}

/** The page face the component is rendered with; every operation is a spy unless a case overrides it. */
function face(overrides: Partial<WikiPageFace> = {}): WikiPageFace {
  return {
    list: vi.fn(async (): Promise<WikiListValue> => ({
      pages: [summary('concepts/alpha.md'), summary('concepts/beta.md')],
    })),
    read: vi.fn(async (path: string): Promise<WikiReadValue> => readValue(path)),
    search: vi.fn(async (): Promise<WikiSearchValue> => ({ hits: [hit] })),
    save: vi.fn(async (request: WikiSaveRequest): Promise<WikiSaveValue> => ({
      page: {
        path: request.path,
        frontmatter: request.frontmatter,
        body: request.body,
        revision: 'rev-2',
      },
    })),
    source: vi.fn(async (request: WikiSourceRequest): Promise<WikiSourceValue> => ({
      path: request.path,
      text: 'The source text.',
      truncated: false,
    })),
    lint: vi.fn(async (): Promise<WikiLintValue> => ({
      report: { pages: 2, sources: 0, findings: [] },
    })),
    notify: vi.fn(),
    ...overrides,
  }
}

/** The global standard seats every root-scope component is handed; the fixture never drives them. */
function standardSeats() {
  const unused = (): never => { throw new Error('the page fixture provides no global state') }
  return {
    usePanelInfo: unused,
    useWorkspaces: unused,
    useSessions: unused,
    useSessionStatus: unused,
    useSessionRetainInfo: unused,
    useResource: unused,
    useRemoteAccess: unused,
    useSessionAccess: unused,
    useContextMenu: unused,
    useWorkspaceAccess: unused,
  }
}

// The seat's key domain is the wiki dictionary plus the shared common
// vocabulary; the stub mirrors the real lookup chain and falls back to the key.
const translate: WikiPageProps['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/gu, (match, name: string) => name in params ? String(params[name]) : match)
}

/** Render the page with the standard seats and the supplied wiki face. */
function renderPage(wikiFace: WikiPageFace): ReturnType<typeof render> {
  const props: WikiPageProps = { ...standardSeats(), t: translate, ...wikiFace }
  return render(<WikiPage {...props} />)
}

/** Open one vault page from the tree. */
async function openPage(title: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(title, 'u') }))
  return await screen.findByRole('article')
}

describe('knowledge page', () => {
  it('lists the vault pages and opens the one the reader picks', async () => {
    const wikiFace = face()
    renderPage(wikiFace)

    expect(await screen.findByRole('button', { name: /Alpha/u })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Beta/u })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Alpha/u }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Alpha' })).toBeTruthy()
    expect(await screen.findByText('Alpha body.')).toBeTruthy()
    expect(wikiFace.read).toHaveBeenCalledWith('concepts/alpha.md')

    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await waitFor(() => expect(wikiFace.list).toHaveBeenCalledTimes(2))
  })

  it('follows a wikilink to the page it names', async () => {
    const wikiFace = face()
    renderPage(wikiFace)

    const article = await openPage('Alpha')
    fireEvent.click(within(article).getByRole('button', { name: 'Beta' }))

    expect(await screen.findByText('Beta body.')).toBeTruthy()
    expect(wikiFace.read).toHaveBeenCalledWith('concepts/beta.md')
  })

  it('lists the pages that link to the open page, and follows one', async () => {
    renderPage(face())

    const article = await openPage('Alpha')

    expect(within(article).getByRole('heading', { level: 3, name: en.backlinks })).toBeTruthy()
    const backlink = within(article).getByRole('button', { name: 'concepts/beta.md' })
    expect(backlink).toBeTruthy()

    fireEvent.click(backlink)
    expect(await screen.findByText('Beta body.')).toBeTruthy()
  })

  it('answers the reader query with the ranked hits', async () => {
    const wikiFace = face()
    renderPage(wikiFace)
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.change(screen.getByLabelText(en.searchPlaceholder), { target: { value: 'needle' } })
    fireEvent.click(screen.getByRole('button', { name: en.search }))

    expect(await screen.findByText('the needle excerpt')).toBeTruthy()
    expect(wikiFace.search).toHaveBeenCalledWith({ query: 'needle', limit: 30 })
  })

  it('saves the reader draft with the revision the page loaded', async () => {
    const wikiFace = face()
    renderPage(wikiFace)
    await openPage('Alpha')

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    fireEvent.change(screen.getByLabelText(en.fieldBody), { target: { value: 'Edited body.' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => {
      expect(wikiFace.save).toHaveBeenCalledWith(expect.objectContaining({
        path: 'concepts/alpha.md',
        body: 'Edited body.',
        expectedRevision: 'rev-1',
      }))
    })
  })

  it('reports a refused revision beside the kept draft', async () => {
    const wikiFace = face({
      save: vi.fn(async (): Promise<WikiSaveValue> => {
        throw new WikiRequestError('prism-wiki/revision-conflict', 'This page changed elsewhere.')
      }),
    })
    renderPage(wikiFace)
    await openPage('Alpha')

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    fireEvent.change(screen.getByLabelText(en.fieldBody), { target: { value: 'My kept draft.' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    const notice = await screen.findByRole('alert')
    expect(notice.textContent).toContain(en.conflict)

    const draft = screen.getByLabelText(en.fieldBody)
    if (!(draft instanceof HTMLTextAreaElement)) throw new Error('the editor draft is not a textarea')
    expect(draft.value).toBe('My kept draft.')
    expect(wikiFace.notify).not.toHaveBeenCalled()
  })

  it('shows the stored page beside the retained draft after a conflict', async () => {
    const wikiFace = face({
      save: vi.fn(async (): Promise<WikiSaveValue> => {
        throw new WikiRequestError('prism-wiki/revision-conflict', 'This page changed elsewhere.', {
          path: 'concepts/alpha.md',
          frontmatter: frontmatter('Alpha'),
          body: 'The stored body.',
          revision: 'rev-9',
        })
      }),
    })
    renderPage(wikiFace)
    await openPage('Alpha')

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    fireEvent.change(screen.getByLabelText(en.fieldBody), { target: { value: 'My kept draft.' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(await screen.findByText(en.conflictStored)).toBeTruthy()
    expect(screen.getByText('The stored body.')).toBeTruthy()
    const draft = screen.getByLabelText(en.fieldBody)
    if (!(draft instanceof HTMLTextAreaElement)) throw new Error('the editor draft is not a textarea')
    expect(draft.value).toBe('My kept draft.')
  })

  it('opens the overview page when the vault has one', async () => {
    const wikiFace = face({
      list: vi.fn(async (): Promise<WikiListValue> => ({
        pages: [{ ...summary('concepts/alpha.md'), path: 'overview.md', title: 'Front door' }, summary('concepts/alpha.md')],
      })),
      read: vi.fn(async (path: string): Promise<WikiReadValue> => ({
        page: { path, frontmatter: frontmatter('Front door'), body: 'What this vault covers.', revision: 'rev-1' },
        links: [],
        backlinks: [],
        sources: [],
      })),
    })
    renderPage(wikiFace)

    expect(await screen.findByText('What this vault covers.')).toBeTruthy()
    expect(wikiFace.read).toHaveBeenCalledWith('overview.md')
  })

  it('opens a draft for a wikilink that resolves to no page', async () => {
    const wikiFace = face({
      read: vi.fn(async (path: string): Promise<WikiReadValue> => ({
        page: { path, frontmatter: frontmatter('Alpha'), body: 'See [[Gamma Ray]].', revision: 'rev-1' },
        links: [],
        backlinks: [],
        sources: [],
      })),
    })
    renderPage(wikiFace)

    const article = await openPage('Alpha')
    fireEvent.click(within(article).getByRole('button', { name: 'Gamma Ray' }))

    expect(await screen.findByRole('heading', { level: 2, name: en.editorNewFrom.replace('{target}', 'Gamma Ray') }))
      .toBeTruthy()
    expect(pathField().value).toBe('concepts/gamma-ray.md')
    expect(titleField().value).toBe('Gamma Ray')
  })

  it.each([
    ['entities/Acme Corp', 'entities/acme-corp.md'],
    ['notes/loose end', 'concepts/loose-end.md'],
  ])('files a draft for %s at %s', async (target, expected) => {
    const wikiFace = face({
      read: vi.fn(async (path: string): Promise<WikiReadValue> => ({
        page: { path, frontmatter: frontmatter('Alpha'), body: `See [[${target}]].`, revision: 'rev-1' },
        links: [],
        backlinks: [],
        sources: [],
      })),
    })
    renderPage(wikiFace)

    const article = await openPage('Alpha')
    fireEvent.click(within(article).getByRole('button', { name: target }))

    expect(pathField().value).toBe(expected)
  })

  it('derives a new page path from its title until the reader types one', async () => {
    renderPage(face())
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.click(screen.getByRole('button', { name: en.newPage }))
    fireEvent.change(titleField(), { target: { value: 'Attention Span' } })
    expect(pathField().value).toBe('concepts/attention-span.md')

    fireEvent.change(screen.getByLabelText(en.fieldType), { target: { value: 'entity' } })
    expect(pathField().value).toBe('entities/attention-span.md')

    fireEvent.change(pathField(), { target: { value: 'entities/custom.md' } })
    fireEvent.change(titleField(), { target: { value: 'Renamed Page' } })
    expect(pathField().value).toBe('entities/custom.md')
    fireEvent.change(screen.getByLabelText(en.fieldType), { target: { value: 'concept' } })
    expect(pathField().value).toBe('entities/custom.md')
  })

  it('refuses a new page whose path the vault already holds', async () => {
    const wikiFace = face()
    renderPage(wikiFace)
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.click(screen.getByRole('button', { name: en.newPage }))
    fireEvent.change(titleField(), { target: { value: 'Alpha' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    const notice = await screen.findByRole('alert')
    expect(notice.textContent).toContain(en.pageExists.replace('{path}', 'concepts/alpha.md'))
    expect(wikiFace.save).not.toHaveBeenCalled()
  })

  it('reads one cited raw source into a panel beside the page', async () => {
    const wikiFace = face({
      read: vi.fn(async (path: string): Promise<WikiReadValue> => ({
        page: { path, frontmatter: frontmatter('Alpha'), body: 'Alpha body.', revision: 'rev-1' },
        links: [],
        backlinks: [],
        sources: ['notes/paper.md'],
      })),
    })
    renderPage(wikiFace)
    await openPage('Alpha')

    fireEvent.click(screen.getByRole('button', { name: 'notes/paper.md' }))

    expect(await screen.findByText('The source text.')).toBeTruthy()
    expect(wikiFace.source).toHaveBeenCalledWith({ path: 'notes/paper.md' })
  })

  it('toggles the catalog column from the narrow-layout control', async () => {
    renderPage(face())
    await screen.findByRole('button', { name: /Alpha/u })

    const toggle = screen.getByRole('button', { name: en.tree })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('vault states', () => {
  it('shows the empty-vault placeholders', async () => {
    const wikiFace = face({ list: vi.fn(async (): Promise<WikiListValue> => ({ pages: [] })) })
    renderPage(wikiFace)

    expect(await screen.findByText(en.vaultEmpty)).toBeTruthy()
    expect(screen.getByText(en.vaultEmptyHint)).toBeTruthy()
  })

  it('reports a failed listing and dismisses the notice', async () => {
    const wikiFace = face({
      list: vi.fn(async (): Promise<WikiListValue> => { throw 'disk gone' }),
    })
    renderPage(wikiFace)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(en.loadFailed.replace('{reason}', 'disk gone'))

    fireEvent.click(within(alert).getByRole('button', { name: en.dismiss }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reports a failed page read and dismisses the notice', async () => {
    const wikiFace = face({
      read: vi.fn(async (): Promise<WikiReadValue> => { throw new Error('the page vanished') }),
    })
    renderPage(wikiFace)
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.click(screen.getByRole('button', { name: /Alpha/u }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('the page vanished')
    fireEvent.click(within(alert).getByRole('button', { name: en.dismiss }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders every page state tone in the tree', async () => {
    const wikiFace = face({
      list: vi.fn(async (): Promise<WikiListValue> => ({
        pages: [
          summary('concepts/alpha.md'),
          { ...summary('concepts/beta.md'), status: 'disputed' },
          { ...summary('concepts/gamma.md'), status: 'stub' },
          { ...summary('concepts/delta.md'), status: 'superseded' },
        ],
      })),
    })
    renderPage(wikiFace)

    expect(await screen.findByText(en.statusDisputed)).toBeTruthy()
    // Every state appears twice: its filter pill and its tree-row tag.
    expect(screen.getAllByText(en.statusDisputed)).toHaveLength(2)
    expect(screen.getAllByText(en.statusStub)).toHaveLength(2)
    expect(screen.getAllByText(en.statusSuperseded)).toHaveLength(2)
    expect(screen.getAllByText(en.statusCurrent).length).toBeGreaterThanOrEqual(2)
  })
})

describe('the search tab', () => {
  it('starts idle, searches on Enter, and reports no hits', async () => {
    const wikiFace = face({ search: vi.fn(async (): Promise<WikiSearchValue> => ({ hits: [] })) })
    renderPage(wikiFace)
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.click(screen.getByRole('tab', { name: en.tabSearch }))

    const panel = screen.getByRole('tabpanel')
    expect(within(panel).getByText(en.searchEmpty)).toBeTruthy()
    expect(within(panel).getByText(en.searchHint)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en.searchPlaceholder), { target: { value: 'ghost' } })
    fireEvent.keyDown(screen.getByLabelText(en.searchPlaceholder), { key: 'a' })
    expect(wikiFace.search).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByLabelText(en.searchPlaceholder), { key: 'Enter' })

    expect(await within(panel).findByText(en.searchNone)).toBeTruthy()
    expect(wikiFace.search).toHaveBeenCalledWith({ query: 'ghost', limit: 30 })
  })

  it('shows the searching state, then the hits, and opens one', async () => {
    let resolveSearch: (value: WikiSearchValue) => void = () => {}
    const wikiFace = face({
      search: vi.fn((): Promise<WikiSearchValue> => new Promise(resolve => { resolveSearch = resolve })),
    })
    renderPage(wikiFace)
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.click(screen.getByRole('button', { name: en.search }))
    const panel = screen.getByRole('tabpanel')
    expect(await within(panel).findByText(en.searching)).toBeTruthy()

    resolveSearch({ hits: [{ ...hit, title: 'Alpha', path: pagePath('concepts/alpha.md') }] })
    expect(await within(panel).findByText(en.hitsCount.replace('{count}', '1'))).toBeTruthy()

    fireEvent.click(within(panel).getByRole('button', { name: /the needle excerpt/u }))
    expect(await screen.findByRole('article')).toBeTruthy()
    expect(wikiFace.read).toHaveBeenCalledWith('concepts/alpha.md')
  })

  it('reports a failed search', async () => {
    const wikiFace = face({
      search: vi.fn(async (): Promise<WikiSearchValue> => { throw new Error('the index is closed') }),
    })
    renderPage(wikiFace)
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.click(screen.getByRole('button', { name: en.search }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('the index is closed')
  })
})

describe('the health tab', () => {
  it('runs the check when opened and reports a clean vault', async () => {
    const wikiFace = face()
    renderPage(wikiFace)
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.click(screen.getByRole('tab', { name: en.tabHealth }))

    const panel = await screen.findByRole('tabpanel')
    expect(await within(panel).findByText(en.lintClean)).toBeTruthy()
    expect(within(panel).getByText(en.lintSummary.replace('{pages}', '2').replace('{sources}', '0'))).toBeTruthy()
    expect(wikiFace.lint).toHaveBeenCalled()
  })

  it('lists findings, opening the page ones and disabling the vault-wide ones', async () => {
    const wikiFace = face({
      lint: vi.fn(async (): Promise<WikiLintValue> => ({
        report: {
          pages: 2,
          sources: 1,
          findings: [
            { kind: 'orphan-page', page: pagePath('concepts/alpha.md'), detail: 'no page links to this page' },
            { kind: 'broken-link', page: pagePath('concepts/alpha.md'), detail: '[[Ghost]] resolves to no page' },
            { kind: 'frontmatter', page: pagePath('concepts/beta.md'), detail: 'type "concept" expects the directory "wiki/concepts/"' },
            { kind: 'unintegrated-source', page: null, detail: 'raw source "notes/note.md" is cited by no page' },
          ],
        },
      })),
    })
    renderPage(wikiFace)
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.click(screen.getByRole('tab', { name: en.tabHealth }))

    const panel = await screen.findByRole('tabpanel')
    const orphan = await within(panel).findByRole('button', { name: /Orphan page/u })
    // A finding about the vault as a whole names no page, so it is not clickable.
    expect(asButton(within(panel).getByRole('button', { name: /Unintegrated source/u })).disabled).toBe(true)
    expect(asButton(within(panel).getByRole('button', { name: /Broken link/u })).disabled).toBe(false)
    expect(asButton(within(panel).getByRole('button', { name: /Frontmatter/u })).disabled).toBe(false)
    expect(asButton(orphan).disabled).toBe(false)

    fireEvent.click(orphan)
    expect(await screen.findByRole('article')).toBeTruthy()
    expect(wikiFace.read).toHaveBeenCalledWith('concepts/alpha.md')
  })

  it('reports a failed check and retries from the tab', async () => {
    const wikiFace = face({
      lint: vi.fn()
        .mockImplementationOnce(async (): Promise<WikiLintValue> => { throw new Error('the vault is locked') })
        .mockImplementationOnce(async (): Promise<WikiLintValue> => ({
          report: { pages: 2, sources: 0, findings: [] },
        })),
    })
    renderPage(wikiFace)
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.click(screen.getByRole('tab', { name: en.tabHealth }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('the vault is locked')

    fireEvent.click(screen.getByRole('button', { name: en.lint }))
    expect(await screen.findByText(en.lintClean)).toBeTruthy()
    expect(wikiFace.lint).toHaveBeenCalledTimes(2)
  })
})

describe('the editor', () => {
  it('carries every field the reader typed into the save request', async () => {
    const wikiFace = face()
    renderPage(wikiFace)
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.click(screen.getByRole('button', { name: en.newPage }))
    fireEvent.change(titleField(), { target: { value: 'Attention' } })
    fireEvent.change(screen.getByLabelText(en.fieldStatus), { target: { value: 'disputed' } })
    const updatedField = screen.getByLabelText(en.fieldUpdated)
    fireEvent.change(updatedField, { target: { value: '2026-01-01' } })
    if (!(updatedField instanceof HTMLInputElement)) throw new Error('the updated field is not an input')
    expect(updatedField.value).toBe('2026-01-01')
    fireEvent.change(screen.getByLabelText(en.fieldConfidence), { target: { value: '0.75' } })
    fireEvent.change(screen.getByLabelText(en.fieldTags), { target: { value: ' a ， b , c ' } })
    fireEvent.change(screen.getByLabelText(en.fieldSources), { target: { value: 'notes/n.md' } })
    fireEvent.change(screen.getByLabelText(en.fieldAliases), { target: { value: 'Att' } })
    fireEvent.change(screen.getByLabelText(en.fieldContradicts), { target: { value: 'concepts/beta.md' } })
    fireEvent.change(screen.getByLabelText(en.fieldBody), { target: { value: 'Body text.' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => {
      expect(wikiFace.save).toHaveBeenCalledWith({
        path: 'concepts/attention.md',
        frontmatter: {
          title: 'Attention',
          type: 'concept',
          tags: ['a', 'b', 'c'],
          updated: '2026-01-01',
          status: 'disputed',
          sources: ['notes/n.md'],
          aliases: ['Att'],
          confidence: 0.75,
          contradicts: ['concepts/beta.md'],
        },
        body: 'Body text.',
      })
    })
    expect(wikiFace.notify).toHaveBeenCalledWith(en.saved.replace('{path}', 'concepts/attention.md'), 'success')
  })

  it('reads a blank or non-numeric confidence as unstated', async () => {
    const wikiFace = face()
    renderPage(wikiFace)
    await openPage('Alpha')

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    fireEvent.change(screen.getByLabelText(en.fieldConfidence), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => {
      expect(wikiFace.save).toHaveBeenCalledWith(expect.objectContaining({
        frontmatter: expect.objectContaining({ confidence: null }),
      }))
    })
  })

  it('refuses a draft whose title derives no path, and one without a title', async () => {
    const wikiFace = face()
    renderPage(wikiFace)
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.click(screen.getByRole('button', { name: en.newPage }))
    fireEvent.change(titleField(), { target: { value: '???' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect((await screen.findByRole('alert')).textContent).toContain(en.invalidPath)

    fireEvent.change(titleField(), { target: { value: '' } })
    fireEvent.change(pathField(), { target: { value: 'concepts/custom.md' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect((await screen.findByRole('alert')).textContent).toContain(en.invalidTitle)
    expect(wikiFace.save).not.toHaveBeenCalled()
  })

  it('edits a stored page with its path locked, and cancels back to the reader', async () => {
    const wikiFace = face({
      read: vi.fn(async (path: string): Promise<WikiReadValue> => ({
        page: { path, frontmatter: { ...frontmatter('Alpha'), confidence: 0.5 }, body: 'Alpha body.', revision: 'rev-1' },
        links: [],
        backlinks: [],
        sources: [],
      })),
    })
    renderPage(wikiFace)
    await openPage('Alpha')

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    expect(screen.getByText(en.editorEdit)).toBeTruthy()
    expect(pathField().disabled).toBe(true)
    // A stated confidence is echoed into the field as its number.
    const confidenceField = screen.getByLabelText(en.fieldConfidence)
    if (!(confidenceField instanceof HTMLInputElement)) throw new Error('the confidence field is not an input')
    expect(confidenceField.value).toBe('0.5')

    fireEvent.change(titleField(), { target: { value: 'Alpha II' } })
    fireEvent.change(screen.getByLabelText(en.fieldType), { target: { value: 'entity' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => {
      expect(wikiFace.save).toHaveBeenCalledWith(expect.objectContaining({
        path: 'concepts/alpha.md',
        expectedRevision: 'rev-1',
        frontmatter: expect.objectContaining({ title: 'Alpha II', type: 'entity' }),
      }))
    })

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    fireEvent.click(screen.getByRole('button', { name: en.cancel }))
    expect(screen.queryByLabelText(en.fieldTitle)).toBeNull()
    expect(screen.getByRole('article')).toBeTruthy()
  })

  it('shows the saving state and reports a failed save through the notice host', async () => {
    let resolveSave: (value: WikiSaveValue) => void = () => {}
    const wikiFace = face({
      save: vi.fn((): Promise<WikiSaveValue> => new Promise(resolve => { resolveSave = resolve })),
    })
    renderPage(wikiFace)
    await openPage('Alpha')

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(screen.getByRole('button', { name: en.saving })).toBeTruthy()

    resolveSave({
      page: { path: 'concepts/alpha.md', frontmatter: frontmatter('Alpha'), body: 'Body.', revision: 'rev-2' },
    })
    await screen.findByRole('article')
    expect(wikiFace.notify).toHaveBeenCalledWith(en.saved.replace('{path}', 'concepts/alpha.md'), 'success')
  })

  it('reports a save failure that is not a revision conflict', async () => {
    const wikiFace = face({
      save: vi.fn(async (): Promise<WikiSaveValue> => { throw new Error('the disk is full') }),
    })
    renderPage(wikiFace)
    await openPage('Alpha')

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    await waitFor(() => {
      expect(wikiFace.notify).toHaveBeenCalledWith(
        en.saveFailed.replace('{reason}', 'the disk is full'), 'warning',
      )
    })
  })

  it('dismisses the conflict notice and keeps editing beside the stored page', async () => {
    const wikiFace = face({
      save: vi.fn(async (): Promise<WikiSaveValue> => {
        throw new WikiRequestError('prism-wiki/revision-conflict', 'changed elsewhere', {
          path: 'concepts/alpha.md', frontmatter: frontmatter('Alpha'), body: 'The stored body.', revision: 'rev-9',
        })
      }),
    })
    renderPage(wikiFace)
    await openPage('Alpha')

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    fireEvent.change(screen.getByLabelText(en.fieldBody), { target: { value: 'My kept draft.' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    const notice = await screen.findByRole('alert')
    fireEvent.click(within(notice).getByRole('button', { name: en.dismiss }))
    expect(screen.queryByRole('alert')).toBeNull()

    // The compare view keeps the draft editable beside the stored text.
    fireEvent.change(screen.getByLabelText(en.fieldBody), { target: { value: 'My revised kept draft.' } })
    const draft = screen.getByLabelText(en.fieldBody)
    if (!(draft instanceof HTMLTextAreaElement)) throw new Error('the editor draft is not a textarea')
    expect(draft.value).toBe('My revised kept draft.')
    expect(screen.getByText('The stored body.')).toBeTruthy()
  })

  it('shows the loading placeholder while a page read is in flight', async () => {
    let resolveRead: (value: WikiReadValue) => void = () => {}
    const wikiFace = face({
      read: vi.fn((_path: string): Promise<WikiReadValue> => new Promise(resolve => { resolveRead = resolve })),
    })
    renderPage(wikiFace)
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.click(screen.getByRole('button', { name: /Alpha/u }))
    expect(await screen.findByText(en.pageLoading)).toBeTruthy()

    resolveRead(readValue('concepts/alpha.md'))
    expect(await screen.findByRole('article')).toBeTruthy()
  })

  it('shows the placeholders of a page without backlinks or sources', async () => {
    const wikiFace = face({
      read: vi.fn(async (path: string): Promise<WikiReadValue> => ({
        page: { path, frontmatter: frontmatter('Alpha'), body: 'Plain body.', revision: 'rev-1' },
        links: [],
        backlinks: [],
        sources: [],
      })),
    })
    renderPage(wikiFace)

    const article = await openPage('Alpha')

    expect(within(article).getByText(en.noBacklinks)).toBeTruthy()
    expect(within(article).getByText(en.noSources)).toBeTruthy()
  })

  it('keeps wikilinks inside code literal and renders labelled and anchored links', async () => {
    const wikiFace = face({
      read: vi.fn(async (path: string): Promise<WikiReadValue> => ({
        page: {
          path,
          frontmatter: frontmatter('Alpha'),
          body: [
            'Fenced:',
            '',
            '```',
            '[[Gamma]]',
            '```',
            '',
            '~~~',
            '[[Delta]]',
            '~~~',
            '',
            'Inline `[[Epsilon]]` code.',
            '',
            'Label [[Beta|the [second] page]]. Anchor [[Beta#top]].',
            '',
          ].join('\n'),
          revision: 'rev-1',
        },
        links: [],
        backlinks: [],
        sources: [],
      })),
    })
    renderPage(wikiFace)

    const article = await openPage('Alpha')

    for (const literal of ['Gamma', 'Delta', 'Epsilon']) {
      expect(within(article).queryByRole('button', { name: literal })).toBeNull()
    }
    fireEvent.click(within(article).getByRole('button', { name: 'the [second] page' }))
    expect(wikiFace.read).toHaveBeenCalledWith('concepts/beta.md')
  })

  it('derives the vault-root path for a new overview page', async () => {
    renderPage(face())
    await screen.findByRole('button', { name: /Alpha/u })

    fireEvent.click(screen.getByRole('button', { name: en.newPage }))
    fireEvent.change(screen.getByLabelText(en.fieldType), { target: { value: 'overview' } })

    expect(pathField().value).toBe('overview.md')
  })

  it('keeps degenerate links literal and derives no path from a nameless target', async () => {
    const wikiFace = face({
      read: vi.fn(async (path: string): Promise<WikiReadValue> => ({
        page: {
          path,
          frontmatter: frontmatter('Alpha'),
          body: [
            'Empty [[|label]] and [[ ]].',
            '',
            'Empty label [[Beta|]].',
            '',
            'Full [[concepts/beta.md]].',
            '',
            'Wanted [[???]].',
            '',
            'Open ``two` one` end.',
            '',
          ].join('\n'),
          revision: 'rev-1',
        },
        links: [],
        backlinks: [],
        sources: [],
      })),
    })
    renderPage(wikiFace)

    const article = await openPage('Alpha')

    expect(within(article).queryByRole('button', { name: 'label' })).toBeNull()
    expect(within(article).getByRole('button', { name: 'Beta' })).toBeTruthy()
    expect(within(article).getByRole('button', { name: 'concepts/beta.md' })).toBeTruthy()
    expect(within(article).getByRole('button', { name: '???' })).toBeTruthy()

    fireEvent.click(within(article).getByRole('button', { name: '???' }))
    expect(pathField().value).toBe('')
    expect(titleField().value).toBe('???')
  })
})

describe('tree filters and groups', () => {
  it('narrows by pill, text, and clears both', async () => {
    const wikiFace = face({
      list: vi.fn(async (): Promise<WikiListValue> => ({
        pages: [
          summary('concepts/alpha.md'),
          { ...summary('concepts/beta.md'), type: 'entity', status: 'disputed' },
        ],
      })),
    })
    renderPage(wikiFace)
    await screen.findByRole('button', { name: /Alpha/u })

    // The type pill shares its name with the group toggle; the pill has no expanded state.
    const entityPill = screen.getAllByRole('button', { name: 'Entity' }).find(el => !el.hasAttribute('aria-expanded'))
    if (entityPill === undefined) throw new Error('the Entity pill did not render')
    fireEvent.click(entityPill)
    expect(screen.getByRole('button', { name: /Beta/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Alpha/u })).toBeNull()

    fireEvent.click(entityPill)
    expect(screen.getByRole('button', { name: /Alpha/u })).toBeTruthy()

    const disputedPill = screen.getByRole('button', { name: en.statusDisputed })
    fireEvent.click(disputedPill)
    expect(screen.queryByRole('button', { name: /Alpha/u })).toBeNull()
    fireEvent.click(disputedPill)
    expect(screen.getByRole('button', { name: /Alpha/u })).toBeTruthy()

    fireEvent.click(disputedPill)
    fireEvent.click(screen.getByRole('button', { name: en.clearFilters }))
    expect(screen.getByRole('button', { name: /Alpha/u })).toBeTruthy()

    fireEvent.change(screen.getByLabelText(en.filter), { target: { value: 'concepts/alpha' } })
    expect(screen.getByRole('button', { name: /Alpha/u })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Beta/u })).toBeNull()

    fireEvent.change(screen.getByLabelText(en.filter), { target: { value: 'zzz' } })
    expect(await screen.findByText(en.treeEmpty)).toBeTruthy()
  })

  it('collapses a type group down to its page count', async () => {
    renderPage(face())
    await screen.findByRole('button', { name: /Alpha/u })

    // The group toggle is the aria-expanded button named like the kind; the
    // filter pill shares the name but carries no expanded state.
    const toggle = screen.getAllByRole('button', { name: en.typeConcept }).find(el => el.hasAttribute('aria-expanded'))
    if (toggle === undefined) throw new Error('the Concept group toggle did not render')
    fireEvent.click(toggle)

    expect(await screen.findByText(en.pagesInGroup.replace('{count}', '2'))).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Alpha/u })).toBeNull()

    fireEvent.click(toggle)
    expect(await screen.findByRole('button', { name: /Alpha/u })).toBeTruthy()
  })
})

describe('the source panel', () => {
  it('shows the reading state, the truncation hint, and dismisses', async () => {
    let resolveSource: (value: WikiSourceValue) => void = () => {}
    const wikiFace = face({
      read: vi.fn(async (path: string): Promise<WikiReadValue> => ({
        page: { path, frontmatter: frontmatter('Alpha'), body: 'Alpha body.', revision: 'rev-1' },
        links: [],
        backlinks: [],
        sources: ['notes/paper.md'],
      })),
      source: vi.fn((_request: WikiSourceRequest): Promise<WikiSourceValue> => new Promise(resolve => { resolveSource = resolve })),
    })
    renderPage(wikiFace)
    await openPage('Alpha')

    fireEvent.click(screen.getByRole('button', { name: 'notes/paper.md' }))
    expect(await screen.findByText(en.sourceLoading)).toBeTruthy()

    resolveSource({ path: 'notes/paper.md', text: 'The long source text.', truncated: true })
    expect(await screen.findByText('The long source text.')).toBeTruthy()
    expect(screen.getByText(en.sourceTruncated)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.dismiss }))
    expect(screen.queryByText('The long source text.')).toBeNull()
  })

  it('reports a failed source read', async () => {
    const wikiFace = face({
      read: vi.fn(async (path: string): Promise<WikiReadValue> => ({
        page: { path, frontmatter: frontmatter('Alpha'), body: 'Alpha body.', revision: 'rev-1' },
        links: [],
        backlinks: [],
        sources: ['notes/paper.md'],
      })),
      source: vi.fn(async (_request: WikiSourceRequest): Promise<WikiSourceValue> => {
        throw new Error('the source is gone')
      }),
    })
    renderPage(wikiFace)
    await openPage('Alpha')

    fireEvent.click(screen.getByRole('button', { name: 'notes/paper.md' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('the source is gone')
  })
})

/** The editor's path field. */
function pathField(): HTMLInputElement {
  const field = screen.getByLabelText(en.fieldPath)
  if (!(field instanceof HTMLInputElement)) throw new Error('the editor path field is not an input')
  return field
}

/** Narrow one queried element to the button every interactive row renders as. */
function asButton(element: HTMLElement): HTMLButtonElement {
  if (!(element instanceof HTMLButtonElement)) throw new Error('the queried element is not a button')
  return element
}

/** The editor's title field. */
function titleField(): HTMLInputElement {
  const field = screen.getByLabelText(en.fieldTitle)
  if (!(field instanceof HTMLInputElement)) throw new Error('the editor title field is not an input')
  return field
}
