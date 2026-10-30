/**
 * AWS Signature Version 4 (header form) for the S3 transport. Pure functions
 * over a method, URL, and header set, so the published AWS test vectors drive
 * them directly. S3 requests sign `UNSIGNED-PAYLOAD`, which lets the body
 * stream from the staged archive file instead of being hashed first.
 * @module @prism/prism-backup/sigv4
 */

import { createHash, createHmac } from 'node:crypto'

/** The archive body is not hashed; S3 never reads it to verify the signature. */
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

/** Long-lived key pair used to sign one request. */
export interface AwsCredentials {
  /** Public access key id. */
  readonly accessKeyId: string
  /** Secret access key, never logged. */
  readonly secretAccessKey: string
}

/** One request to sign. */
export interface SignInput {
  /** HTTP method. */
  readonly method: string
  /** Absolute request URL; its path and query are signed as given. */
  readonly url: URL
  /** Headers that will be sent; `host` is added from the URL when absent. */
  readonly headers: Readonly<Record<string, string>>
  /** Payload hash value, {@link UNSIGNED_PAYLOAD} for streamed bodies. */
  readonly payloadHash: string
  /** Signing region. */
  readonly region: string
  /** Signing service; always `s3` here. */
  readonly service: string
  /** Signing key pair. */
  readonly credentials: AwsCredentials
  /** Clock value to sign with. */
  readonly date: Date
}

/**
 * AWS `x-amz-date` spelling of an instant.
 * @param date - the instant.
 * @returns `YYYYMMDDTHHMMSSZ`.
 */
export function amzDate(date: Date): string {
  return `${date.toISOString().replace(/[-:]/gu, '').slice(0, 15)}Z`
}

/**
 * RFC 3986 encoding AWS signs with: unreserved characters stay, everything else
 * is percent-encoded in upper case.
 * @param value - decoded text.
 * @returns the encoded text.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

/**
 * Canonical URI: each path segment encoded, slashes kept.
 * @param pathname - decoded or already-encoded path from the URL.
 * @returns the canonical path.
 */
export function canonicalUri(pathname: string): string {
  return pathname.split('/').map(segment => encodeRfc3986(decodeURIComponent(segment))).join('/')
}

/**
 * Canonical query string: encoded pairs sorted by key, then value.
 * @param search - the URL's `search` value, without the leading `?`.
 * @returns the canonical query.
 */
export function canonicalQuery(search: string): string {
  if (search === '') return ''
  const pairs = [...new URLSearchParams(search)].map(([key, value]) =>
    [encodeRfc3986(key), encodeRfc3986(value)] as const)
  // AWS sorts canonical query pairs by code unit, not by locale collation.
  pairs.sort((left, right) => (left[0] === right[0]
    ? compareCodeUnits(left[1], right[1])
    : compareCodeUnits(left[0], right[0])))
  return pairs.map(([key, value]) => `${key}=${value}`).join('&')
}

/**
 * Compare two strings by UTF-16 code unit, the order AWS canonicalization uses.
 * @param left - first value.
 * @param right - second value.
 * @returns a negative, zero, or positive number.
 */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * SHA-256 of a text value as lower-case hex.
 * @param value - text to hash.
 * @returns the hex digest.
 */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * HMAC-SHA256 as raw bytes.
 * @param key - key material.
 * @param value - message.
 * @returns the digest.
 */
function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}

/**
 * Sign one request in header form.
 * @param input - method, URL, headers, payload hash, scope, and clock.
 * @returns every header to send, with `authorization` added and `host` supplied
 *   from the URL when the caller omitted it.
 */
export function signHeaders(input: SignInput): Record<string, string> {
  const supplied: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers)) supplied[name.toLowerCase()] = value
  // A caller-supplied timestamp decides the credential scope too; signing the
  // clock's day against a caller's date is a request AWS rejects.
  const stamp = supplied['x-amz-date'] ?? amzDate(input.date)
  const day = stamp.slice(0, 8)
  const scope = `${day}/${input.region}/${input.service}/aws4_request`
  const host = supplied.host ?? input.url.host
  const headers: Record<string, string> = {
    ...supplied,
    host,
    'x-amz-date': stamp,
  }
  const entries = Object.entries(headers).sort(([left], [right]) => compareCodeUnits(left, right))
  const canonicalHeaders = entries
    .map(([name, value]) => `${name}:${value.trim().replace(/\s+/gu, ' ')}\n`)
    .join('')
  const signedHeaders = entries.map(([name]) => name).join(';')
  const canonicalRequest = [
    input.method,
    canonicalUri(input.url.pathname),
    canonicalQuery(input.url.search.replace(/^\?/u, '')),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n')
  const dateKey = hmac(`AWS4${input.credentials.secretAccessKey}`, day)
  const regionKey = hmac(dateKey, input.region)
  const serviceKey = hmac(regionKey, input.service)
  const signingKey = hmac(serviceKey, 'aws4_request')
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, `
      + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}
