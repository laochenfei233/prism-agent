/**
 * The client activation policy and gesture recognizer.
 *
 * Spec: docs/compose/spec/prism-pocket.md S2.2 — the decision is pure, so
 * every acceptance threshold is pinned here without a DOM.
 */
import { describe, expect, it } from 'vitest'
import {
  applicationServerKeyBytes,
  edgeSwipeAction,
  shouldActivate,
} from '../../src/client/pure.ts'

describe('shouldActivate', () => {
  it('activates narrow coarse-pointer viewports', () => {
    expect(shouldActivate(390, true, undefined)).toBe(true)
    expect(shouldActivate(768, true, undefined)).toBe(true)
  })

  it('leaves desktop fine-pointer viewports alone', () => {
    expect(shouldActivate(1280, false, undefined)).toBe(false)
    expect(shouldActivate(390, false, undefined)).toBe(false)
    expect(shouldActivate(1280, true, undefined)).toBe(false)
  })

  it('lets the explicit override win in both directions', () => {
    expect(shouldActivate(1920, false, 'on')).toBe(true)
    expect(shouldActivate(390, true, 'off')).toBe(false)
  })
})

describe('edgeSwipeAction', () => {
  it('recognizes a fast inward flick from the left edge', () => {
    expect(edgeSwipeAction(4, 400, 90, 410, 220)).toBe('open')
    expect(edgeSwipeAction(28, 400, 90, 400, 220)).toBe('open')
  })

  it('rejects touches that start away from the edge', () => {
    expect(edgeSwipeAction(29, 400, 90, 400, 220)).toBeNull()
  })

  it('rejects short, diagonal, and slow drags', () => {
    expect(edgeSwipeAction(4, 400, 50, 400, 220)).toBeNull()
    expect(edgeSwipeAction(4, 400, 90, 500, 220)).toBeNull()
    expect(edgeSwipeAction(4, 400, 90, 400, 900)).toBeNull()
  })
})

describe('applicationServerKeyBytes', () => {
  it('decodes base64url exactly like the Node decoder', () => {
    const key = Buffer.from(new Uint8Array(65).map((_, i) => (i * 7 + 3) % 256)).toString('base64url')
    const expected = Array.from(Buffer.from(key, 'base64url'))
    expect(Array.from(applicationServerKeyBytes(key))).toEqual(expected)
  })

  it('round-trips an unpadded value needing canonical padding', () => {
    const key = 'aGVsbG8' // 7 chars → padding required
    const expected = Array.from(Buffer.from(key, 'base64url'))
    expect(Array.from(applicationServerKeyBytes(key))).toEqual(expected)
  })
})
