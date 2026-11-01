/** The panel's face: reads, mutations, races, and refusals over a scripted fetch. */
import { describe, expect, it } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { GIT_COMMIT_ROUTE, GIT_STAGE_ROUTE, GIT_UNSTAGE_ROUTE } from '../src/contract.ts'
import { createGitFace, GitRefusal, postCommit, postPaths, readDiff, readStatus } from '../src/client/face.ts'
import { createGitStore } from '../src/client/store.ts'
import { answer, gitStatus, scriptedFetch, TEXT_DIFF } from './support.client.ts'

const TAB = 'tab-1' as TabId
const SESSION = 's-1' as never
const ENTRY = { path: 'a.txt', index: ' ', worktree: 'M' }

function setup(...responses: Array<Response | Error>) {
  const instance = createGitStore().create()
  instance.actions.start(TAB)
  const script = scriptedFetch(...responses)
  const face = createGitFace(script.fetch)(SESSION, instance.actions)
  const controller = new AbortController()
  return { instance, script, face, signal: controller.signal, controller }
}

async function settle(): Promise<void> {
  await new Promise(resolve => { setTimeout(resolve, 0) })
}

describe('git face', () => {
  it('loads the status for its Session', async () => {
    const { face, instance, script, signal } = setup(answer(gitStatus([ENTRY])))
    face.load(TAB, signal)
    await settle()
    expect(script.calls[0]?.url).toContain('sessionId=s-1')
    expect(instance.getSnapshot().byTab[TAB]?.status).toMatchObject({ kind: 'ready' })
  })

  it('publishes the Host refusal and an unreadable answer as failures', async () => {
    const refused = setup(answer({ error: 'git exploded' }, 500))
    refused.face.load(TAB, refused.signal)
    await settle()
    expect(refused.instance.getSnapshot().byTab[TAB]?.status).toEqual({ kind: 'failed', message: 'git exploded' })

    const broken = setup(answer({ nonsense: true }))
    broken.face.load(TAB, broken.signal)
    await settle()
    expect(broken.instance.getSnapshot().byTab[TAB]?.status).toMatchObject({ kind: 'failed' })

    const unreachable = setup(new Error('offline'))
    unreachable.face.load(TAB, unreachable.signal)
    await settle()
    expect(unreachable.instance.getSnapshot().byTab[TAB]?.status).toEqual({ kind: 'failed', message: 'offline' })

    const blank = setup(new Response('teapot', { status: 418 }))
    blank.face.load(TAB, blank.signal)
    await settle()
    expect(blank.instance.getSnapshot().byTab[TAB]?.status).toEqual({ kind: 'failed', message: 'HTTP 418' })
  })

  it('opens the comparison of the side the entry belongs to', async () => {
    const worktree = setup(answer(TEXT_DIFF))
    worktree.face.open(TAB, ENTRY, worktree.signal)
    await settle()
    expect(worktree.script.calls[0]?.url).toContain('side=worktree')
    expect(worktree.instance.getSnapshot().byTab[TAB]).toMatchObject({
      selection: { path: 'a.txt', side: 'worktree' },
      diff: { kind: 'ready', diff: TEXT_DIFF },
    })

    const staged = setup(answer(TEXT_DIFF))
    staged.face.open(TAB, { path: 'a.txt', index: 'M', worktree: ' ' }, staged.signal)
    await settle()
    expect(staged.script.calls[0]?.url).toContain('side=index')

    const failed = setup(answer({ error: 'gone' }, 404))
    failed.face.open(TAB, ENTRY, failed.signal)
    await settle()
    expect(failed.instance.getSnapshot().byTab[TAB]?.diff).toEqual({ kind: 'failed', message: 'gone' })
    failed.face.close(TAB)
    expect(failed.instance.getSnapshot().byTab[TAB]?.selection).toBeUndefined()
  })

  it('stages and unstages one path and publishes the resulting status', async () => {
    const instanceSetup = setup(answer(gitStatus([{ path: 'a.txt', index: 'A', worktree: ' ' }])), answer(gitStatus([ENTRY])))
    instanceSetup.face.stage(TAB, 'a.txt', instanceSetup.signal)
    await settle()
    expect(instanceSetup.script.calls[0]?.init?.body).toBe(JSON.stringify({ sessionId: 's-1', paths: ['a.txt'] }))
    expect(instanceSetup.instance.getSnapshot().byTab[TAB]?.status).toMatchObject({ kind: 'ready' })
    instanceSetup.face.unstage(TAB, 'a.txt', instanceSetup.signal)
    await settle()
    expect(instanceSetup.script.calls[1]?.url).toBe(GIT_UNSTAGE_ROUTE)
    expect(instanceSetup.instance.getSnapshot().byTab[TAB]?.status).toMatchObject({ kind: 'ready' })

    const refused = setup(answer({ error: 'index locked' }, 422))
    refused.face.stage(TAB, 'a.txt', refused.signal)
    await settle()
    expect(refused.instance.getSnapshot().byTab[TAB]?.error).toBe('index locked')
  })

  it('commits the draft, then clears the panel', async () => {
    const committed = setup(answer(gitStatus([])))
    committed.instance.actions.draft(TAB, 'fix it')
    committed.face.commit(TAB, 'fix it', committed.signal)
    expect(committed.instance.getSnapshot().byTab[TAB]?.committing).toBe(true)
    await settle()
    expect(committed.script.calls[0]?.url).toBe(GIT_COMMIT_ROUTE)
    expect(committed.instance.getSnapshot().byTab[TAB]).toMatchObject({ message: '', committing: false })

    const refused = setup(answer({ error: 'nothing to commit' }, 422))
    refused.face.commit(TAB, 'fix it', refused.signal)
    await settle()
    expect(refused.instance.getSnapshot().byTab[TAB]).toMatchObject({ committing: false, error: 'nothing to commit' })
  })

  it('drops every settlement that an abort or a newer request retired', async () => {
    const { face, instance, script, signal, controller } = setup(answer(gitStatus([ENTRY])), answer(gitStatus([])))
    face.load(TAB, signal)
    face.load(TAB, signal)
    await settle()
    expect(script.calls).toHaveLength(2)
    expect(instance.getSnapshot().byTab[TAB]?.status).toMatchObject({ kind: 'ready' })
    controller.abort()
    face.load(TAB, signal)
    face.open(TAB, ENTRY, signal)
    face.stage(TAB, 'a.txt', signal)
    face.commit(TAB, 'm', signal)
    await settle()
    expect(script.calls).toHaveLength(2)
  })

  it('refuses malformed and failing requests through the exported readers', async () => {
    const refusal = setup(answer({ error: 'bad' }, 400))
    await expect(readStatus(refusal.script.fetch, SESSION, refusal.signal)).rejects.toBeInstanceOf(GitRefusal)
    await expect(readDiff(refusal.script.fetch, SESSION, 'a.txt', 'worktree', refusal.signal)).rejects.toThrow('bad')
    await expect(postPaths(refusal.script.fetch, GIT_STAGE_ROUTE, SESSION, ['a.txt'], refusal.signal)).rejects.toThrow('bad')
    await expect(postCommit(refusal.script.fetch, SESSION, 'm', refusal.signal)).rejects.toThrow('bad')
  })
})
