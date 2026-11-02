/** What the browser half registers: one data page, its face, and its teardown. */

import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { describe, expect, it, vi } from 'vitest'
import { apply, createBackupFace, inject, NS } from '../src/client/index.ts'

/** One Host view of the served backup namespace. */
function view(): Record<string, unknown> {
  return {
    ns: 'prism-backup',
    schema: {},
    value: { targetType: 'webdav', smbPath: '' },
    applies: 'live',
    secrets: [],
    revision: 0,
  }
}

/** Mount the settings shell, the locale runtime, the data section slot, and the backup page. */
async function bench(): Promise<{
  ctx: Context
  slots: SlotRegistry
  describe: ReturnType<typeof vi.fn>
}> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const describe = vi.fn(() => Promise.resolve({ ok: true, value: { writable: true, hasDocument: true, namespaces: [view()] } }))
  new TestRemote(ctx, {
    settings: { describe },
    credentials: { describe: () => Promise.resolve({ ok: true, value: {} }) },
  })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  // The 数据 section declares the page slot; here the root contributes both.
  slots.register({
    name: 'root',
    children: { 'settings.data.page': { kind: 'list', scope: 'root' } },
  } as never, () => null)
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, slots, describe }
}

describe('backup client half', () => {
  it('registers one data page with its face', async () => {
    const { ctx, slots } = await bench()
    const entries = [...slots.entries('settings.data.page')]
    const backup = entries.find(entry => entry.options.id === 'backup')
    expect(backup).toBeDefined()
    expect(backup?.options.label).toBeUndefined()
    const face = backup?.inject?.() as { hooks: Record<string, unknown> } | undefined
    expect(Object.keys(face?.hooks ?? {}).sort()).toEqual(['backupForm', 'backupRun'])
    await ctx.fiber.dispose()
  })

  it('builds the face the page injects', async () => {
    const { ctx } = await bench()
    const face = createBackupFace(ctx)
    expect(Object.keys(face.hooks).sort()).toEqual(['backupForm', 'backupRun'])
    expect(typeof face.test).toBe('function')
    expect(typeof face.run).toBe('function')
    expect(typeof face.clearSecret).toBe('function')
    await ctx.fiber.dispose()
  })

  it('registers its dictionaries under the page namespace', async () => {
    const { ctx } = await bench()
    const locale = ctx.get('locale') as LocaleRuntime
    expect(locale.bind(NS)('run')).toBe('立即备份')
    await ctx.fiber.dispose()
  })

  it('removes the page when the plugin unloads', async () => {
    const { ctx, slots } = await bench()
    await ctx.fiber.dispose()
    expect([...slots.entries('settings.data.page')].some(entry => entry.options.id === 'backup')).toBe(false)
  })
})
