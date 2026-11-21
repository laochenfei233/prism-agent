// @vitest-environment jsdom
/** Response validation in the storage tab's browser calls. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestRelocate, requestReset, requestState } from '../src/client/storage-client.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { vi.unstubAllGlobals() })

const t = (key: keyof typeof en, params?: Record<string, unknown>): string =>
  en[key].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params?.[name]
    return typeof value === 'string' ? value : ''
  })

/**
 * Answer every call with one fixed body.
 * @param body - raw response text.
 * @param status - HTTP status.
 * @returns nothing; the stub is installed as the global fetch.
 */
function answer(body: string, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))
}

describe('storage client', () => {
  it('accepts a complete location snapshot', async () => {
    answer(JSON.stringify({ ok: true, value: { root: '/r', pointerPath: '/p', storedRoot: '/s', pendingRoot: '/s' } }))
    await expect(requestState(t)).resolves.toEqual({ root: '/r', pointerPath: '/p', storedRoot: '/s', pendingRoot: '/s' })
  })

  it('rejects a snapshot missing a required field', async () => {
    answer(JSON.stringify({ ok: true, value: { root: '/r' } }))
    await expect(requestState(t)).rejects.toMatchObject({ code: 'unexpected-response' })
  })

  it('rejects a success body that carries no value', async () => {
    answer(JSON.stringify({ ok: true }))
    await expect(requestReset(t)).rejects.toMatchObject({ code: 'unexpected-response' })
  })

  it('rejects a relocation result with a non-numeric count and keeps its links', async () => {
    answer(JSON.stringify({ ok: true, value: { target: '/t', previousRoot: '/r', files: '2', bytes: 4, skippedLinks: ['/a', 7] } }))
    await expect(requestRelocate('/t', t)).rejects.toMatchObject({ code: 'unexpected-response' })

    answer(JSON.stringify({ ok: true, value: { target: '/t', previousRoot: '/r', files: 2, bytes: 4, skippedLinks: ['/a', 7] } }))
    await expect(requestRelocate('/t', t)).resolves.toMatchObject({ skippedLinks: ['/a'] })
  })

  it('reports a refusal without an envelope as the transport sentence', async () => {
    answer('{}', 500)
    await expect(requestState(t)).rejects.toMatchObject({
      code: 'request-failed',
      message: en.requestFailed.replace('{status}', '500'),
    })
  })

  it('rejects a relocation result whose target is not a string', async () => {
    answer(JSON.stringify({ ok: true, value: { target: 7, previousRoot: '/r', files: 1, bytes: 1 } }))
    await expect(requestRelocate('/t', t)).rejects.toMatchObject({ code: 'unexpected-response' })
  })

  it('treats an absent link list as no links', async () => {
    answer(JSON.stringify({ ok: true, value: { target: '/t', previousRoot: '/r', files: 0, bytes: 0 } }))
    await expect(requestRelocate('/t', t)).resolves.toMatchObject({ skippedLinks: [] })
  })

  it('answers an unparsable body as an unrecognized response', async () => {
    answer('<html>not json</html>')
    await expect(requestState(t)).rejects.toMatchObject({ code: 'unexpected-response' })
  })
})
