// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
/**
 * The Git workbench's Host routes, inside Connection's authentication fence:
 * one Session's repository status, one file's comparison, and the three index
 * mutations.
 *
 * Every route resolves the Session's working directory on the Host and never
 * trusts a client-supplied path: a path is normalized against the located
 * repository root before a command sees it. A failed git command answers 422
 * with its stderr tail, so the panel can show what git refused and why.
 */
import type { ConnectionFetchMethod } from '@deepseek-ai/dsh-client-connection'
import type { GitRunner } from '@deepseek-ai/dsh-workspace-changes'
import {
  GIT_COMMIT_PATH, GIT_DIFF_PATH, GIT_STAGE_PATH, GIT_STATUS_PATH, GIT_UNSTAGE_PATH,
  type GitDiff, type GitSide, type GitStatus,
} from './contract.ts'
import {
  commitStaged, GitCommandError, locateRepository, readFileDiff, readRepositoryStatus, repositoryPath,
  stagePaths, unstagePaths, type RepositoryStatus,
} from './git-command.ts'

/** Bounds the routes apply to git commands and to the commit message. */
export interface GitRoutesConfig {
  /** Milliseconds one git command may run before it is terminated. */
  timeoutMs: number
  /** Bytes of git output retained per command. */
  outputMaxBytes: number
  /** Bytes a commit message may occupy, counted as UTF-8. */
  maxMessageBytes: number
}

/** The git operations one route needs, bound to a resolved executable. */
export interface GitOperations {
  locate(cwd: string, signal: AbortSignal): Promise<string | null>
  status(root: string, signal: AbortSignal): Promise<RepositoryStatus>
  diff(root: string, path: string, side: GitSide, signal: AbortSignal): Promise<GitDiff>
  stage(root: string, paths: readonly string[], signal: AbortSignal): Promise<void>
  unstage(root: string, paths: readonly string[], signal: AbortSignal): Promise<void>
  commit(root: string, message: string, signal: AbortSignal): Promise<void>
}

/**
 * Bind the operations to one resolved runner.
 * @param git - the runner every command goes through.
 * @returns the operations the routes call.
 */
export function gitOperations(git: GitRunner): GitOperations {
  return {
    locate: (cwd, signal) => locateRepository(git, cwd, signal),
    status: (root, signal) => readRepositoryStatus(git, root, signal),
    diff: (root, path, side, signal) => readFileDiff(git, root, path, side, signal),
    stage: (root, paths, signal) => stagePaths(git, root, paths, signal),
    unstage: (root, paths, signal) => unstagePaths(git, root, paths, signal),
    commit: (root, message, signal) => commitStaged(git, root, message, signal),
  }
}

/** What the handlers read from the Host. */
export interface GitRouteDeps {
  /**
   * Resolve the working directory of a Session.
   * @param sessionId - the id from the request.
   * @returns the absolute directory, or undefined when no such Session is live.
   */
  cwdOf(sessionId: string): string | undefined
  /**
   * Resolve this Host's git operations.
   * @returns the operations, or undefined when no git executable resolved.
   */
  operations(): Promise<GitOperations | undefined>
}

const NO_STORE = { 'cache-control': 'no-store' } as const

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: NO_STORE })
}

function unavailable(): GitStatus {
  return { available: false, repo: false, entries: [] }
}

/**
 * Read one Session's status, or the empty status an absent repository or git yields.
 * @param deps - Session lookup and git operations.
 * @param cwd - the Session's working directory.
 * @param signal - request lifetime.
 * @returns the status the panel draws.
 */
async function statusFor(deps: GitRouteDeps, cwd: string, signal: AbortSignal): Promise<GitStatus> {
  const operations = await deps.operations()
  if (operations === undefined) return unavailable()
  const root = await operations.locate(cwd, signal)
  if (root === null) return { available: true, repo: false, entries: [] }
  return { available: true, repo: true, root, ...await operations.status(root, signal) }
}

/**
 * Answer a resolved status.
 * @param deps - Session lookup and git operations.
 * @param sessionId - the Session the panel belongs to.
 * @param signal - request lifetime.
 * @returns the status response.
 */
async function statusResponse(deps: GitRouteDeps, sessionId: string, signal: AbortSignal): Promise<Response> {
  const cwd = deps.cwdOf(sessionId)
  if (cwd === undefined) return new Response('Session not found.', { status: 404 })
  return json(await statusFor(deps, cwd, signal))
}

/**
 * Interpret a repository-relative path or answer with the refusal.
 * @param root - repository top-level directory.
 * @param path - the path as received.
 * @returns the path to use, or the response to answer with.
 */
function checkedPath(root: string, path: string): string | Response {
  const normalized = repositoryPath(root, path)
  return normalized ?? new Response('Path is outside the repository.', { status: 400 })
}

/**
 * Answer one Session's repository status.
 * @param deps - Session lookup and git operations.
 * @param request - the authenticated request.
 * @returns the status response.
 */
export async function handleStatus(deps: GitRouteDeps, request: Request): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') return new Response('Missing sessionId.', { status: 400 })
  return statusResponse(deps, sessionId, request.signal)
}

/**
 * Answer one file's comparison against the index or the work tree.
 * @param deps - Session lookup and git operations.
 * @param request - the authenticated request.
 * @returns the comparison response.
 */
export async function handleDiff(deps: GitRouteDeps, request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams
  const sessionId = query.get('sessionId')
  const path = query.get('path')
  const side = query.get('side')
  if (sessionId === null || sessionId === '' || path === null || (side !== 'index' && side !== 'worktree')) {
    return new Response('Invalid comparison coordinates.', { status: 400 })
  }
  const cwd = deps.cwdOf(sessionId)
  if (cwd === undefined) return new Response('Session not found.', { status: 404 })
  const operations = await deps.operations()
  if (operations === undefined) return new Response('Git is unavailable on this Host.', { status: 409 })
  const root = await operations.locate(cwd, request.signal)
  if (root === null) return new Response('The working directory is not a git repository.', { status: 404 })
  const checked = checkedPath(root, path)
  if (checked instanceof Response) return checked
  return json(await operations.diff(root, checked, side, request.signal))
}

/**
 * Read one JSON body.
 * @param request - the authenticated request.
 * @returns the decoded record, or the refusal.
 */
async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const value: unknown = await request.json()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return new Response('Expected a JSON object.', { status: 400 })
    }
    return value as Record<string, unknown>
  } catch {
    return new Response('Expected a JSON object.', { status: 400 })
  }
}

/**
 * Read the paths of a stage or unstage request.
 * @param body - the decoded record.
 * @returns the session and its paths, or the refusal.
 */
function readPathBody(body: Record<string, unknown>): { sessionId: string; paths: string[] } | Response {
  const { sessionId, paths } = body
  if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(paths)
    || paths.length === 0 || !paths.every(path => typeof path === 'string' && path.length > 0)) {
    return new Response('Expected a sessionId and a non-empty path list.', { status: 400 })
  }
  return { sessionId, paths }
}

/**
 * Run one index mutation and answer the status it leaves behind.
 * @param deps - Session lookup and git operations.
 * @param request - the authenticated request.
 * @param body - the decoded path body.
 * @param run - the mutation to run against the repository root.
 * @returns the status response after the mutation.
 */
async function mutate(
  deps: GitRouteDeps,
  request: Request,
  body: { sessionId: string; paths: readonly string[] },
  run: (operations: GitOperations, root: string, checked: readonly string[], signal: AbortSignal) => Promise<void>,
): Promise<Response> {
  const cwd = deps.cwdOf(body.sessionId)
  if (cwd === undefined) return new Response('Session not found.', { status: 404 })
  const operations = await deps.operations()
  if (operations === undefined) return new Response('Git is unavailable on this Host.', { status: 409 })
  const root = await operations.locate(cwd, request.signal)
  if (root === null) return new Response('The working directory is not a git repository.', { status: 404 })
  const checked: string[] = []
  for (const path of body.paths) {
    const normalized = checkedPath(root, path)
    if (normalized instanceof Response) return normalized
    checked.push(normalized)
  }
  await run(operations, root, checked, request.signal)
  return statusResponse(deps, body.sessionId, request.signal)
}

/**
 * Stage the paths of one Session.
 * @param deps - Session lookup and git operations.
 * @param request - the authenticated request.
 * @returns the status after staging.
 */
export async function handleStage(deps: GitRouteDeps, request: Request): Promise<Response> {
  const raw = await readBody(request)
  if (raw instanceof Response) return raw
  const body = readPathBody(raw)
  if (body instanceof Response) return body
  return mutate(deps, request, body, (operations, root, checked, signal) => operations.stage(root, checked, signal))
}

/**
 * Unstage the paths of one Session.
 * @param deps - Session lookup and git operations.
 * @param request - the authenticated request.
 * @returns the status after unstaging.
 */
export async function handleUnstage(deps: GitRouteDeps, request: Request): Promise<Response> {
  const raw = await readBody(request)
  if (raw instanceof Response) return raw
  const body = readPathBody(raw)
  if (body instanceof Response) return body
  return mutate(deps, request, body, (operations, root, checked, signal) => operations.unstage(root, checked, signal))
}

/**
 * Commit the staged content of one Session.
 * @param deps - Session lookup and git operations.
 * @param request - the authenticated request.
 * @param maxMessageBytes - the message ceiling this Host enforces.
 * @returns the status after the commit, or the refusal that kept it from happening.
 */
export async function handleCommit(deps: GitRouteDeps, request: Request, maxMessageBytes: number): Promise<Response> {
  const body = await readBody(request)
  if (body instanceof Response) return body
  const { sessionId, message } = body
  if (typeof sessionId !== 'string' || sessionId === '' || typeof message !== 'string' || message.trim() === '') {
    return new Response('Expected a sessionId and a commit message.', { status: 400 })
  }
  if (Buffer.byteLength(message, 'utf8') > maxMessageBytes) {
    return new Response('The commit message is too large.', { status: 413 })
  }
  const cwd = deps.cwdOf(sessionId)
  if (cwd === undefined) return new Response('Session not found.', { status: 404 })
  const operations = await deps.operations()
  if (operations === undefined) return new Response('Git is unavailable on this Host.', { status: 409 })
  const root = await operations.locate(cwd, request.signal)
  if (root === null) return new Response('The working directory is not a git repository.', { status: 404 })
  await operations.commit(root, message, request.signal)
  return statusResponse(deps, sessionId, request.signal)
}

/**
 * Answer a handler's failure in the form the panel shows.
 * @param error - the thrown value.
 * @returns the 422 a git refusal yields, or the 500 any other failure yields.
 */
export function failure(error: unknown): Response {
  if (error instanceof GitCommandError) return json({ error: error.message }, 422)
  return json({ error: error instanceof Error ? error.message : 'Git request failed.' }, 500)
}

/** One route this plugin adds to the Connection fetch fence. */
export interface GitRouteRegistration {
  /** Absolute route path the shell serves. */
  path: string
  /** Methods the route answers. */
  methods: readonly ConnectionFetchMethod[]
  /** Handler for one authenticated request. */
  fetch: (request: Request) => Promise<Response>
}

/** What the registration needs from its Host, kept narrow so a test can supply it without a Cordis context. */
export interface GitRouteHost {
  /**
   * Register one owned effect.
   * @param dispose - the teardown to run when the plugin unloads.
   */
  effect(dispose: () => () => Promise<void>): void
  /**
   * Answer whether a Session is live and where it works.
   * @param sessionId - the id from a request.
   * @returns its working directory, or undefined when no such Session is live.
   */
  cwdOf(sessionId: string): string | undefined
  /**
   * Resolve this Host's git operations.
   * @param signal - plugin lifetime.
   * @returns the operations, or undefined when no git executable resolved.
   */
  operations(signal: AbortSignal): Promise<GitOperations | undefined>
  /**
   * Add one route.
   * @param route - the route to serve.
   */
  register(route: GitRouteRegistration): void
}

/**
 * Register the five routes and own their lifetime.
 * @param host - Connection fence, Session lookup, git operations, and effect lifetime.
 * @param config - command and message bounds.
 */
export function registerGitRoutes(host: GitRouteHost, config: GitRoutesConfig): void {
  const lifetime = new AbortController()
  const pending = new Set<Promise<Response>>()
  host.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled(pending)
  })
  const deps: GitRouteDeps = {
    cwdOf: (sessionId) => host.cwdOf(sessionId),
    operations: () => host.operations(lifetime.signal),
  }
  const routes: readonly [string, readonly ConnectionFetchMethod[], (request: Request) => Promise<Response>][] = [
    [GIT_STATUS_PATH, ['GET'], (request) => handleStatus(deps, request).catch(error => failure(error))],
    [GIT_DIFF_PATH, ['GET'], (request) => handleDiff(deps, request).catch(error => failure(error))],
    [GIT_STAGE_PATH, ['POST'], (request) => handleStage(deps, request).catch(error => failure(error))],
    [GIT_UNSTAGE_PATH, ['POST'], (request) => handleUnstage(deps, request).catch(error => failure(error))],
    [GIT_COMMIT_PATH, ['POST'], (request) => handleCommit(deps, request, config.maxMessageBytes).catch(error => failure(error))],
  ]
  for (const [path, methods, handler] of routes) {
    host.register({
      path,
      methods,
      fetch: (request) => {
        const task = handler(new Request(request, {
          signal: AbortSignal.any([request.signal, lifetime.signal]),
        }))
        pending.add(task)
        // Every handler ends in a catch, so a route task settles by resolving; teardown awaits allSettled regardless.
        void task.then(() => { pending.delete(task) })
        return task
      },
    })
  }
}
