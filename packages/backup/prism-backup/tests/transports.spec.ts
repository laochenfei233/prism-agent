/** Transports: every provider failure maps onto the feature's codes, and each verb does its job. */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeArchive } from '../src/archive.ts'
import { createTransport, uncShareOf } from '../src/transports.ts'

const roots: string[] = []

/**
 * Build one throwaway directory holding a staged archive.
 * @returns the staged file path.
 */
async function staged(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'prism-backup-transport-'))
  roots.push(root)
  const file = join(root, 'archive.zip')
  await writeFile(file, 'PK-staged', 'utf8')
  return file
}

/**
 * A fetch double that answers in order and records what it saw.
 * @param answers - responses, or a thrown error to answer with.
 * @returns the double and its calls.
 */
function fakeFetch(answers: readonly (Response | Error)[]): {
  fetch: typeof globalThis.fetch
  calls: { url: string; init: RequestInit }[]
} {
  const calls: { url: string; init: RequestInit }[] = []
  const queue = [...answers]
  const handler: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init: init ?? {} })
    const next = queue.shift()
    if (next === undefined) throw new Error('fake fetch ran out of answers')
    if (next instanceof Error) throw next
    return next
  }
  return { fetch: handler, calls }
}

/**
 * Read one recorded call.
 * @param calls - the recorded calls.
 * @param index - which call, from zero.
 * @returns the call.
 */
function callAt(calls: readonly { url: string; init: RequestInit }[], index: number): { url: string; init: RequestInit } {
  const call = calls[index]
  if (call === undefined) throw new Error(`fake fetch recorded no call ${String(index)}`)
  return call
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('webdav transport', () => {
  const target = { type: 'webdav' as const, baseUrl: 'https://dav.example.com/x', username: 'me', password: 'pw' }

  it('reports the answered status on a successful probe and sends basic auth', async () => {
    const fake = fakeFetch([new Response(null, { status: 207 })])
    const transport = createTransport(target, { fetch: fake.fetch })
    await expect(transport.test()).resolves.toBe('WebDAV answered HTTP 207 at https://dav.example.com/x.')
    expect(callAt(fake.calls, 0).init.method).toBe('PROPFIND')
    expect(new Headers(callAt(fake.calls, 0).init.headers).get('authorization'))
      .toBe(`Basic ${Buffer.from('me:pw').toString('base64')}`)
  })

  it('separates a refused credential from an unreachable server', async () => {
    const refused = createTransport(target, { fetch: fakeFetch([new Response('no', { status: 401 })]).fetch })
    await expect(refused.test()).rejects.toMatchObject({ code: 'prism-backup/auth-failed' })
    const unreachable = createTransport(target, { fetch: fakeFetch([new TypeError('fetch failed')]).fetch })
    await expect(unreachable.test()).rejects.toMatchObject({ code: 'prism-backup/connection-failed' })
    const broken = createTransport(target, { fetch: fakeFetch([new Response('boom', { status: 500 })]).fetch })
    await expect(broken.test()).rejects.toThrow(/HTTP 500 for https:\/\/dav\.example\.com\/x: boom/u)
  })

  it('uploads with PUT and creates missing collections before retrying once', async () => {
    const file = await staged()
    const fake = fakeFetch([
      new Response(null, { status: 409 }),
      new Response(null, { status: 201 }),
      new Response(null, { status: 201 }),
      new Response(null, { status: 201 }),
    ])
    const transport = createTransport(target, { fetch: fake.fetch })
    await transport.upload(file, 'prism-backup/2026/a.zip')
    expect(fake.calls.map(call => call.init.method)).toEqual(['PUT', 'MKCOL', 'MKCOL', 'PUT'])
    expect(callAt(fake.calls, 1).url).toBe('https://dav.example.com/x/prism-backup')
    expect(callAt(fake.calls, 2).url).toBe('https://dav.example.com/x/prism-backup/2026')
    expect(callAt(fake.calls, 3).url).toBe('https://dav.example.com/x/prism-backup/2026/a.zip')
  })

  it('surfaces a write refusal and a collection failure as upload failures', async () => {
    const file = await staged()
    const refused = createTransport(target, { fetch: fakeFetch([new Response('nope', { status: 403 })]).fetch })
    await expect(refused.upload(file, 'a.zip')).rejects.toMatchObject({ code: 'prism-backup/auth-failed' })

    const refusedWrite = createTransport(target, { fetch: fakeFetch([new Response('full', { status: 507 })]).fetch })
    await expect(refusedWrite.upload(file, 'a.zip')).rejects.toThrow(/refused the archive \(HTTP 507\): full/u)

    const collection = createTransport(target, { fetch: fakeFetch([
      new Response(null, { status: 409 }), new Response(null, { status: 500 }),
    ]).fetch })
    await expect(collection.upload(file, 'd/a.zip')).rejects.toThrow(/could not create the collection d/u)
  })

  it('lists href basenames and deletes objects, tolerating a missing one', async () => {
    const listing = '<?xml version="1.0"?><d:multistatus><d:response><d:href>/x/..</d:href></d:response><d:response><d:href>/x/prism-backup/</d:href></d:response>'
      + '<d:response><d:href>/x/prism-backup/prism-backup-20260101-000000.zip</d:href></d:response>'
      + '<d:response><href>/x/prism-backup/other.zip</href></d:response>'
      + '<d:response><href>/x/prism-backup/bad%zz.zip</href></d:response></d:multistatus>'
    const fake = fakeFetch([
      new Response(listing, { status: 207 }),
      new Response(null, { status: 404 }),
      new Response(null, { status: 204 }),
    ])
    const transport = createTransport(target, { fetch: fake.fetch })
    await expect(transport.list('prism-backup')).resolves.toEqual([
      'prism-backup', 'prism-backup-20260101-000000.zip', 'other.zip', 'bad%zz.zip',
    ])
    await expect(transport.remove('gone.zip')).resolves.toBeUndefined()
    await expect(transport.remove('there.zip')).resolves.toBeUndefined()
  })

  it('reports an unreachable server on every verb', async () => {
    const file = await staged()
    const upload = createTransport(target, { fetch: fakeFetch([new TypeError('down')]).fetch })
    await expect(upload.upload(file, 'a.zip')).rejects.toThrow(/WebDAV upload to .* failed: down/u)
    const collection = createTransport(target, { fetch: fakeFetch([
      new Response(null, { status: 409 }), new TypeError('down'),
    ]).fetch })
    await expect(collection.upload(file, 'd/a.zip')).rejects.toThrow(/could not create d: down/u)
    const listing = createTransport(target, { fetch: fakeFetch([new TypeError('down')]).fetch })
    await expect(listing.list('')).rejects.toMatchObject({ code: 'prism-backup/connection-failed' })
    const deleting = createTransport(target, { fetch: fakeFetch([new TypeError('down')]).fetch })
    await expect(deleting.remove('a.zip')).rejects.toThrow(/WebDAV delete failed: down/u)
  })

  it('fails a listing that answers an error', async () => {
    const transport = createTransport(target, { fetch: fakeFetch([new Response('', { status: 500 })]).fetch })
    await expect(transport.list('prism-backup')).rejects.toMatchObject({ code: 'prism-backup/connection-failed' })
    const deleting = createTransport(target, { fetch: fakeFetch([new Response('', { status: 500 })]).fetch })
    await expect(deleting.remove('a.zip')).rejects.toThrow(/could not delete a\.zip/u)
  })
})

describe('webdav upload body', () => {
  it('sends one zip whose members and manifest match the plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-backup-upload-'))
    roots.push(root)
    const file = join(root, 'archive.zip')
    const members = [
      { path: join(root, 'a.txt'), archivePath: 'prism-backup/settings/a.txt', size: 5 },
      { path: join(root, 'b.json'), archivePath: 'prism-backup/memory/b.json', size: 2 },
    ]
    const [firstMember, secondMember] = members as [typeof members[0], typeof members[0]]
    await writeFile(firstMember.path, 'hello')
    await writeFile(secondMember.path, '{}')
    await writeArchive(members, {
      format: 1,
      createdAt: '2026-10-30T12:00:00.000Z',
      app: 'Prism Agent',
      version: 'test',
      platform: 'test',
      counts: { settings: 1, memoryFiles: 1, projects: 0, projectFiles: 0 },
      bytes: { settings: 5, memory: 2, projects: 0 },
      absent: [],
      warnings: [],
    }, file)

    const fake = fakeFetch([new Response(null, { status: 201 })])
    const transport = createTransport(
      { type: 'webdav', baseUrl: 'https://dav.example.com/x', username: 'me', password: 'pw' },
      { fetch: fake.fetch },
    )
    await transport.upload(file, 'prism-backup/archive.zip')
    const body = callAt(fake.calls, 0).init.body
    expect(body).toBeInstanceOf(Blob)
    const archive = unzipSync(new Uint8Array(await (body as Blob).arrayBuffer()))
    expect(Object.keys(archive).sort()).toEqual([
      'prism-backup/manifest.json',
      'prism-backup/memory/b.json',
      'prism-backup/settings/a.txt',
    ])
    const manifest = JSON.parse(new TextDecoder().decode(archive['prism-backup/manifest.json'])) as {
      counts: unknown
      bytes: unknown
    }
    expect(manifest.counts).toEqual({ settings: 1, memoryFiles: 1, projects: 0, projectFiles: 0 })
    expect(manifest.bytes).toEqual({ settings: 5, memory: 2, projects: 0 })
  })
})

describe('s3 transport', () => {
  const target = {
    type: 's3' as const,
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    region: 'us-east-1',
    bucket: 'bucket',
    pathStyle: false,
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'secret',
  }

  it('addresses the bucket virtually and signs every request', async () => {
    const file = await staged()
    const fake = fakeFetch([new Response(null, { status: 200 })])
    const transport = createTransport(target, { fetch: fake.fetch, now: () => new Date('2026-10-30T12:00:00.000Z') })
    await transport.upload(file, 'prism-backup/a.zip')
    const headers = new Headers(callAt(fake.calls, 0).init.headers)
    expect(callAt(fake.calls, 0).url).toBe('https://bucket.s3.us-east-1.amazonaws.com/prism-backup/a.zip')
    expect(headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD')
    expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20261030\/us-east-1\/s3\/aws4_request/u)
  })

  it('addresses a path-style bucket and probes through a listing', async () => {
    const xml = '<?xml version="1.0"?><ListBucketResult><Contents><Key>prism-backup/old.zip</Key></Contents></ListBucketResult>'
    const fake = fakeFetch([new Response(xml, { status: 200 })])
    const transport = createTransport({ ...target, pathStyle: true, endpoint: 'http://minio.local:9000' }, { fetch: fake.fetch })
    await expect(transport.test()).resolves.toMatch(/bucket listing/u)
    expect(callAt(fake.calls, 0).url).toBe('http://minio.local:9000/bucket/?list-type=2&max-keys=1')
  })

  it('maps a refused key pair onto auth-failed', async () => {
    const probe = createTransport(target, { fetch: fakeFetch([new Response('', { status: 403 })]).fetch })
    await expect(probe.test()).rejects.toMatchObject({ code: 'prism-backup/auth-failed' })
    const upload = createTransport(target, { fetch: fakeFetch([new Response('', { status: 401 })]).fetch })
    await expect(upload.upload(await staged(), 'a.zip')).rejects.toMatchObject({ code: 'prism-backup/auth-failed' })
  })

  it('reports a refused upload, listing, and delete', async () => {
    const upload = createTransport(target, { fetch: fakeFetch([new Response('denied', { status: 400 })]).fetch })
    await expect(upload.upload(await staged(), 'a.zip')).rejects.toThrow(/refused the archive \(HTTP 400\): denied/u)
    const listing = createTransport(target, { fetch: fakeFetch([new Response('', { status: 500 })]).fetch })
    await expect(listing.list('')).rejects.toMatchObject({ code: 'prism-backup/connection-failed' })
    const deleting = createTransport(target, { fetch: fakeFetch([new Response('', { status: 500 })]).fetch })
    await expect(deleting.remove('a.zip')).rejects.toThrow(/could not delete a\.zip/u)
    const missing = createTransport(target, { fetch: fakeFetch([new Response(null, { status: 404 })]).fetch })
    await expect(missing.remove('a.zip')).resolves.toBeUndefined()
    const refusedDelete = createTransport(target, { fetch: fakeFetch([new Response('', { status: 500 })]).fetch })
    await expect(refusedDelete.remove('a.zip')).rejects.toThrow(/S3 could not delete a\.zip \(HTTP 500\)/u)
    const deleted = createTransport(target, { fetch: fakeFetch([new Response(null, { status: 204 })]).fetch })
    await expect(deleted.remove('a.zip')).resolves.toBeUndefined()
  })

  it('uses the process-global fetch when none is injected', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 200 }))
    const transport = createTransport(target)
    await expect(transport.upload(await staged(), 'a.zip')).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('truncates a long error body and uses the wall clock when none is injected', async () => {
    const long = 'x'.repeat(300)
    const probe = createTransport(target, { fetch: fakeFetch([new Response(long, { status: 500 })]).fetch })
    await expect(probe.test()).rejects.toThrow(/x{200}…/u)
    const file = await staged()
    const upload = createTransport(target, { fetch: fakeFetch([new Response(null, { status: 200 })]).fetch })
    await expect(upload.upload(file, 'a.zip')).resolves.toBeUndefined()
  })

  it('reports a server error on the probe and on an upload', async () => {
    const probe = createTransport(target, { fetch: fakeFetch([new Response('bad gateway', { status: 502 })]).fetch })
    await expect(probe.test()).rejects.toThrow(/S3 answered HTTP 502 for https:\/\/s3\.us-east-1\.amazonaws\.com\/bucket: bad gateway/u)
    const upload = createTransport(target, { fetch: fakeFetch([new Response('quota', { status: 507 })]).fetch })
    await expect(upload.upload(await staged(), 'a.zip')).rejects.toThrow(/refused the archive \(HTTP 507\): quota/u)
  })

  it('lists decoded keys and treats an unreachable endpoint as a connection failure', async () => {
    const xml = '<ListBucketResult><Contents><Key>prism-backup/a&amp;b.zip</Key></Contents>'
      + '<Contents><Key>prism-backup/c.zip</Key></Contents>'
      + '<Contents><Key>elsewhere/d.zip</Key></Contents></ListBucketResult>'
    const transport = createTransport(target, { fetch: fakeFetch([new Response(xml, { status: 200 })]).fetch })
    await expect(transport.list('prism-backup')).resolves.toEqual(['a&b.zip', 'c.zip', 'elsewhere/d.zip'])
    const root = createTransport(target, { fetch: fakeFetch([
      new Response('<ListBucketResult><Key>stray.zip</Key></ListBucketResult>', { status: 200 }),
    ]).fetch })
    await expect(root.list('')).resolves.toEqual(['stray.zip'])
    const down = createTransport(target, { fetch: fakeFetch([new TypeError('no route')]).fetch })
    await expect(down.test()).rejects.toMatchObject({ code: 'prism-backup/connection-failed' })
  })
})

describe('smb transport', () => {
  it('proves a writable directory and round-trips an archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-backup-smb-'))
    roots.push(root)
    const file = await staged()
    const transport = createTransport({ type: 'smb', root, username: '', password: '' }, { platform: 'linux' })
    await expect(transport.test()).resolves.toBe(`SMB directory ${root} is writable.`)
    await transport.upload(file, 'prism-backup/a.zip')
    expect(await readFile(join(root, 'prism-backup', 'a.zip'), 'utf8')).toBe('PK-staged')
    await writeFile(join(root, 'prism-backup', 'partial.tmp'), 'x')
    expect(await transport.list('prism-backup')).toEqual(['a.zip'])
    await transport.remove('prism-backup/a.zip')
    await expect(readdir(join(root, 'prism-backup'))).resolves.toEqual(['partial.tmp'])
    await expect(transport.remove('prism-backup/a.zip')).resolves.toBeUndefined()
    // A directory where an object was expected cannot be unlinked; the refusal is a delete failure.
    await expect(transport.remove('prism-backup')).rejects.toMatchObject({ code: 'prism-backup/upload-failed' })
    expect(transport.endpoint).toBe(root)
  })

  it('lists the store root and writes a key without a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-backup-smb-'))
    roots.push(root)
    const file = await staged()
    const transport = createTransport({ type: 'smb', root, username: '', password: '' }, { platform: 'linux' })
    await transport.upload(file, 'flat.zip')
    await expect(transport.list('')).resolves.toEqual(['flat.zip'])
    await transport.remove('flat.zip')
  })

  it('refuses a path that is not a writable directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-backup-smb-'))
    roots.push(root)
    const file = join(root, 'not-a-dir')
    await writeFile(file, 'x')
    const transport = createTransport({ type: 'smb', root: file, username: '', password: '' }, { platform: 'linux' })
    await expect(transport.test()).rejects.toThrow(/is not a directory/u)
  })

  it('extracts the share a Windows session can open', () => {
    expect(uncShareOf('\\\\server\\share\\folder')).toBe('\\\\server\\share')
    expect(uncShareOf('\\\\server\\share')).toBe('\\\\server\\share')
    expect(uncShareOf('D:\\backup')).toBeUndefined()
  })

  it('bootstraps a Windows session once and reports a refused credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-backup-smb-'))
    roots.push(root)
    const target = { type: 'smb' as const, root: join(root, 'backup'), username: 'u', password: 'p' }
    const shareOfPath = (): string => '\\\\server\\share'
    const runNetUse = vi.fn(async () => {})
    const transport = createTransport(target, { platform: 'win32', runNetUse, shareOfPath })
    await expect(transport.test()).rejects.toMatchObject({ code: 'prism-backup/connection-failed' })
    expect(runNetUse).toHaveBeenCalledWith('\\\\server\\share', 'u', 'p')
    expect(runNetUse).toHaveBeenCalledTimes(1)

    const refusing = vi.fn(async () => { throw new Error('access denied') })
    const refused = createTransport(target, { platform: 'win32', runNetUse: refusing, shareOfPath })
    await expect(refused.test()).rejects.toMatchObject({ code: 'prism-backup/auth-failed' })
  })

  it('never bootstraps on a non-Windows host or without stored credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'prism-backup-smb-'))
    roots.push(root)
    const missing = join(root, 'backup')
    const shareOfPath = (): string => '\\\\server\\share'
    const runNetUse = vi.fn(async () => {})
    const nonWindows = createTransport(
      { type: 'smb', root: missing, username: 'u', password: 'p' },
      { platform: 'linux', runNetUse, shareOfPath },
    )
    await expect(nonWindows.test()).rejects.toMatchObject({ code: 'prism-backup/connection-failed' })
    const anonymous = createTransport(
      { type: 'smb', root: missing, username: '', password: '' },
      { platform: 'win32', runNetUse, shareOfPath },
    )
    await expect(anonymous.test()).rejects.toMatchObject({ code: 'prism-backup/connection-failed' })
    const localPath = createTransport(
      { type: 'smb', root: missing, username: 'u', password: 'p' },
      { platform: 'win32', runNetUse },
    )
    await expect(localPath.test()).rejects.toMatchObject({ code: 'prism-backup/connection-failed' })
    expect(runNetUse).not.toHaveBeenCalled()
  })
})
