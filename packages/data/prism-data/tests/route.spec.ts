/** The data settings route: state, relocate, reset, and their refusals. */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { dataHomePointerPath, readDataHomePointer } from '@deepseek-ai/dsh-home-paths'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, createDataRoute, relocate, stateOf } from '../src/index.ts'
import type { DataLocationState, RelocationResult } from '../src/types.ts'

const roots: string[] = []

/**
 * A throwaway operating-system home with one harness home inside it.
 * @param prefix - name prefix that names the test.
 * @returns the OS home, the harness home, and a sibling destination.
 */
async function scratch(prefix: string): Promise<{ osHome: string; root: string }> {
  const osHome = await mkdtemp(join(tmpdir(), `prism-data-${prefix}-`))
  roots.push(osHome)
  const root = join(osHome, '.prism')
  await mkdir(join(root, 'sessions'), { recursive: true })
  await writeFile(join(root, 'sessions', 'one.jsonl'), '{"seq":1}\n')
  await writeFile(join(root, '.credentials.yaml'), 'key: value\n')
  return { osHome, root }
}

/**
 * One JSON request for the route.
 * @param body - body value, serialized as JSON.
 * @returns the request the handler receives.
 */
function call(body: unknown): Request {
  return new Request('http://host/api/prism.data', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Parse one response body.
 * @param response - the handler's answer.
 * @returns the parsed envelope.
 */
async function bodyOf(response: Response): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
  return await response.json() as { ok: boolean; value?: unknown; error?: { code: string; message: string } }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('state', () => {
  it('names the running home and the pointer path before any relocation', async () => {
    const { osHome, root } = await scratch('state')
    const state = stateOf({ root, osHome })
    expect(state).toEqual({ root, pointerPath: dataHomePointerPath(osHome) })
  })

  it('reports a recorded home as pending when it differs from the running one', async () => {
    const { osHome, root } = await scratch('state-pending')
    await writeFile(dataHomePointerPath(osHome), `${join(osHome, 'moved')}\n`)
    expect(stateOf({ root, osHome })).toMatchObject({ root, storedRoot: join(osHome, 'moved'), pendingRoot: join(osHome, 'moved') })
  })

  it('reports no pending root once the pointer names the running home', async () => {
    const { osHome, root } = await scratch('state-settled')
    await writeFile(dataHomePointerPath(osHome), `${root}\n`)
    const state = stateOf({ root, osHome })
    expect(state.storedRoot).toBe(root)
    expect(state.pendingRoot).toBeUndefined()
  })
})

describe('relocate', () => {
  it('copies the home, records the destination, and leaves the source in place', async () => {
    const { osHome, root } = await scratch('relocate')
    const target = join(osHome, 'moved')
    const result = await relocate({ root, osHome }, target)
    expect(result).toMatchObject({ target, previousRoot: root, files: 2, skippedLinks: [] })
    expect(result.bytes).toBeGreaterThan(0)
    await expect(readFile(join(target, '.credentials.yaml'), 'utf8')).resolves.toBe('key: value\n')
    await expect(readFile(join(root, '.credentials.yaml'), 'utf8')).resolves.toBe('key: value\n')
    expect(readDataHomePointer(osHome)).toBe(target)
  })

  it('refuses a destination that holds data and leaves the pointer alone', async () => {
    const { osHome, root } = await scratch('relocate-full')
    const target = join(osHome, 'occupied')
    await mkdir(target)
    await writeFile(join(target, 'file.txt'), 'x')
    await expect(relocate({ root, osHome }, target)).rejects.toMatchObject({ code: 'prism-data/target-not-empty' })
    expect(readDataHomePointer(osHome)).toBeUndefined()
  })

  it('reports a pointer it cannot write and keeps the copied tree', async () => {
    const { osHome, root } = await scratch('relocate-pointer')
    const target = join(osHome, 'moved')
    // A directory where the pointer file belongs makes the write fail.
    await mkdir(dataHomePointerPath(osHome))
    await expect(relocate({ root, osHome }, target)).rejects.toMatchObject({ code: 'prism-data/pointer-failed' })
    await expect(readFile(join(target, '.credentials.yaml'), 'utf8')).resolves.toBe('key: value\n')
  })

  it('removes a partial destination and reports the copy fault', async () => {
    const { osHome, root } = await scratch('relocate-copy-fault')
    const target = join(osHome, 'moved')
    const thrown = await relocate({ root, osHome }, target, async () => {
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'half.txt'), 'x')
      throw new Error('no space left on device')
    }).catch((error: unknown) => error)
    expect(thrown).toMatchObject({ code: 'prism-data/copy-failed' })
    expect((thrown as Error).message).toContain(target)
    expect((thrown as Error).message).toContain('no space left on device')
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(readDataHomePointer(osHome)).toBeUndefined()
  })
})

describe('route', () => {
  it('answers state, relocate, and reset in the success envelope', async () => {
    const { osHome, root } = await scratch('route')
    const handle = createDataRoute({ root, osHome })

    const initial = await handle(call({ action: 'state' }))
    expect(initial.status).toBe(200)
    expect(await bodyOf(initial)).toMatchObject({ ok: true, value: { root } })

    const moved = await handle(call({ action: 'relocate', target: join(osHome, 'moved') }))
    expect(moved.status).toBe(200)
    const movedBody = await bodyOf(moved)
    expect(movedBody.ok).toBe(true)
    expect((movedBody.value as RelocationResult).target).toBe(join(osHome, 'moved'))

    const pending = await handle(call({ action: 'state' }))
    expect(((await bodyOf(pending)).value as DataLocationState).pendingRoot).toBe(join(osHome, 'moved'))

    const reset = await handle(call({ action: 'reset' }))
    expect(reset.status).toBe(200)
    expect(((await bodyOf(reset)).value as DataLocationState).storedRoot).toBeUndefined()
    expect(readDataHomePointer(osHome)).toBeUndefined()
  })

  it('answers the typed refusal with its status', async () => {
    const { osHome, root } = await scratch('route-refuse')
    const handle = createDataRoute({ root, osHome })
    const response = await handle(call({ action: 'relocate', target: 'relative/dir' }))
    expect(response.status).toBe(400)
    expect(await bodyOf(response)).toMatchObject({ ok: false, error: { code: 'prism-data/target-invalid' } })
  })

  it('refuses a second relocation while one runs', async () => {
    const { osHome, root } = await scratch('route-busy')
    const handle = createDataRoute({ root, osHome })
    const first = handle(call({ action: 'relocate', target: join(osHome, 'first') }))
    const second = handle(call({ action: 'relocate', target: join(osHome, 'second') }))
    const [settledFirst, settledSecond] = await Promise.all([first, second])
    expect(settledFirst.status).toBe(200)
    expect(settledSecond.status).toBe(409)
    expect(await bodyOf(settledSecond)).toMatchObject({ ok: false, error: { code: 'prism-data/busy' } })
  })

  it.each([
    ['a body that is not JSON', 'not json'],
    ['a body that is not an object', '[]'],
    ['a null body', 'null'],
    ['an unknown action', { action: 'explode' }],
    ['a relocate without a target', { action: 'relocate' }],
    ['a relocate with a blank target', { action: 'relocate', target: '   ' }],
  ])('rejects %s', async (_label, payload) => {
    const { osHome, root } = await scratch('route-bad')
    const handle = createDataRoute({ root, osHome })
    const request = new Request('http://host/api/prism.data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    })
    const response = await handle(request)
    expect(response.status).toBe(400)
    expect(await bodyOf(response)).toMatchObject({ ok: false, error: { code: 'prism-data/bad-request' } })
  })
})

describe('apply', () => {
  it('registers the route on the connection carrier and drops it on disposal', async () => {
    const release = vi.fn(async () => {})
    const register = vi.fn((_route: unknown) => release)
    const ctx = new Context()
    try {
      ctx.provide('connection', { fetch: { register } } as never)
      const fiber = ctx.plugin({ inject: ['connection'], apply })
      await fiber.await()
      expect(register).toHaveBeenCalledOnce()
      expect(register.mock.calls[0]?.[0]).toMatchObject({ path: '/api/prism.data', methods: ['POST'] })
      await fiber.dispose()
      expect(release).toHaveBeenCalledOnce()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
