// @vitest-environment jsdom
/** What the browser half registers: the 数据 section, its child slot, and its teardown. */

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, NS } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

/**
 * Mount the slots shell, the locale runtime, and a directory picker.
 * @param pickReply - what the picker answers.
 * @param withPicker - whether the deployment serves a picker at all.
 * @returns the context, its slots, the locale runtime, and the picker stub.
 */
async function bench(
  pickReply: { ok: true; value: string | null } | { ok: false; error: { message: string } } = { ok: true, value: '/picked' },
  withPicker = true,
): Promise<{ ctx: Context; slots: SlotRegistry; locale: LocaleRuntime; pick: ReturnType<typeof vi.fn> }> {
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
  const pick = vi.fn(async () => pickReply)
  ctx.provide('remote', {} as never)
  if (withPicker) ctx.provide('remote.directoryPicker', { pick } as never)
  return { ctx, slots, locale, pick }
}

describe('data client', () => {
  it('registers the 数据 section with its label, order, and child slot', async () => {
    const { ctx, slots } = await bench()
    try {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      const entries = slots.entries('settings.section')
      expect(entries).toHaveLength(1)
      expect(entries[0]?.options).toMatchObject({ id: 'data', order: 25 })
      expect(resolveSlotLabel(entries[0]?.options.label)).toBe('数据')
      expect(slots.spec('settings.data.page')).toEqual({ kind: 'list', scope: 'root' })
      await fiber.dispose()
      expect(slots.entries('settings.section')).toHaveLength(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('follows the active locale without re-registering', async () => {
    const { ctx, slots, locale } = await bench()
    try {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      const entry = slots.entries('settings.section')[0]
      locale.setLocale('en')
      expect(resolveSlotLabel(entry?.options.label)).toBe(en.nav)
      expect(zh.nav).toBe('数据')
      expect(NS).toBe('settings.data')
      await fiber.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('unwraps the picker Result for the section', async () => {
    const { ctx, slots, pick } = await bench()
    try {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      const face = (slots.entries('settings.section')[0]?.inject as () => { pickDirectory: (signal?: AbortSignal) => Promise<string | null> })()
      await expect(face.pickDirectory()).resolves.toBe('/picked')
      expect(pick).toHaveBeenCalledOnce()
      await fiber.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a picker refusal instead of a directory', async () => {
    const { ctx, slots } = await bench({ ok: false, error: { message: 'no picker' } })
    try {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      const face = (slots.entries('settings.section')[0]?.inject as () => { pickDirectory: () => Promise<string | null> })()
      await expect(face.pickDirectory()).rejects.toThrow('no picker')
      await fiber.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a deployment that serves no picker at all', async () => {
    const { ctx, slots } = await bench(undefined, false)
    try {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      // The section still registers: the storage tab keeps its typed-path field.
      expect(slots.entries('settings.section')).toHaveLength(1)
      const face = (slots.entries('settings.section')[0]?.inject as () => { pickDirectory: () => Promise<string | null> })()
      await expect(face.pickDirectory()).rejects.toThrow(/no directory picker/)
      await fiber.dispose()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
