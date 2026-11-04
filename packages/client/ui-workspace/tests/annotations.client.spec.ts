/** Annotation normalization and the clipboard round-trip: the values the editor and an import both produce. */
import { describe, expect, it } from 'vitest'
import {
  AnnotationImportError, annotationJson, annotationPrompt, composeAnnotation, formatTags, isEmptyAnnotation,
  MAX_NOTE_LENGTH, normalizeNote, parseAnnotationImport, parseTags, sameAnnotation,
} from '../src/client/annotations.ts'

describe('parseTags', () => {
  it('splits on both comma spellings, trims, and de-duplicates case-insensitively', () => {
    expect(parseTags(' Bug , bug，BUG, , fix ')).toEqual(['Bug', 'fix'])
  })

  it('caps the tag count and each tag length', () => {
    const many = Array.from({ length: 25 }, (_, index) => `t${index}`).join(',')
    expect(parseTags(many)).toHaveLength(20)
    expect(parseTags(many).at(-1)).toBe('t19')
    expect(parseTags('x'.repeat(40))).toEqual(['x'.repeat(32)])
  })
})

describe('formatTags', () => {
  it('joins stored tags and renders nothing for an absent list', () => {
    expect(formatTags(['a', 'b'])).toBe('a, b')
    expect(formatTags(undefined)).toBe('')
  })
})

describe('normalizeNote', () => {
  it('trims, caps, and treats an empty draft as no note', () => {
    expect(normalizeNote('  hello  ')).toBe('hello')
    expect(normalizeNote('   ')).toBeUndefined()
    expect(normalizeNote('y'.repeat(MAX_NOTE_LENGTH + 10))).toHaveLength(MAX_NOTE_LENGTH)
  })
})

describe('composeAnnotation', () => {
  it('omits every default-valued field', () => {
    expect(composeAnnotation({ favorite: false, reviewLater: false, priority: 3, tags: '', note: '' })).toEqual({})
    expect(composeAnnotation({ favorite: true, reviewLater: true, priority: 2, tags: 'a, b', note: ' n ' }))
      .toEqual({ favorite: true, reviewLater: true, priority: 2, tags: ['a', 'b'], note: 'n' })
  })
})

describe('isEmptyAnnotation', () => {
  it('treats defaults as empty and any real value as content', () => {
    expect(isEmptyAnnotation({})).toBe(true)
    expect(isEmptyAnnotation({ priority: 3, tags: [], favorite: false, reviewLater: false })).toBe(true)
    expect(isEmptyAnnotation({ favorite: true })).toBe(false)
    expect(isEmptyAnnotation({ reviewLater: true })).toBe(false)
    expect(isEmptyAnnotation({ priority: 2 })).toBe(false)
    expect(isEmptyAnnotation({ tags: ['a'] })).toBe(false)
    expect(isEmptyAnnotation({ note: 'x' })).toBe(false)
  })
})

describe('sameAnnotation', () => {
  it('compares normalized values', () => {
    expect(sameAnnotation({}, { priority: 3 })).toBe(true)
    expect(sameAnnotation({ tags: ['a'] }, { tags: ['a'] })).toBe(true)
    expect(sameAnnotation({ favorite: true }, {})).toBe(false)
    expect(sameAnnotation({ reviewLater: true }, {})).toBe(false)
    expect(sameAnnotation({ note: 'a' }, { note: 'b' })).toBe(false)
    expect(sameAnnotation({ tags: ['a'] }, { tags: ['b'] })).toBe(false)
    expect(sameAnnotation({ priority: 1 }, { priority: 2 })).toBe(false)
  })
})

describe('annotationJson and annotationPrompt', () => {
  it('publishes the documented fields with their defaults', () => {
    expect(JSON.parse(annotationJson({}))).toEqual({ favorite: false, reviewLater: false, priority: 3, tags: [], note: '' })
  })

  it('fills both placeholders of the prompt template', () => {
    const text = annotationPrompt('{title} :: {json}', 'My session', { favorite: true })
    expect(text.startsWith('My session :: ')).toBe(true)
    expect(text).toContain('"favorite": true')
  })
})

describe('parseAnnotationImport', () => {
  it('reads a fenced, BOM-prefixed, smart-quoted answer', () => {
    const text = '\uFEFF```json\n{“favorite”: true, “tags”: "a，b"}\n```'
    expect(parseAnnotationImport(text)).toEqual({ favorite: true, tags: ['a', 'b'] })
  })

  it('keeps typographic quotes that are part of a value', () => {
    expect(parseAnnotationImport('{"note": "他说“好”"}')).toEqual({ note: '他说“好”' })
    expect(parseAnnotationImport('{"note": "it is ‘fine’"}')).toEqual({ note: 'it is ‘fine’' })
  })

  it('accepts an empty object and keeps a non-default priority', () => {
    expect(parseAnnotationImport('{}')).toEqual({})
    expect(parseAnnotationImport('{"priority": 1}')).toEqual({ priority: 1 })
  })

  it('ignores unknown keys and mistyped fields', () => {
    expect(parseAnnotationImport('{"favorite": "yes", "priority": 9, "tags": 5, "note": 7, "other": true}'))
      .toEqual({})
  })

  it('reads a tags array, dropping entries that are not strings', () => {
    expect(parseAnnotationImport('{"tags": ["a", 2, "b"], "note": "  n  "}'))
      .toEqual({ tags: ['a', 'b'], note: 'n' })
  })

  it('rejects text without a JSON object and malformed JSON', () => {
    expect(() => parseAnnotationImport('nothing here')).toThrow(AnnotationImportError)
    expect(() => parseAnnotationImport('{')).toThrow(AnnotationImportError)
    expect(() => parseAnnotationImport('{oops}')).toThrow(AnnotationImportError)
    expect(() => parseAnnotationImport('{[]}')).toThrow(AnnotationImportError)
  })
})
