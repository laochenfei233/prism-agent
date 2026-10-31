/**
 * Push and Bark delivery: the request contract each channel must see.
 */
import { describe, expect, it } from 'vitest'
import { deliverBark, deliverWebPush, type FetchLike } from '../../src/push/sender.ts'
import { generateVapidKeys, type VapidMaterial } from '../../src/push/keys.ts'
import { webcrypto as crypto } from 'node:crypto'

async function material(): Promise<VapidMaterial> {
  const keys = await generateVapidKeys()
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    new Uint8Array(Buffer.from(keys.privateKey, 'base64url')),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  return { keys, signingKey }
}

/** A fetch fake that records the call and answers with a fixed status. */
function fakeFetch(status: number): { fetch: FetchLike; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return new Response(null, { status })
    },
  }
}

describe('deliverWebPush', () => {
  it('posts the encrypted body with the VAPID and aes128gcm headers', async () => {
    const { fetch, calls } = fakeFetch(201)
    const result = await deliverWebPush(
      'https://push.example.com/send/abc',
      Buffer.from('ciphertext'),
      'high',
      await material(),
      fetch,
    )
    expect(result).toMatchObject({ ok: true, status: 201, prune: false })
    expect(calls).toHaveLength(1)
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]+$/)
    expect(headers['Content-Encoding']).toBe('aes128gcm')
    expect(headers.TTL).toBe('86400')
    expect(headers.Urgency).toBe('high')
  })

  it('marks 404 and 410 endpoints for pruning and transport errors as failures', async () => {
    const gone = fakeFetch(410)
    expect((await deliverWebPush('https://p.example/gone', Buffer.alloc(0), 'normal', await material(), gone.fetch)).prune).toBe(true)
    const missing = fakeFetch(404)
    expect((await deliverWebPush('https://p.example/missing', Buffer.alloc(0), 'normal', await material(), missing.fetch)).prune).toBe(true)
    const failing: FetchLike = async () => {
      throw new Error('ECONNRESET')
    }
    const error = await deliverWebPush('https://p.example/x', Buffer.alloc(0), 'normal', await material(), failing)
    expect(error).toMatchObject({ ok: false, status: 0, prune: false })
    expect(error.detail).toContain('ECONNRESET')
  })
})

describe('deliverBark', () => {
  it('posts localized title text with the payload detail', async () => {
    const { fetch, calls } = fakeFetch(200)
    const result = await deliverBark(
      'https://api.day.app/device-key',
      { kind: 'approval', detail: 'bash', sessionTitle: 'fix the build' },
      fetch,
    )
    expect(result.ok).toBe(true)
    const body = JSON.parse(String(calls[0]?.init.body)) as { title: string; body: string; group: string }
    expect(body.title).toBe('Approval needed')
    expect(body.body).toBe('bash · fix the build')
    expect(body.group).toBe('prism-pocket')
  })

  it('falls back to the kind text without a detail', async () => {
    const { fetch, calls } = fakeFetch(200)
    await deliverBark('https://api.day.app/device-key', { kind: 'turn-end' }, fetch)
    const body = JSON.parse(String(calls[0]?.init.body)) as { body: string }
    expect(body.body).toBe('A Prism turn finished')
  })
})
