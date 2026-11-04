/**
 * The pure half of model-read extraction: the request shape and the answer
 * parser. The integration behavior — what lands in the store, what a failed
 * call costs the turn — is covered by the automatic spec over the real spine.
 */

import { describe, expect, it } from 'vitest'
import { buildExtractionMessages, parseExtraction } from '../src/extract.ts'

describe('building the extraction request', () => {
  it('sends one user message carrying the directive and both sides of the turn', () => {
    const messages = buildExtractionMessages({ user: 'u-text', assistant: 'a-text' }, 4000)
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('user')
    const text = messages[0]?.content[0]?.type === 'text' ? messages[0].content[0].text : ''
    expect(text).toContain('JSON array')
    expect(text).toContain('u-text')
    expect(text).toContain('a-text')
  })

  it('clips an overbudget side from the head, keeping the conclusion', () => {
    const long = 'x'.repeat(500) + '-conclusion'
    const messages = buildExtractionMessages({ user: long, assistant: '' }, 100)
    const text = messages[0]?.content[0]?.type === 'text' ? messages[0].content[0].text : ''
    expect(text).toContain('-conclusion')
    expect(text).not.toContain('x'.repeat(100))
  })
})

describe('parsing the extraction answer', () => {
  it('reads a bare array', () => {
    const claims = parseExtraction(
      '[{"text":"a","layer":"user","kind":"preference","source":"user"}]',
      3,
    )
    expect(claims).toEqual([{ text: 'a', layer: 'user', kind: 'preference', source: 'user' }])
  })

  it('tolerates prose and a code fence around the array', () => {
    const claims = parseExtraction(
      'Here you go:\n```json\n[{"text":"a","layer":"rule","kind":"decision","source":"inferred"}]\n```\nDone.',
      3,
    )
    expect(claims).toHaveLength(1)
  })

  it('drops invalid elements and keeps the valid rest', () => {
    const claims = parseExtraction(
      '['
      + '{"text":"a","layer":"nonsense","kind":"fact","source":"user"},'
      + '{"text":"","layer":"user","kind":"fact","source":"user"},'
      + '{"text":"b","layer":"fact","kind":"fact","source":"maybe"},'
      + '{"text":"c","layer":"fact","kind":"procedure","source":"inferred"}'
      + ']',
      3,
    )
    expect(claims).toEqual([{ text: 'c', layer: 'fact', kind: 'procedure', source: 'inferred' }])
  })

  it('respects the claim cap', () => {
    const entries = [1, 2, 3].map(index => (
      `{"text":"c${index}","layer":"fact","kind":"fact","source":"inferred"}`
    )).join(',')
    expect(parseExtraction(`[${entries}]`, 2)).toHaveLength(2)
  })

  it('returns nothing for an answer with no array', () => {
    expect(parseExtraction('no claims here', 3)).toEqual([])
  })

  it('returns nothing for an answer that reads as no JSON', () => {
    expect(parseExtraction('[broken, array', 3)).toEqual([])
  })
})
