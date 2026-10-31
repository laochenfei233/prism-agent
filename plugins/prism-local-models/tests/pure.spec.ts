/**
 * Card presentation helpers: byte formatting and progress suffixes.
 */
import { describe, expect, it } from 'vitest'
import { formatBytes, progressText } from '../src/client/pure.ts'

describe('formatBytes', () => {
  it('formats KB, MB, and GB', () => {
    expect(formatBytes(512)).toBe('1 KB')
    expect(formatBytes(24_010_842)).toBe('23 MB')
    expect(formatBytes(1_133_080_512)).toBe('1.1 GB')
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
