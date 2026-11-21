/**
 * VAPID key storage and RFC 8292 JWT signing.
 *
 * The authorization header is verified on its public half: decode the JWT,
 * check the claims, and verify the ES256 signature with the stored public
 * key — the same verification a push service performs.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto as crypto } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { generateVapidKeys, loadOrCreateVapidKeys, vapidAuthorization } from '../../src/push/keys.ts'

const tempDirectories: string[] = []

function tempFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-keys-'))
  tempDirectories.push(directory)
  return join(directory, 'keys.json')
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('loadOrCreateVapidKeys', () => {
  it('generates, persists, and reloads the same keypair', async () => {
    const file = tempFile()
    const first = await loadOrCreateVapidKeys(file)
    expect(first.keys.publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(first.keys.privateKey).toMatch(/^[A-Za-z0-9_-]+$/)

    const stored = JSON.parse(readFileSync(file, 'utf8')) as { publicKey: string }
    expect(stored.publicKey).toBe(first.keys.publicKey)

    const second = await loadOrCreateVapidKeys(file)
    expect(second.keys.publicKey).toBe(first.keys.publicKey)
    expect(second.keys.privateKey).toBe(first.keys.privateKey)
  })

  it('recovers from a corrupt keys file by regenerating', async () => {
    const file = tempFile()
    await loadOrCreateVapidKeys(file)
    const original = JSON.parse(readFileSync(file, 'utf8')) as { publicKey: string }
    writeFileSync(file, '{broken', 'utf8')
    const reloaded = await loadOrCreateVapidKeys(file)
    expect(reloaded.keys.publicKey).not.toBe(original.publicKey)
  })

  it('generateVapidKeys produces a 65-byte raw public key', async () => {
    const keys = await generateVapidKeys()
    expect(Buffer.from(keys.publicKey, 'base64url').byteLength).toBe(65)
  })
})

describe('vapidAuthorization', () => {
  it('produces a verifiable ES256 JWT bound to the audience', async () => {
    const material = await loadOrCreateVapidKeys(tempFile())
    const endpoint = 'https://push.example.com/send/abc'
    const authorization = await vapidAuthorization(new URL(endpoint).origin, 'mailto:owner@example.com', material)

    const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization)
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new Error('vapid authorization header shape changed')
    }
    const token = match[1]
    const key = match[2]
    expect(key).toBe(material.keys.publicKey)

    const [headerPart, payloadPart, signaturePart] = token.split('.')
    if (headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
      throw new Error('vapid token is not three segments')
    }
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as { alg: string; typ: string }
    const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8')) as { aud: string; exp: number; sub: string }
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT' })
    expect(payload.aud).toBe('https://push.example.com')
    expect(payload.sub).toBe('mailto:owner@example.com')
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))

    const verifier = await crypto.subtle.importKey(
      'raw',
      Buffer.from(material.keys.publicKey, 'base64url'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifier,
      Buffer.from(signaturePart, 'base64url'),
      Buffer.from(`${headerPart}.${payloadPart}`, 'utf8'),
    )
    expect(valid).toBe(true)
  })
})
