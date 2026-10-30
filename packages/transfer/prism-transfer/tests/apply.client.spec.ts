// @vitest-environment jsdom
/** What the browser half registers: one settings section, its label, and its teardown. */

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it } from 'vitest'
import { apply, inject, NS } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

/** Fake workspace list with one registered project. */
function fakeWorkspaces() {
  return {
    list: {
      getSnapshot: () => ({
        items: [{ workspaceId: 'w1', path: '/p', title: '项目', sessionIds: [], createdAt: '', updatedAt: '' }],
        archivedSessionIds: [],
        pinnedSessionIds: [],
        state: 'idle',
        error: null,
      }),
      subscribe: () => () => {},
    },
  }
}

/** Mount the slots shell, locale runtime, and the transfer page. */
async function bench(): Promise<{ ctx: Context; slots: SlotRegistry; locale: LocaleRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  ctx.provide('workspaces', fakeWorkspaces() as never)
  ctx.provide('remote', { directoryPicker: { pick: async () => null } } as never)
  ctx.provide('remote.directoryPicker', { pick: async () => null } as never)
  return { ctx, slots, locale }
}

describe('transfer client', () => {
  it('registers one transfer settings section and removes it on disposal', async () => {
    const { ctx, slots } = await bench()
    try {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      const entries = slots.entries('settings.section')
      expect(entries).toHaveLength(1)
      expect(entries[0]?.options).toMatchObject({ id: 'transfer', order: 30 })
      await fiber.dispose()
      expect(slots.entries('settings.section')).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('labels the nav row from the active locale dictionary', async () => {
    const { ctx, slots, locale } = await bench()
    try {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      const entry = slots.entries('settings.section')[0]
      expect(entry).toBeDefined()
      // The label is a thunk over the bound namespace, so it follows the
      // locale runtime without re-registration.
      expect(resolveSlotLabel(entry?.options.label)).toBe(zh.nav)
      locale.setLocale('en')
      expect(resolveSlotLabel(entry?.options.label)).toBe(en.nav)
      await fiber.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('registers the shared dictionary namespace under the transfer NS', () => {
    expect(NS).toBe('settings.transfer')
    expect(Object.keys(zh)).toEqual(Object.keys(en))
  })
})
