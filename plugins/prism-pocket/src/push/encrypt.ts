/**
 * Web Push payload encryption (RFC 8291, `aes128gcm` content coding).
 *
 * One ephemeral P-256 key per message: ECDH with the subscription's public
 * key derives the keying PRK, the random salt derives the record CEK and
 * nonce, and the output is the aes128gcm header block followed by the single
 * ciphertext record. Implemented on `node:crypto` because the npm registry is
 * unreachable in this deployment; correctness is pinned by round-trip tests
 * and by the RFC's header layout.
 *
 * @module @prism/prism-pocket/push
 */

import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'

/** Record size declared in the header; payloads must fit one record. */
const RECORD_SIZE = 4096

/** AES-GCM authentication tag length in bytes. */
const TAG_BYTES = 16

/** One byte per record: the last-record delimiter with zero padding. */
const LAST_RECORD_OVERHEAD = TAG_BYTES + 1

/** Decode a base64url subscription field. */
function fromB64url(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

/** HKDF with Node's `(digest, ikm, salt, info, length)` argument order. */
function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length))
}

/**
 * Encrypt one push payload for one subscription.
 * @param p256dh - the subscription's client public key, base64url.
 * @param auth - the subscription's auth secret, base64url.
 * @param payload - plaintext bytes; at most 4079 (one aes128gcm record).
 * @returns the request body: 21-byte key header, 65-byte public key, ciphertext.
 * @throws {Error} when the payload does not fit one record.
 */
export function encryptPushPayload(p256dh: string, auth: string, payload: Uint8Array): Buffer {
  if (payload.byteLength + 1 > RECORD_SIZE - LAST_RECORD_OVERHEAD) {
    throw new Error('web-push: payload exceeds one aes128gcm record')
  }
  const clientPublic = fromB64url(p256dh)
  const authSecret = fromB64url(auth)
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const sharedSecret = ecdh.computeSecret(clientPublic)
  const serverPublic = ecdh.getPublicKey()

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    clientPublic,
    serverPublic,
  ])
  const keyingPrk = hkdf(sharedSecret, authSecret, keyInfo, 32)

  const salt = randomBytes(16)
  const cek = hkdf(keyingPrk, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
  const nonce = hkdf(keyingPrk, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)

  const record = Buffer.concat([Buffer.from(payload), Buffer.from([2])])
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(4 + 1 + serverPublic.byteLength + salt.byteLength)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(serverPublic.byteLength, 20)
  serverPublic.copy(header, 21)
  return Buffer.concat([header, ciphertext])
}
