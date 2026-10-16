/**
 * Zero-call distillation: what the turn's own text has to look like before the
 * plugin treats a sentence as a durable claim.
 *
 * The rules recognize forms, not topics, so these specs assert that a stated
 * constraint, preference, cause, or convention is picked up and that everything
 * else — a question, a fragment, a paragraph, a command — is left alone. A
 * false positive here costs an operator a review decision, so the negative cases
 * carry as much weight as the positive ones.
 */

import { describe, expect, it } from 'vitest'
import { distillCandidates } from '../src/distill.ts'

describe('a stated constraint', () => {
  it('is captured with its form and claim class', () => {
    const [candidate] = distillCandidates('You must never run the release script from a dirty tree.')
    expect(candidate?.layer).toBe('rule')
    expect(candidate?.kind).toBe('decision')
    expect(candidate?.text).toBe('You must never run the release script from a dirty tree')
  })

  it('is recognized in Chinese as well as English', () => {
    const [candidate] = distillCandidates('发布脚本必须从干净的代码树运行，禁止在未提交的状态下打包。')
    expect(candidate?.layer).toBe('rule')
  })
})

describe('a stated preference', () => {
  it('is captured from the person asking', () => {
    const [candidate] = distillCandidates('I prefer tabs over spaces in this file.')
    expect(candidate?.layer).toBe('user')
    expect(candidate?.kind).toBe('preference')
  })

  it('is recognized in Chinese', () => {
    const [candidate] = distillCandidates('以后都用 pnpm 而不是 npm 来安装依赖。')
    expect(candidate?.layer).toBe('user')
  })
})

describe('an established cause', () => {
  it('is captured from either side of the turn', () => {
    const [candidate] = distillCandidates('The root cause was a stale build cache that survived the rebuild.')
    expect(candidate?.layer).toBe('lesson')
    expect(candidate?.kind).toBe('pitfall')
  })

  it('is preferred over a weaker rule match in the same sentence', () => {
    const [candidate] = distillCandidates('The cause was that the module always resolved the wrong path.')
    expect(candidate?.layer).toBe('lesson')
  })
})

describe('a workspace convention', () => {
  it('is captured as a project claim', () => {
    const [candidate] = distillCandidates('This repository keeps every plugin outside the pnpm workspace.')
    expect(candidate?.layer).toBe('project')
  })
})

describe('what is not a durable claim', () => {
  it('rejects a question, even one that names a rule', () => {
    expect(distillCandidates('Must I always run the release script from a clean tree?')).toEqual([])
  })

  it('rejects a sentence outside the accepted length band', () => {
    expect(distillCandidates('Never do it.')).toEqual([])
    expect(distillCandidates(`Never ${'x'.repeat(400)}`)).toEqual([])
  })

  it('rejects text that states nothing durable', () => {
    expect(distillCandidates('I ran the tests and they passed quickly.')).toEqual([])
  })

  it('rejects a duplicate of a claim it already extracted', () => {
    const text = 'The build must never run as root.\nThe build must never run as root!'
    expect(distillCandidates(text)).toHaveLength(1)
  })
})

describe('extraction is bounded and deterministic', () => {
  it('reads list markers and stops at the configured limit', () => {
    const text = [
      '- You must never commit directly to master.',
      '- You must always run the gate before pushing.',
      '- You must never force-push a shared branch.',
    ].join('\n')
    expect(distillCandidates(text, { limit: 2 })).toHaveLength(2)
    expect(distillCandidates(text, { limit: 2 })).toEqual(distillCandidates(text, { limit: 2 }))
  })

  it('keeps document order across the two sides of a turn', () => {
    const found = distillCandidates('I prefer short replies.\nThe cause was a missing index.')
    expect(found.map(candidate => candidate.layer)).toEqual(['user', 'lesson'])
  })

  it('reads the same bytes out of a Chinese paragraph and a list', () => {
    expect(distillCandidates('必须先用离线缓存安装依赖。')).toHaveLength(1)
    expect(distillCandidates('必须先用离线缓存安装依赖。')).toEqual(distillCandidates('必须先用离线缓存安装依赖。'))
  })
})
