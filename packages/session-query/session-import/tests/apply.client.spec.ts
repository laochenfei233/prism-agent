// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'

it('registers one import settings section and removes it on disposal', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: { 'settings.section': { kind: 'list', scope: 'root' } },
    } as never, () => null)
    const fiber = ctx.plugin({ inject, apply })
    await fiber.await()
    const entries = slots.entries('settings.section')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.options).toMatchObject({ id: 'import', order: 25 })
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
  } finally {
    await ctx.fiber.dispose()
  }
})
