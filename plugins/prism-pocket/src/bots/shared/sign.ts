/**
 * WeChat-family callback crypto (identical scheme for the Official Account
 * and WeCom): SHA-1 parameter signatures plus the AES-256-CBC message
 * envelope, implemented on node:crypto. Pure functions only.
 *
 * @module @prism/prism-pocket/bots/shared
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

/** How far a callback timestamp may drift before the delivery is refused. */
export const CALLBACK_TIMESTAMP_TOLERANCE_SECONDS = 300

/**
 * The callback signature: SHA-1 hex of the sorted concatenation.
 * @param parts - token, timestamp, nonce, and the encrypted blob when signing a reply.
 * @returns the lowercase hex digest.
 */
export function callbackSignature(...parts: readonly string[]): string {
  return createHash('sha1').update([...parts].sort().join('')).digest('hex')
}

/** Whether a callback timestamp is fresh enough to process. */
export function timestampFresh(timestamp: string, nowMs = Date.now()): boolean {
  const value = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(value)) return false
  return Math.abs(nowMs / 1000 - value) <= CALLBACK_TIMESTAMP_TOLERANCE_SECONDS
}

/** Derive the AES key and IV from an encodingAESKey. */
function keyOf(encodingAesKey: string): { key: Buffer; iv: Buffer } | undefined {
  let key: Buffer
  try {
    key = Buffer.from(`${encodingAesKey}=`, 'base64')
  } catch {
    return undefined
  }
  if (key.byteLength !== 32) return undefined
  return { key, iv: key.subarray(0, 16) }
}

/** Strip PKCS#7 padding over a 32-byte block. */
function unpad(plaintext: Buffer): Buffer | undefined {
  const pad: number | undefined = plaintext[plaintext.byteLength - 1]
  if (pad === undefined || pad < 1 || pad > 32 || pad > plaintext.byteLength) return undefined
  return plaintext.subarray(0, plaintext.byteLength - pad)
}

/** Pad to a 32-byte PKCS#7 block. */
function pad(plaintext: Buffer): Buffer {
  const pad = 32 - (plaintext.byteLength % 32)
  return Buffer.concat([plaintext, Buffer.alloc(pad, pad)])
}

/**
 * Decrypt one callback message envelope.
 * @param encodingAesKey - the console-issued key (43 base64url chars).
 * @param encryptB64 - the base64 cipher from the `Encrypt` field.
 * @param receiveId - the app id (Official Account) or corp id (WeCom) the envelope must carry.
 * @returns the plaintext message, or undefined when anything fails to verify.
 */
export function decryptWechatMessage(encodingAesKey: string, encryptB64: string, receiveId: string): string | undefined {
  const material = keyOf(encodingAesKey)
  if (material === undefined) return undefined
  let cipher: Buffer
  try {
    cipher = Buffer.from(encryptB64, 'base64')
  } catch {
    return undefined
  }
  if (cipher.byteLength === 0 || cipher.byteLength % 16 !== 0) return undefined
  let plaintext: Buffer
  try {
    const decipher = createDecipheriv('aes-256-cbc', material.key, material.iv)
    plaintext = Buffer.concat([decipher.update(cipher), decipher.final()])
  } catch {
    return undefined
  }
  const unpadded = unpad(plaintext)
  if (unpadded === undefined || unpadded.byteLength < 20) return undefined
  const messageLength = unpadded.readUInt32BE(16)
  if (messageLength <= 0 || 20 + messageLength > unpadded.byteLength) return undefined
  const message = unpadded.subarray(20, 20 + messageLength)
  const carried = unpadded.subarray(20 + messageLength).toString('utf8')
  if (carried !== receiveId) return undefined
  return message.toString('utf8')
}

/**
 * Encrypt one passive reply envelope.
 * @param encodingAesKey - the console-issued key.
 * @param message - the plaintext XML reply.
 * @param receiveId - the app id (Official Account) or corp id (WeCom) to embed.
 * @returns the base64 cipher, or undefined when the key is malformed.
 */
export function encryptWechatMessage(encodingAesKey: string, message: string, receiveId: string): string | undefined {
  const material = keyOf(encodingAesKey)
  if (material === undefined) return undefined
  const body = Buffer.from(message, 'utf8')
  const envelope = Buffer.concat([
    randomBytes(16),
    Buffer.alloc(4),
    body,
    Buffer.from(receiveId, 'utf8'),
  ])
  envelope.writeUInt32BE(body.byteLength, 16)
  const cipher = createCipheriv('aes-256-cbc', material.key, material.iv)
  return Buffer.concat([cipher.update(pad(envelope)), cipher.final()]).toString('base64')
}

/** Verify one encodingAESKey without deriving a message: exactly 43 base64url chars decoding to 32 bytes. */
export function encodingAesKeyValid(encodingAesKey: string): boolean {
  return keyOf(encodingAesKey) !== undefined
}
