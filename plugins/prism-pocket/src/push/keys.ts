/**
 * VAPID key management and JWT signing (RFC 8292).
 *
 * One ECDSA P-256 keypair lives beside the subscription store under the DSH
 * home. The public key is exported raw (the 65-byte uncompressed point) so it
 * doubles as the browser's `applicationServerKey` and as the VAPID `k=` field;
 * the private key stays in PKCS#8 and signs each push request's ES256 JWT.
 *
 * @module @prism/prism-pocket/push
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { webcrypto as crypto } from 'node:crypto'

/** Persisted VAPID material; both halves are base64url. */
export interface VapidKeys {
  /** Raw uncompressed P-256 public key (65 bytes), base64url. */
  publicKey: string
  /** PKCS#8 private key, base64url. */
  privateKey: string
}

/** A loaded keypair with its signing key materialized once per process. */
export interface VapidMaterial {
  keys: VapidKeys
  /** The ECDSA private key imported for signing. */
  signingKey: CryptoKey
}

/** The JWT lifetime pushed endpoints accept; one day matches the TTL header. */
const JWT_TTL_SECONDS = 86400

/** Encode bytes or text as base64url without padding. */
function b64url(input: Uint8Array | ArrayBuffer | string): string {
  if (typeof input === 'string') return Buffer.from(input, 'utf8').toString('base64url')
  return Buffer.from(input instanceof Uint8Array ? input : new Uint8Array(input)).toString('base64url')
}

/** Copy bytes into a fresh ArrayBuffer-backed view for WebCrypto's BufferSource. */
function bufferSource(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(input.byteLength))
  copy.set(input)
  return copy
}

/** Generate one fresh VAPID keypair. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
  const publicKey = await crypto.subtle.exportKey('raw', pair.publicKey)
  const privateKey = await crypto.subtle.exportKey('pkcs8', pair.privateKey)
  return { publicKey: b64url(publicKey), privateKey: b64url(privateKey) }
}

/**
 * Load the stored keypair, generating and persisting one on first use.
 * @param file - absolute path of the keys JSON file; created mode 0600.
 */
export async function loadOrCreateVapidKeys(file: string): Promise<VapidMaterial> {
  let keys: VapidKeys
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (isVapidKeys(parsed)) {
      keys = parsed
    } else {
      keys = await persist(await generateVapidKeys(), file)
    }
  } catch {
    keys = await persist(await generateVapidKeys(), file)
  }
  const raw = Buffer.from(keys.privateKey, 'base64url')
  const signingKey = await crypto.subtle.importKey(
    'pkcs8',
    bufferSource(raw),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  return { keys, signingKey }
}

/** Validate a parsed keys record without trusting the file. */
function isVapidKeys(value: unknown): value is VapidKeys {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { publicKey?: unknown; privateKey?: unknown }
  return typeof candidate.publicKey === 'string' && candidate.publicKey.length > 0
    && typeof candidate.privateKey === 'string' && candidate.privateKey.length > 0
}

/** Write the keypair atomically with owner-only permissions. */
async function persist(keys: VapidKeys, file: string): Promise<VapidKeys> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, JSON.stringify(keys, undefined, 2), { mode: 0o600 })
  await rename(temp, file)
  return keys
}

/**
 * Build the VAPID `Authorization` header for one push request (RFC 8292).
 * @param aud - the audience: the push endpoint's origin.
 * @param sub - an admin contact URI, for example `mailto:owner@example.com`.
 * @param material - the loaded keypair and its signing key.
 */
export async function vapidAuthorization(
  aud: string,
  sub: string,
  material: VapidMaterial,
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS,
    sub,
  }))
  const data = bufferSource(Buffer.from(`${header}.${payload}`, 'utf8'))
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, material.signingKey, data)
  return `vapid t=${header}.${payload}.${b64url(new Uint8Array(signature))}, k=${material.keys.publicKey}`
}
