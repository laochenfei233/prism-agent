/**
 * Engine wrapper resolution: the three opaque `/link` engines are recognized,
 * the destination is read from the unfollowed redirect, and every unusable
 * answer degrades to no resolution instead of throwing.
 */
import { describe, expect, it, vi } from 'vitest'
import type { HttpRequest } from '../src/http.ts'
import { resolveEngineRedirect, wrapperHostOf } from '../src/redirect.ts'

/** A transport that answers with one location header. */
function httpWith(location: string | undefined): (request: HttpRequest) => Promise<{ readonly location?: string }> {
  return async () => (location === undefined ? {} : { location })
}

describe('wrapperHostOf', () => {
  it('recognizes the three wrapper engines and their subdomains', () => {
    expect(wrapperHostOf('https://www.baidu.com/link?url=x')).toBe('baidu.com')
    expect(wrapperHostOf('https://m.sogou.com/link?url=x')).toBe('sogou.com')
    expect(wrapperHostOf('https://www.so.com/link?m=x')).toBe('so.com')
  })

  it('returns undefined for ordinary result URLs and malformed input', () => {
    expect(wrapperHostOf('https://example.org/page')).toBeUndefined()
    expect(wrapperHostOf('not a url')).toBeUndefined()
  })
})

describe('resolveEngineRedirect', () => {
  it('reads the destination from an unfollowed redirect', async () => {
    const http = vi.fn(httpWith('https://example.org/real?x=1'))
    const target = await resolveEngineRedirect('https://www.baidu.com/link?url=abc', { timeoutMs: 1000 }, http)
    expect(target).toBe('https://example.org/real?x=1')
    expect(http).toHaveBeenCalledWith(expect.objectContaining({ redirect: 'manual' }))
  })

  it('never requests an ordinary result URL', async () => {
    const http = vi.fn(httpWith('https://example.org/real'))
    expect(await resolveEngineRedirect('https://example.org/page', { timeoutMs: 1000 }, http)).toBeUndefined()
    expect(http).not.toHaveBeenCalled()
  })

  it('returns undefined for a missing, non-HTTP, relative, or wrapper destination', async () => {
    expect(await resolveEngineRedirect('https://www.baidu.com/link?url=x', { timeoutMs: 1000 }, httpWith(undefined))).toBeUndefined()
    expect(await resolveEngineRedirect('https://www.baidu.com/link?url=x', { timeoutMs: 1000 }, httpWith('javascript:alert(1)'))).toBeUndefined()
    expect(await resolveEngineRedirect('https://www.sogou.com/link?url=x', { timeoutMs: 1000 }, httpWith('/final'))).toBeUndefined()
    expect(await resolveEngineRedirect('https://www.baidu.com/link?url=x', { timeoutMs: 1000 }, httpWith('https://www.so.com/link?m=y'))).toBeUndefined()
  })

  it('returns undefined when the probe fails', async () => {
    const failing = async (): Promise<{ readonly location?: string }> => { throw new Error('network') }
    expect(await resolveEngineRedirect('https://www.baidu.com/link?url=x', { timeoutMs: 1000 }, failing)).toBeUndefined()
  })
})
