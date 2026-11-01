/**
 * HTML reading: entities, markup removal, anchor offsets, and bounded page text.
 */
import { describe, expect, it } from 'vitest'
import { anchors, decodeEntities, isCJK, pageTitle, readPageText, stripTags } from '../src/html.ts'

describe('decodeEntities', () => {
  it('decodes named, decimal, and hexadecimal entities', () => {
    expect(decodeEntities('a&amp;b|&#65;|&#x42;|&nbsp;c')).toBe('a&b|A|B| c')
  })

  it('leaves unknown entities and plain text alone', () => {
    expect(decodeEntities('&nosuchentity; plain')).toBe('&nosuchentity; plain')
  })
})

describe('stripTags', () => {
  it('removes markup, decodes entities, and collapses whitespace', () => {
    expect(stripTags('<b>Hello</b>\n  <i>world</i> &amp; more')).toBe('Hello world & more')
  })
})

describe('anchors', () => {
  it('reads quoted and unquoted hrefs with stable offsets', () => {
    const html = '<p><a href="https://a.test/x">First link</a><a href=\'https://b.test/y\'>Second link</a><a href=https://c.test/z>Third link</a></p>'
    const found = anchors(html)
    expect(found.map(anchor => anchor.href)).toEqual(['https://a.test/x', 'https://b.test/y', 'https://c.test/z'])
    expect(found.map(anchor => anchor.text)).toEqual(['First link', 'Second link', 'Third link'])
    expect(found[0]?.end).toBeLessThanOrEqual(found[1]?.start ?? 0)
  })

  it('skips anchors without an href', () => {
    expect(anchors('<a name="top">no link</a>')).toEqual([])
  })
})

describe('readPageText', () => {
  it('drops scripts, styles, and comments and caps the text', () => {
    const html = '<html><head><style>.a{color:red}</style></head><body><script>var a = 1</script><!-- note --><p>Alpha</p><p>Beta</p></body></html>'
    expect(readPageText(html, 1000)).toBe('Alpha\nBeta')
    expect(readPageText(html, 5)).toBe('Alpha')
  })
})

describe('pageTitle', () => {
  it('returns the decoded title text', () => {
    expect(pageTitle('<html><head><title>A &amp; B</title></head></html>')).toBe('A & B')
    expect(pageTitle('<html></html>')).toBeUndefined()
  })
})

describe('isCJK', () => {
  it('detects CJK text', () => {
    expect(isCJK('深度搜索')).toBe(true)
    expect(isCJK('deep search')).toBe(false)
  })
})
