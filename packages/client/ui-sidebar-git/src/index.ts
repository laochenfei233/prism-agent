/**
 * Git workbench, Host half: registers the status, comparison, stage, unstage,
 * and commit routes the right-Sidebar panel reads. The browser half ships via
 * exports["./client"], discovered through the package.json dsh.client declaration.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-client-connection'
import { GitRunner, resolveGitExecutable } from '@deepseek-ai/dsh-workspace-changes'
import { gitOperations, registerGitRoutes, type GitOperations } from './git-routes.ts'

/** Stable Loader identity. */
export const name = 'ui-sidebar-git'

/** Services the routes read: the authenticated fetch fence, Sessions, and git processes. */
export const inject = ['connection', 'sessions', 'subprocess']

/** Command and message bounds. Invalid values fail plugin load. */
export interface Config {
  /** Milliseconds one git command may run before it is terminated. */
  timeoutMs: number
  /** Bytes of git output retained per command. */
  outputMaxBytes: number
  /** Bytes a commit message may occupy, counted as UTF-8. */
  maxMessageBytes: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(30_000),
  outputMaxBytes: z.number().default(8 * 1024 * 1024),
  maxMessageBytes: z.number().default(64 * 1024),
})

/**
 * Register the workbench routes.
 * @param ctx - Host context carrying the fetch fence, Sessions, and subprocesses.
 * @param config - validated bounds.
 */
export function apply(ctx: Context, config: Config): void {
  for (const [field, value] of [
    ['timeoutMs', config.timeoutMs], ['outputMaxBytes', config.outputMaxBytes], ['maxMessageBytes', config.maxMessageBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`ui-sidebar-git requires a positive integer ${field}`)
  }
  let resolved: Promise<GitOperations | undefined> | undefined
  registerGitRoutes({
    effect: (dispose) => { ctx.effect(dispose) },
    cwdOf: (sessionId) => ctx.sessions.get(sessionId as SessionId)?.header.cwd,
    operations: (signal) => {
      // One resolution per plugin lifetime: a missing git stays missing until the plugin reloads.
      resolved ??= resolveGitExecutable(ctx, signal).then((executable) => executable === null
        ? undefined
        : gitOperations(new GitRunner(ctx.subprocess, executable, {
          timeoutMs: config.timeoutMs, outputMaxBytes: config.outputMaxBytes,
        })))
      return resolved
    },
    register: (route) => {
      ctx.connection.fetch.register({ ...route, methods: [...route.methods], requestBody: 'buffered' })
    },
  }, config)
}
