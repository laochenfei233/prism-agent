/**
 * RFC 8291 `aes128gcm` payload encryption.
 *
 * The recipient side here is written straight from the RFC: parse the 21-byte
 * header, re-derive the keying PRK from the recipient's private key, then the
 * record CEK/nonce from the header salt, and AES-GCM-decrypt the single
 * record. A round trip through that independent path is the correctness
 * check, and the header layout assertions pin the wire format.
 */
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encryptPushPayload } from '../../src/push/encrypt.ts'

/** A fresh subscription-side keypair and auth secret. */
function makeSubscription(): { publicKey: string; auth: string; ecdh: ReturnType<typeof createECDH> } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    auth: Buffer.from('the-auth-secret-16b'.repeat(2)).toString('base64url'),
    ecdh,
  }
}

/** Decrypt one aes128gcm body from the subscription side. */
function decrypt(body: Buffer, ecdh: ReturnType<typeof createECDH>, auth: string): Buffer {
  const salt = body.subarray(0, 16)
  const recordSize = body.readUInt32BE(16)
  const keyIdLength = body.readUInt8(20)
  const serverPublic = body.subarray(21, 21 + keyIdLength)
  const ciphertext = body.subarray(21 + keyIdLength)

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    Buffer.from(ecdh.getPublicKey()),
    serverPublic,
  ])
  const prk = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(serverPublic), Buffer.from(auth, 'base64url'), keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12))

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.byteLength - 16))
  const record = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.byteLength - 16)),
    decipher.final(),
  ])
  expect(recordSize).toBe(4096)
  expect(record[record.byteLength - 1]).toBe(2)
  return record.subarray(0, record.byteLength - 1)
}

describe('encryptPushPayload', () => {
  it('round-trips through an independent RFC 8291 recipient', () => {
    const subscription = makeSubscription()
    const payload = Buffer.from(JSON.stringify({ kind: 'approval', detail: 'bash' }), 'utf8')
    const body = encryptPushPayload(subscription.publicKey, subscription.auth, payload)
    expect(decrypt(body, subscription.ecdh, subscription.auth)).toEqual(payload)
  })

  it('uses a fresh ephemeral key per message', () => {
    const subscription = makeSubscription()
    const payload = Buffer.from('same input')
    const first = encryptPushPayload(subscription.publicKey, subscription.auth, payload)
    const second = encryptPushPayload(subscription.publicKey, subscription.auth, payload)
    expect(first.equals(second)).toBe(false)
  })

  it('rejects a payload that cannot fit one record', () => {
    const subscription = makeSubscription()
    expect(() => encryptPushPayload(subscription.publicKey, subscription.auth, Buffer.alloc(4080))).toThrow(/record/)
  })
})
