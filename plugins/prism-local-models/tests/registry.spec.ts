/**
 * Registry contract: durable state round-trips, corrupt documents fail loud,
 * and integrity checks classify every on-disk reality.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { emptyRegistryDocument, ModelRegistry } from '../src/registry.ts'

const root = await mkdtemp(join(tmpdir(), 'prism-local-models-'))

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ModelRegistry', () => {
  it('returns the empty document when none exists', async () => {
    const registry = new ModelRegistry(join(root, 'empty'))
    expect(await registry.load()).toEqual(emptyRegistryDocument())
  })

  it('round-trips a document atomically', async () => {
    const dir = join(root, 'roundtrip')
    const registry = new ModelRegistry(dir)
    const document = { version: 1 as const, families: { bge: { variantId: 'v', status: 'ready' as const } } }
    await registry.save(document)
    expect(await registry.load()).toEqual(document)
    expect(await readFile(join(dir, 'registry.json'), 'utf8')).toMatch(/\n$/)
  })

  it('fails loud on a corrupt document', async () => {
    const dir = join(root, 'corrupt')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'registry.json'), '{ broken', 'utf8')
    await expect(new ModelRegistry(dir).load()).rejects.toThrow()
    await writeFile(join(dir, 'registry.json'), '{"hello":1}', 'utf8')
    await expect(new ModelRegistry(dir).load()).rejects.toThrow(/version-1/)
  })
})

describe('ModelRegistry.verifyFile', () => {
  const content = Buffer.from('model bytes for hashing')
  const sha256 = createHash('sha256').update(content).digest('hex')
  const sizeBytes = content.byteLength

  it('matches correct bytes', async () => {
    const file = join(root, 'good.bin')
    await writeFile(file, content)
    expect(await ModelRegistry.verifyFile(file, sizeBytes, sha256)).toBe('match')
  })

  it('classifies missing, wrong size, and wrong bytes', async () => {
    expect(await ModelRegistry.verifyFile(join(root, 'nope.bin'), sizeBytes, sha256)).toBe('missing')
    const short = join(root, 'short.bin')
    await writeFile(short, content.subarray(1))
    expect(await ModelRegistry.verifyFile(short, sizeBytes, sha256)).toBe('size-mismatch')
    const wrong = join(root, 'wrong.bin')
    await writeFile(wrong, Buffer.alloc(sizeBytes, 7))
    expect(await ModelRegistry.verifyFile(wrong, sizeBytes, sha256)).toBe('hash-mismatch')
  })
})
