// @vitest-environment jsdom
/** What the browser half registers: one data page, its face, and its teardown. */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, NS } from '../src/client/index.ts'
import { TransferSection, type TransferFace, type TransferSectionProps } from '../src/client/TransferSection.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

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
async function bench(options: { pickResult?: unknown } = {}): Promise<{ ctx: Context; slots: SlotRegistry; locale: LocaleRuntime }> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: { 'settings.data.page': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  ctx.provide('workspaces', fakeWorkspaces() as never)
  const pick = async (): Promise<unknown> => options.pickResult ?? null
  ctx.provide('remote', { directoryPicker: { pick } } as never)
  ctx.provide('remote.directoryPicker', { pick } as never)
  return { ctx, slots, locale }
}

describe('transfer client', () => {
  it('registers one import/export page and removes it on disposal', async () => {
    const { ctx, slots } = await bench()
    try {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      const entries = slots.entries('settings.data.page')
      expect(entries).toHaveLength(1)
      expect(entries[0]?.options).toMatchObject({ id: 'transfer' })
      await fiber.dispose()
      expect(slots.entries('settings.data.page')).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('registers the shared dictionary namespace under the transfer NS', () => {
    expect(NS).toBe('settings.transfer')
    expect(Object.keys(zh)).toEqual(Object.keys(en))
  })

  it('unwraps the picker Result for the section and reports its failure', async () => {
    const { ctx, slots } = await bench({ pickResult: { ok: false, error: { message: 'nope' } } })
    try {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      const entry = slots.entries('settings.data.page')[0]
      // The inject thunk hands the section the face with the unwrapping picker.
      const face = (entry?.inject as unknown as () => TransferFace)()
      const t = (key: keyof typeof en, _params?: Record<string, unknown>): string => en[key]
      render(<TransferSection {...{
        close: vi.fn(),
        t,
        workspaces: fakeWorkspaces() as never,
        directoryPicker: face.directoryPicker,
      } as unknown as TransferSectionProps} />)
      fireEvent.click(screen.getByText('Change…'))
      await waitFor(() => {
        expect(screen.getByText('No system directory picker on this deployment; keeping the default.')).toBeDefined()
      })
      await fiber.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('carries the picked directory through the unwrapped Result', async () => {
    const { ctx, slots } = await bench({ pickResult: { ok: true, value: '/picked/root' } })
    try {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      const face = (slots.entries('settings.data.page')[0]?.inject as unknown as () => TransferFace)()
      const t = (key: keyof typeof en, _params?: Record<string, unknown>): string => en[key]
      render(<TransferSection {...{
        close: vi.fn(),
        t,
        workspaces: fakeWorkspaces() as never,
        directoryPicker: face.directoryPicker,
      } as unknown as TransferSectionProps} />)
      fireEvent.click(screen.getByText('Change…'))
      await waitFor(() => {
        expect(screen.getByText('/picked/root')).toBeDefined()
      })
      await fiber.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
