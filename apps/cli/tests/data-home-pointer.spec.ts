/** The CLI adopts the home a Settings-page relocation recorded, without overriding the operator. */

import { describe, expect, it } from 'vitest'
import { applyDataHomePointer } from '../src/bin.ts'

describe('applyDataHomePointer', () => {
  it('adopts the recorded home when the environment names none', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applyDataHomePointer(env, () => '/moved/prism')).toBe('/moved/prism')
    expect(env['DSH_HOME']).toBe('/moved/prism')
  })

  it('keeps an operator-provided DSH_HOME', () => {
    const env: NodeJS.ProcessEnv = { DSH_HOME: '/explicit/prism' }
    expect(applyDataHomePointer(env, () => '/moved/prism')).toBeUndefined()
    expect(env['DSH_HOME']).toBe('/explicit/prism')
  })

  it('treats a blank DSH_HOME as unset and adopts the pointer', () => {
    const env: NodeJS.ProcessEnv = { DSH_HOME: '   ' }
    expect(applyDataHomePointer(env, () => '/moved/prism')).toBe('/moved/prism')
    expect(env['DSH_HOME']).toBe('/moved/prism')
  })

  it('leaves the environment untouched when no pointer is recorded', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(applyDataHomePointer(env, () => undefined)).toBeUndefined()
    expect(env['DSH_HOME']).toBeUndefined()
  })
})
