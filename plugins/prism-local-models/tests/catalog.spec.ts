/**
 * Catalog contract: pins are complete and well-formed, ids are unique, and
 * the override/mirror helpers behave.
 */
import { describe, expect, it } from 'vitest'
import { applyCatalogOverride, BUILTIN_CATALOG, resolveCatalogUrls } from '../src/catalog.ts'

describe('built-in catalog', () => {
  it('carries the four families', () => {
    expect(BUILTIN_CATALOG.map(family => family.id)).toEqual(['rapidocr', 'paddleocr', 'hy-mt-1.5', 'bge'])
  })

  it('uses unique family and variant ids with an existing default', () => {
    const familyIds = new Set<string>()
    for (const family of BUILTIN_CATALOG) {
      expect(familyIds.has(family.id), family.id).toBe(false)
      familyIds.add(family.id)
      const variantIds = new Set<string>()
      for (const variant of family.variants) {
        expect(variantIds.has(variant.id), `${family.id}/${variant.id}`).toBe(false)
        variantIds.add(variant.id)
        expect(variant.device === 'cpu' || variant.device === 'cuda').toBe(true)
      }
      expect(variantIds.has(family.defaultVariantId), `${family.id} default`).toBe(true)
    }
  })

  it('pins every downloaded file with url, size, and sha256', () => {
    for (const family of BUILTIN_CATALOG) {
      for (const variant of family.variants) {
        for (const file of variant.files) {
          expect(file.url).toMatch(/^https:\/\//)
          expect(file.sizeBytes, file.url).toBeGreaterThan(0)
          expect(file.sha256, file.url).toMatch(/^[0-9a-f]{64}$/)
          expect(file.path).not.toMatch(/^[\\/]/)
        }
      }
    }
  })

  it('provisions the engine-only variants through npm or pip', () => {
    const rapidocr = BUILTIN_CATALOG.find(family => family.id === 'rapidocr')
    expect(rapidocr?.variants[0]?.runtime?.kind).toBe('npm')
    const paddle = BUILTIN_CATALOG.find(family => family.id === 'paddleocr')
    expect(paddle?.variants.map(variant => variant.runtime?.kind)).toEqual(['pip', 'pip'])
  })
})

describe('resolveCatalogUrls', () => {
  it('swaps the origin and keeps the pathname', () => {
    const original = BUILTIN_CATALOG.flatMap(family => family.variants).flatMap(variant => variant.files)[0]
    const resolved = resolveCatalogUrls(BUILTIN_CATALOG, 'https://mirror.example')
    const file = resolved.flatMap(family => family.variants).flatMap(variant => variant.files)[0]
    expect(file.url).toMatch(/^https:\/\/mirror\.example\//)
    expect(new URL(file.url).pathname).toBe(new URL(original.url).pathname)
  })

  it('keeps the catalog untouched without a mirror base', () => {
    expect(resolveCatalogUrls(BUILTIN_CATALOG, undefined)).toBe(BUILTIN_CATALOG)
  })
})

describe('applyCatalogOverride', () => {
  it('merges a family override over the built-in entry', () => {
    const merged = applyCatalogOverride(JSON.stringify({ families: { bge: { displayName: 'My BGE' } } }))
    expect(merged.find(family => family.id === 'bge')?.displayName).toBe('My BGE')
    expect(merged.find(family => family.id === 'bge')?.variants.length)
      .toBe(BUILTIN_CATALOG.find(family => family.id === 'bge')?.variants.length)
  })

  it('rejects malformed documents', () => {
    expect(() => applyCatalogOverride('not json')).toThrow()
    expect(() => applyCatalogOverride('{}')).toThrow(/families/)
    expect(() => applyCatalogOverride(JSON.stringify({ families: { bge: 3 } }))).toThrow(/object/)
  })
})
describe('applyCatalogOverride validation', () => {
  it('rejects unknown family ids, unknown fields, and unknown top-level keys', () => {
    expect(() => applyCatalogOverride(JSON.stringify({ families: { nope: {} } }))).toThrow(/unknown family/)
    expect(() => applyCatalogOverride(JSON.stringify({ families: { bge: { nope: 1 } } }))).toThrow(/unknown fields/)
    expect(() => applyCatalogOverride(JSON.stringify({ families: {}, extra: true }))).toThrow(/unknown fields: extra/)
  })
})
