/**
 * The plugin's browser registrations and their removal.
 *
 * The tab registry is real, because "registered" is what the type system reads;
 * the slot and locale faces are recorders, because what matters is what they
 * were handed and that disposal takes everything back.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { GIT_ID, GIT_KIND } from '../src/client/definition.tsx'
import { GitBody } from '../src/client/GitBody.tsx'
import { GitTitle } from '../src/client/GitTitle.tsx'
import type { GitFace } from '../src/client/face.ts'
import { apply, inject } from '../src/client/index.ts'
import { createGitStore } from '../src/client/store.ts'
import { en, zh } from '../src/client/locales.ts'

interface Recorded {
  name: string
  key: string
  locale: string
  store: unknown
  inject: unknown
  component: unknown
}

async function boot() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    // Copy is the dictionary's contract; the key stands in for the translation.
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((ns: string, dicts: unknown) => {
      dictionaries.set(ns, dicts)
      return () => { dictionaries.delete(ns) }
    }),
  }
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { tabs, registered, dictionaries, fiber }
}

describe('ui-sidebar-git apply', () => {
  it('registers the type, its dictionaries, and both seats under the type id', async () => {
    const { tabs, registered, dictionaries } = await boot()
    const definition = tabs.get(GIT_KIND)
    expect(definition?.id).toBe(GIT_ID)
    expect(definition?.priority).toBe('builtin')
    expect(definition?.title('git')).toBe('type.label')
    expect(definition?.guide?.map(entry => [entry.order, entry.title(), entry.description?.()]))
      .toEqual([[15, 'guide.title', 'guide.description']])
    expect(dictionaries.get('sidebarGit')).toEqual({ zh, en })
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', GIT_ID, 'sidebarGit', GitBody],
      ['sidebar.right.pane.tab.title', GIT_ID, undefined, GitTitle],
    ])
    expect(registered[0]?.store).toBeDefined()
    expect(typeof registered[0]?.inject).toBe('function')
  })

  it('takes every registration back when the plugin is disposed', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(GIT_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
  it('binds the injected face to the browser fetch and the tab Session', async () => {
    const { registered } = await boot()
    const factory = registered[0]?.inject as (sessionId: string, actions: unknown) => GitFace
    const instance = createGitStore().create()
    instance.actions.start('tab-1' as TabId)
    const actions = instance.actions
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ available: true, repo: false, entries: [] }))
    try {
      const face = factory('s-1', actions)
      face.load('tab-1' as TabId, new AbortController().signal)
      await vi.waitFor(() => { expect(fetchSpy).toHaveBeenCalledTimes(1) })
      expect(fetchSpy.mock.calls[0]?.[0]).toContain('git.status?sessionId=s-1')
    } finally {
      fetchSpy.mockRestore()
    }
  })
})