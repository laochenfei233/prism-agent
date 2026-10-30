import { describe, expect, it, vi } from 'vitest'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { applySettingsFile, exportSettingsFile, parseSettingsText, type SettingsTransferDeps } from '../src/settings-transfer.ts'
import type { SettingsDescriptor } from '@deepseek-ai/dsh-settings'

/** One descriptor-shaped row for the fake describe surface. */
function descriptor(ns: string, value: unknown, revision = 0, secrets?: SettingsDescriptor['secrets']): SettingsDescriptor {
  return {
    ns,
    autoGenerate: true,
    schema: {
      type: 'object',
      dict: {
        endpoint: { type: 'string' },
        secret: { type: 'string', meta: { role: 'secret' } },
      },
    },
    value,
    revision,
    applies: 'live',
    ...(secrets === undefined ? {} : { secrets }),
  } as SettingsDescriptor
}

/** Fake settings surface recording update calls. */
function fakeDeps(
  rows: SettingsDescriptor[],
  update: SettingsTransferDeps['update'] = async () => {},
): SettingsTransferDeps & { readonly updates: { ns: string; patch: object; revision: number | undefined }[] } {
  const updates: { ns: string; patch: object; revision: number | undefined }[] = []
  return {
    describe: (options?: { redactSecrets?: boolean }) => rows.map((row) => {
      if (options?.redactSecrets !== true) return row
      const source = row.value as Record<string, unknown>
      return { ...row, value: { endpoint: source['endpoint'], secrets: undefined } }
    }),
    update: async (ns, patch, expectedRevision) => {
      updates.push({ ns, patch, revision: expectedRevision })
      await update(ns, patch, expectedRevision)
    },
    updates,
  }
}

describe('exportSettingsFile', () => {
  it('strips secret values and counts only the set ones', () => {
    const deps = fakeDeps([
      descriptor('web', { endpoint: '/x', secret: 'hush' }, 3, [
        { path: ['secret'], set: true },
      ]),
      descriptor('idle', { endpoint: '/y', secret: undefined }, 1, [
        { path: ['secret'], set: false },
      ]),
    ])
    const exported = exportSettingsFile(deps, false)
    expect(exported.file.includeSecrets).toBe(false)
    expect(exported.file.namespaces['web']).toEqual({ endpoint: '/x', secrets: undefined })
    expect(exported.skippedSecrets).toBe(1)
  })

  it('keeps real values when secrets are included and reports none skipped', () => {
    const deps = fakeDeps([descriptor('web', { endpoint: '/x', secret: 'hush' })])
    const exported = exportSettingsFile(deps, true)
    expect(exported.file.includeSecrets).toBe(true)
    expect(exported.file.namespaces['web']).toEqual({ endpoint: '/x', secret: 'hush' })
    expect(exported.skippedSecrets).toBe(0)
  })
})

describe('applySettingsFile', () => {
  it('applies only fields the live schema declares, with the read revision', async () => {
    const deps = fakeDeps([descriptor('web', { endpoint: '/current', secret: 'keep' }, 7)])
    const outcomes = await applySettingsFile(deps, {
      format: 'prism-settings',
      version: 1,
      exportedAt: 't',
      includeSecrets: false,
      namespaces: {
        web: { endpoint: '/new', secret: 'moved', undeclared: 1 },
      },
    })
    expect(outcomes).toEqual([{ ns: 'web', outcome: 'applied' }])
    expect(deps.updates).toEqual([{
      ns: 'web',
      // The secret keeps its stored value and the undeclared field is dropped.
      patch: { endpoint: '/new', secret: 'moved' },
      revision: 7,
    }])
  })

  it('skips inactive namespaces and namespaces with no applicable fields', async () => {
    const deps = fakeDeps([descriptor('web', { endpoint: '/x' })])
    const outcomes = await applySettingsFile(deps, {
      format: 'prism-settings',
      version: 1,
      exportedAt: 't',
      includeSecrets: false,
      namespaces: {
        gone: { endpoint: '/y' },
        web: { undeclared: 1 },
      },
    })
    expect(outcomes).toEqual([
      { ns: 'gone', outcome: 'skipped', reason: expect.stringContaining('not active') },
      { ns: 'web', outcome: 'skipped', reason: expect.stringContaining('no field') },
    ])
    expect(deps.updates).toEqual([])
  })

  it('reports write failures without touching the remaining namespaces', async () => {
    const deps = fakeDeps(
      [descriptor('a', { endpoint: '/a' }), descriptor('b', { endpoint: '/b' })],
      async (ns) => {
        if (ns === 'a') throw new Error('disk full')
      },
    )
    const outcomes = await applySettingsFile(deps, {
      format: 'prism-settings',
      version: 1,
      exportedAt: 't',
      includeSecrets: false,
      namespaces: { a: { endpoint: '/x' }, b: { endpoint: '/y' } },
    })
    expect(outcomes).toEqual([
      { ns: 'a', outcome: 'failed', reason: 'disk full' },
      { ns: 'b', outcome: 'applied' },
    ])
  })

  it('retries once against the fresh revision after a conflict', async () => {
    const rows = [descriptor('web', { endpoint: '/x' }, 7)]
    const deps = fakeDeps(rows, vi.fn())
    let calls = 0
    const originalDescribe = deps.describe
    deps.describe = (options) => {
      if (calls >= 1) rows[0] = descriptor('web', { endpoint: '/x' }, 8)
      return originalDescribe(options)
    }
    const originalUpdate = deps.update
    deps.update = async (ns, patch, expectedRevision) => {
      calls += 1
      if (calls === 1) {
        throw new SettingsConflictError('web' as never, 7, 8)
      }
      await originalUpdate(ns, patch, expectedRevision)
    }
    const outcomes = await applySettingsFile(deps, {
      format: 'prism-settings',
      version: 1,
      exportedAt: 't',
      includeSecrets: false,
      namespaces: { web: { endpoint: '/new' } },
    })
    expect(outcomes).toEqual([{ ns: 'web', outcome: 'applied' }])
    // The first attempt threw before recording; the retry carried the fresh revision.
    expect(deps.updates).toEqual([{ ns: 'web', patch: { endpoint: '/new' }, revision: 8 }])
  })

  it('fails after a second conflict instead of fighting the editor', async () => {
    const deps = fakeDeps([descriptor('web', { endpoint: '/x' }, 7)])
    let calls = 0
    const originalUpdate = deps.update
    deps.update = async (ns, patch, expectedRevision) => {
      calls += 1
      if (calls <= 2) throw new SettingsConflictError('web' as never, expectedRevision ?? 0, 99)
      await originalUpdate(ns, patch, expectedRevision)
    }
    const outcomes = await applySettingsFile(deps, {
      format: 'prism-settings',
      version: 1,
      exportedAt: 't',
      includeSecrets: false,
      namespaces: { web: { endpoint: '/new' } },
    })
    expect(outcomes).toEqual([{ ns: 'web', outcome: 'failed', reason: 'settings changed again during import' }])
  })
})

describe('parseSettingsText', () => {
  it('rejects invalid JSON and wrong formats', () => {
    expect(() => parseSettingsText('not json')).toThrow(/not valid JSON/)
    expect(() => parseSettingsText('{"format":"other","version":1}')).toThrow(/unsupported settings format/)
    expect(() => parseSettingsText('{"format":"prism-settings","version":2}')).toThrow(/unsupported settings version/)
  })
})
