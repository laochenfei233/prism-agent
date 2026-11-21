/**
 * Card presentation helpers: byte formatting and progress reporting.
 */
import { describe, expect, it } from 'vitest'
import { formatBytes, progressPercent, progressText } from '../src/client/pure.ts'

describe('formatBytes', () => {
  it('formats KB, MB, and GB', () => {
    expect(formatBytes(512)).toBe('1 KB')
    expect(formatBytes(24_010_842)).toBe('23 MB')
    expect(formatBytes(1_133_080_512)).toBe('1.1 GB')
  })
})

describe('progressPercent', () => {
  it('reports whole percent while a download total is known', () => {
    expect(progressPercent({ phase: 'download', done: 250, total: 1000, label: 'model.onnx' })).toBe(25)
  })

  it('clamps a completed download to 100', () => {
    expect(progressPercent({ phase: 'download', done: 1200, total: 1000, label: 'model.onnx' })).toBe(100)
  })

  it('has no percentage without a download total', () => {
    expect(progressPercent({ phase: 'provision', done: 1, label: 'npm provisioning' })).toBeUndefined()
    expect(progressPercent({ phase: 'download', done: 0, total: 0, label: 'model.onnx' })).toBeUndefined()
  })
})

describe('progressText', () => {
  it('shows a percent while the total is known', () => {
    expect(progressText({ phase: 'download', done: 250, total: 1000, label: 'model.onnx' })).toBe(' 25%')
  })

  it('shows the label when no total exists', () => {
    expect(progressText({ phase: 'provision', done: 0, label: 'npm provisioning' })).toBe(' npm provisioning')
  })
})
