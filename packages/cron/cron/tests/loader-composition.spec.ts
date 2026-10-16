/**
 * REAL-composition proof for cron delivery: the shipped plugin rows boot through
 * the vendored Loader, and fired jobs create their declared Session, deliver the
 * framed task into it, and resume a cold target Session.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import TimerService from '@deepseek-ai/cordis-plugin-timer'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import * as cron from '@deepseek-ai/dsh-cron'
import { LEADER_LOCK_FILENAME, renderCronTaskFraming } from '@deepseek-ai/dsh-cron'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import * as storageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

/** Keyless adapter: records every request and answers one plain assistant message. */
class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'task acknowledged' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'task acknowledged' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** The storage and lock paths one composition shares. */
interface CompositionPaths {
  readonly sessions: string
  readonly storage: string
  readonly lock: string
}

/**
 * Supply only the module import the rows exercise; every other Loader internal
 * fails if this composition reaches it.
 * @param importModule - the specifier-to-module mapping the rows resolve through.
 * @returns the Loader's internal module loader.
 */
function modulesLoader(importModule: (specifier: string) => Promise<unknown>): ModuleLoaderV2 {
  return {
    version: 'v2',
    import: importModule,
    loadCache: new Map(),
    register(): never { throw new Error('cron delivery tests do not register module hooks') },
    getOrCreateModuleJob(): never { throw new Error('cron delivery tests do not create module jobs') },
    resolveSync(): never { throw new Error('cron delivery tests do not resolve modules synchronously') },
    load(): never { throw new Error('cron delivery tests do not load modules') },
  }
}

/**
 * The shipped rows the cron capability needs, as one `cordis.yml`.
 * @param paths - the session, storage, and lock paths this composition uses.
 * @returns the file's lines.
 */
function rows(paths: CompositionPaths): string[] {
  return [
    "- name: '@deepseek-ai/cordis-plugin-timer'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(paths.sessions)}`,
    '    compression: none',
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(paths.storage)}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-agent-preset-registry'",
    '  config:',
    '    default: plain',
    "- name: '@deepseek-ai/dsh-permission-presets'",
    "- name: '@deepseek-ai/dsh-cron'",
    '  config:',
    `    leaderLockPath: ${JSON.stringify(paths.lock)}`,
    '',
  ]
}

/**
 * Boot the rows through the vendored Loader.
 * @param root - the directory the composition's `cordis.yml` lives in.
 * @param paths - the session, storage, and lock paths the rows name.
 * @returns the settled context.
 */
async function compose(root: string, paths: CompositionPaths): Promise<Context> {
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, rows(paths).join('\n'))
  const ctx = new Context()
  contexts.push(ctx)
  // The shell executor and approval policy are the two nondeterministic
  // boundaries a delivery never touches: this composition needs their services
  // only so the permission table can be mounted.
  ctx.provide('shell', {
    sandboxMode: 'workspace-write',
    resolve() { throw new Error('cron delivery tests do not execute shell commands') },
    run() { throw new Error('cron delivery tests do not execute shell commands') },
    start() { throw new Error('cron delivery tests do not execute shell commands') },
  })
  ctx.provide('approval', { config: { policy: 'ask' } })
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/cordis-plugin-timer', TimerService],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', storageJson],
    ['@deepseek-ai/dsh-storage-domain', storageDomain],
    ['@deepseek-ai/dsh-agent-preset-registry', AgentPresetRegistry],
    ['@deepseek-ai/dsh-permission-presets', PermissionPresetService],
    ['@deepseek-ai/dsh-cron', cron],
  ])
  ctx.loader.internal = modulesLoader(async (specifier: string) => {
    if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
    return modules.get(specifier)
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('real Loader composition', () => {
  it('creates the declared Session, delivers the framed task, and resumes a cold target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cron-loader-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
    const paths: CompositionPaths = {
      sessions: join(root, 'sessions'),
      storage: join(root, 'storage'),
      lock: join(root, 'storage', LEADER_LOCK_FILENAME),
    }
    const ctx = await compose(root, paths)
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const adapter = new RecordingAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    await ctx.agentPresets.register({ id: 'plain', plugins: [] })

    // A `new-session` job states its route, so the created Session runs it.
    const withModel = await ctx.cron.create({
      expression: '*/5 * * * *',
      timeZone: 'UTC',
      target: {
        kind: 'new-session',
        workspacePath: workspace,
        agentPreset: 'plain',
        permissionPreset: 'workspace-write',
        model: { provider: 'mock', model: 'mock' },
      },
      prompt: 'summarize the build',
    })
    await expect(ctx.cron.runNow(withModel.id)).resolves.toMatchObject({ outcome: 'completed' })

    const created = ctx.sessions.list().find(session => session.id === ctx.agents.list()[0]?.id)
    expect(created?.id).toMatch(/^cron-[0-9a-f-]{36}$/)
    expect(created?.header.cwd).toBe(workspace)
    expect(created?.snapshotEvents().find(event => event.type === 'permission/preset')?.data)
      .toEqual({ preset: 'workspace-write' })

    const delivered = created?.deriveMessages().find(message => message.source.kind === 'cron')
    expect(delivered?.content).toEqual([{ type: 'text', text: renderCronTaskFraming(withModel) }])
    const createdAgent = created === undefined ? undefined : ctx.agents.get(created.id)
    await createdAgent?.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.messages.at(-1)?.content)
      .toEqual([{ type: 'text', text: renderCronTaskFraming(withModel) }])

    // A `new-session` job that states no route keeps the deployment's own.
    const withoutModel = await ctx.cron.create({
      expression: '*/5 * * * *',
      timeZone: 'UTC',
      target: {
        kind: 'new-session',
        workspacePath: workspace,
        agentPreset: 'plain',
        permissionPreset: 'workspace-write',
      },
      prompt: 'check the report',
    })
    await expect(ctx.cron.runNow(withoutModel.id)).resolves.toMatchObject({ outcome: 'completed' })

    // A Session that cannot take the preset its job declared is not the Session
    // the job asked for: the run fails and the created Session is rolled back.
    const refusedPreset = await ctx.cron.create({
      expression: '*/5 * * * *',
      timeZone: 'UTC',
      target: {
        kind: 'new-session',
        workspacePath: workspace,
        agentPreset: 'plain',
        permissionPreset: 'not-a-preset',
        model: { provider: 'mock', model: 'mock' },
      },
      prompt: 'never delivered',
    })
    await expect(ctx.cron.runNow(refusedPreset.id)).resolves.toMatchObject({ outcome: 'failed' })
    expect(ctx.agents.list().map(agent => agent.id).filter(id => id.startsWith('cron-'))).toHaveLength(2)

    // A Session this composition created and then released is cold for the next
    // job, which resumes it instead of delivering into a live Agent.
    const coldId = SessionId('cron-cold-target')
    const coldHandle = await ctx.agents.create({
      sessionId: coldId,
      meta: { cwd: workspace },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await coldHandle.dispose()
    expect(ctx.agents.get(coldId)).toBeUndefined()

    const resumedJob = await ctx.cron.create({
      expression: '*/5 * * * *',
      timeZone: 'UTC',
      target: { kind: 'session', sessionId: coldId },
      prompt: 'continue the report',
    })
    await expect(ctx.cron.runNow(resumedJob.id)).resolves.toMatchObject({ outcome: 'completed' })

    const resumed = ctx.agents.get(coldId)
    await resumed?.whenIdle()
    // The resumed Agent is composed from the deployment's own route, so this
    // composition proves admission: the framed task reached the cold Session's
    // durable log with Cron's declared source.
    const admitted = resumed?.session.snapshotEvents()
      .filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data.inserted)
      .filter(message => message.source.kind === 'cron')
    expect(admitted?.at(0)?.source).toEqual({ kind: 'cron', jobId: resumedJob.id })
    expect(admitted?.at(0)?.content).toEqual([{ type: 'text', text: renderCronTaskFraming(resumedJob) }])

    // The Session that resume published is live now, so the next job of the same
    // target delivers straight into its Agent instead of resuming it again.
    const liveJob = await ctx.cron.create({
      expression: '*/5 * * * *',
      timeZone: 'UTC',
      target: { kind: 'session', sessionId: coldId },
      prompt: 'report the result',
    })
    await expect(ctx.cron.runNow(liveJob.id)).resolves.toMatchObject({ outcome: 'completed' })

    const deliveredLive = ctx.agents.get(coldId)?.session.snapshotEvents()
      .filter(event => event.type === 'agent/inbox/spliced')
      .flatMap(event => event.data.inserted)
      .filter(message => message.source.kind === 'cron')
    expect(deliveredLive?.map(message => message.source))
      .toEqual([{ kind: 'cron', jobId: resumedJob.id }, { kind: 'cron', jobId: liveJob.id }])
  })
})
