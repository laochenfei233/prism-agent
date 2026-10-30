/** Signature Version 4 must reproduce AWS's published example request byte for byte. */

import { describe, expect, it } from 'vitest'
import { amzDate, canonicalQuery, canonicalUri, encodeRfc3986, signHeaders, UNSIGNED_PAYLOAD } from '../src/sigv4.ts'

describe('sigv4', () => {
  it('spells an instant the way x-amz-date requires', () => {
    expect(amzDate(new Date('2013-05-24T00:00:00.000Z'))).toBe('20130524T000000Z')
  })

  it('encodes reserved characters the way AWS canonicalizes them', () => {
    expect(encodeRfc3986("a b!'()*~-_")).toBe('a%20b%21%27%28%29%2A~-_')
  })

  it('reproduces the AWS Signature Version 4 test suite get-vanilla vector', () => {
    const headers = signHeaders({
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      headers: {},
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      region: 'us-east-1',
      service: 'service',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      },
      date: new Date('2015-08-30T12:36:00.000Z'),
    })
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
      + 'SignedHeaders=host;x-amz-date, '
      + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    )
    expect(headers.host).toBe('example.amazonaws.com')
    expect(headers['x-amz-date']).toBe('20150830T123600Z')
  })

  it('canonicalizes paths and queries the way the signature requires', () => {
    expect(canonicalUri('/a b/c~d')).toBe('/a%20b/c~d')
    expect(canonicalUri('/')).toBe('/')
    expect(canonicalQuery('')).toBe('')
    expect(canonicalQuery('b=2&a=1&a=0&c=x%20y')).toBe('a=0&a=1&b=2&c=x%20y')
  })

  it('keeps a caller-supplied x-amz-date instead of the clock', () => {
    const headers = signHeaders({
      method: 'GET',
      url: new URL('https://example.com/'),
      headers: { 'x-amz-date': '20150830T123600Z' },
      payloadHash: UNSIGNED_PAYLOAD,
      region: 'us-east-1',
      service: 's3',
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'secret' },
      date: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(headers['x-amz-date']).toBe('20150830T123600Z')
    expect(headers.authorization).toContain('/20150830/us-east-1/s3/aws4_request')
  })

  it('signs a streamed upload without hashing the body', () => {
    const headers = signHeaders({
      method: 'PUT',
      url: new URL('https://s3.us-east-1.amazonaws.com/bucket/dir/archive.zip'),
      headers: { 'x-amz-content-sha256': UNSIGNED_PAYLOAD },
      payloadHash: UNSIGNED_PAYLOAD,
      region: 'us-east-1',
      service: 's3',
      credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'secret' },
      date: new Date('2026-10-30T12:00:00.000Z'),
    })
    expect(headers['x-amz-content-sha256']).toBe(UNSIGNED_PAYLOAD)
    const authorization = headers.authorization
    expect(authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261030\/us-east-1\/s3\/aws4_request, /u)
    expect(authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=')
    expect(authorization).toMatch(/Signature=[0-9a-f]{64}$/u)
  })
})
