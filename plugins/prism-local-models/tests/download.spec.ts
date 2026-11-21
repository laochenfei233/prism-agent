/**
 * Install lifecycle against a local HTTP origin: verified install lands a
 * ready family, checksum failures surface as errors, cancel cleans up, and
 * remove deletes the tree.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '../src/config.ts'
import { PrismLocalModelsService } from '../src/service.ts'
import type { ModelStatus } from '../src/types.ts'

const good = Buffer.alloc(512 * 1024, 7)
const goodSha256 = createHash('sha256').update(good).digest('hex')
const bad = Buffer.alloc(good.byteLength, 9)

let server: Server
let origin = ''
const root = await mkdtemp(join(tmpdir(), 'prism-local-models-dl-'))

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? ''
    if (path === '/good') {
      response.writeHead(200, { 'Content-Length': String(good.byteLength) })
      response.end(good)
    } else if (path === '/bad') {
      response.writeHead(200, { 'Content-Length': String(bad.byteLength) })
      response.end(bad)
    } else if (path === '/slow') {
      response.writeHead(200)
      let offset = 0
      const timer = setInterval(() => {
        if (offset >= good.byteLength || response.destroyed) {
          clearInterval(timer)
          response.end()
          return
        }
        const chunk = good.subarray(offset, offset + 16 * 1024)
        offset += chunk.byteLength
        response.write(chunk)
      }, 20)
      response.on('close', () => clearInterval(timer))
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      origin = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
})

/** A service whose bge family points at the local origin. */
async function serviceWith(variants: object[]): Promise<PrismLocalModelsService> {
  const override = join(root, `override-${Math.random().toString(36).slice(2)}.json`)
  await writeFile(override, JSON.stringify({ families: { bge: { defaultVariantId: 'tiny', variants } } }))
  // Each call gets its own models root so tests do not share registry state.
  const config: ResolvedConfig = { pythonCommand: 'python', catalogOverride: override, modelsRoot: join(root, 'models', Math.random().toString(36).slice(2)) }
  const service = new PrismLocalModelsService(config, root)
  await service.catalog()
  return service
}

/** Poll one family's status until it settles. */
async function waitFor(service: PrismLocalModelsService, statuses: ModelStatus[], timeoutMs = 8000): Promise<ModelStatus> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const view = await service.status()
    const status = view.families['bge']?.status ?? 'idle'
    if (statuses.includes(status)) return status
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${statuses.join('|')}, last: ${status}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('install lifecycle', () => {
  it('installs a verified variant and reports it ready', async () => {
    const service = await serviceWith([
      { id: 'tiny', displayName: 'tiny', device: 'cpu', files: [{ path: 'model.onnx', url: `${origin}/good`, sizeBytes: good.byteLength, sha256: goodSha256 }] },
    ])
    await service.install('bge', 'tiny')
    expect(await waitFor(service, ['ready'])).toBe('ready')
    const catalog = await service.catalog()
    const family = catalog.families.find(candidate => candidate.id === 'bge')
    expect(family?.status).toBe('ready')
    expect(family?.variants.find(variant => variant.id === 'tiny')?.installed).toBe(true)
    expect((await stat(join(service.modelsRoot, 'bge', 'tiny', 'model.onnx'))).size).toBe(good.byteLength)
    expect(await readdir(join(service.modelsRoot, 'bge', 'tiny'))).toEqual(['model.onnx'])
    await service.remove('bge')
    expect(await waitFor(service, ['idle'])).toBe('idle')
    await expect(stat(join(service.modelsRoot, 'bge', 'tiny'))).rejects.toThrow()
  })

  it('surfaces a checksum failure as a family error and cleans the temp file', async () => {
    const service = await serviceWith([
      { id: 'tiny', displayName: 'tiny', device: 'cpu', files: [{ path: 'model.onnx', url: `${origin}/bad`, sizeBytes: bad.byteLength, sha256: goodSha256 }] },
    ])
    await service.install('bge', 'tiny')
    expect(await waitFor(service, ['error'])).toBe('error')
    const view = await service.status()
    expect(view.families['bge']?.error).toMatch(/checksum/i)
    expect(await readdir(join(service.modelsRoot, 'bge', 'tiny'))).toEqual([])
  })

  it('cancel stops a slow download, leaves the family idle, and cleans up', async () => {
    const service = await serviceWith([
      { id: 'tiny', displayName: 'tiny', device: 'cpu', files: [{ path: 'model.onnx', url: `${origin}/slow`, sizeBytes: good.byteLength, sha256: goodSha256 }] },
    ])
    await service.install('bge', 'tiny')
    expect(await waitFor(service, ['downloading'])).toBe('downloading')
    await service.cancel('bge')
    expect(await waitFor(service, ['idle'])).toBe('idle')
    expect(await readdir(join(service.modelsRoot, 'bge', 'tiny'))).toEqual([])
  })

  it('rejects a second operation on the same family while one runs', async () => {
    const service = await serviceWith([
      { id: 'tiny', displayName: 'tiny', device: 'cpu', files: [{ path: 'model.onnx', url: `${origin}/slow`, sizeBytes: good.byteLength, sha256: goodSha256 }] },
    ])
    await service.install('bge', 'tiny')
    await waitFor(service, ['downloading'])
    await expect(service.install('bge', 'tiny')).rejects.toThrow(/already has an operation/)
    await service.cancel('bge')
    await waitFor(service, ['idle'])
  })
})

describe('manual placement and variant switching', () => {
  it('detects a fully placed variant for a never-installed family on catalog read', async () => {
    const service = await serviceWith([
      { id: 'tiny', displayName: 'tiny', device: 'cpu', files: [{ path: 'model.onnx', url: `${origin}/good`, sizeBytes: good.byteLength, sha256: goodSha256 }] },
      { id: 'spare', displayName: 'spare', device: 'cpu', files: [{ path: 'model.onnx', url: `${origin}/good`, sizeBytes: good.byteLength, sha256: goodSha256 }] },
    ])
    const placed = join(service.modelsRoot, 'bge', 'spare')
    await mkdir(placed, { recursive: true })
    await writeFile(join(placed, 'model.onnx'), good)
    const catalog = await service.catalog()
    const family = catalog.families.find(candidate => candidate.id === 'bge')
    expect(family?.status).toBe('ready')
    expect(family?.selectedVariantId).toBe('spare')
  })

  it('deletes the previous variant directory when a different variant installs', async () => {
    const service = await serviceWith([
      { id: 'tiny', displayName: 'tiny', device: 'cpu', files: [{ path: 'model.onnx', url: `${origin}/good`, sizeBytes: good.byteLength, sha256: goodSha256 }] },
      { id: 'second', displayName: 'second', device: 'cpu', files: [{ path: 'other.onnx', url: `${origin}/good`, sizeBytes: good.byteLength, sha256: goodSha256 }] },
    ])
    await service.install('bge', 'tiny')
    expect(await waitFor(service, ['ready'])).toBe('ready')
    await service.install('bge', 'second')
    expect(await waitFor(service, ['ready'])).toBe('ready')
    const familyDir = join(service.modelsRoot, 'bge')
    const entries = await readdir(familyDir)
    expect(entries).toEqual(['second'])
    await service.remove('bge')
  })
})
