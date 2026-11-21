/**
 * Data settings, Host half: one POST route behind the 数据 settings page. The
 * page reads where the harness home is, moves it to another directory, and
 * clears that choice again. A relocation copies the home and records the
 * destination in the launch pointer; the next launch resolves the home from
 * that pointer, because every service here captures the home at construction.
 *
 * Nothing here is model-visible: no prompt, tool, or session event is
 * registered.
 *
 * @module @prism/prism-data
 */

import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  clearDataHomePointer, dataHomePointerPath, readDataHomePointer, resolveDshHome, writeDataHomePointer,
} from '@deepseek-ai/dsh-home-paths'
import { DataError, messageOf, statusOf } from './errors.ts'
import { copyHome, discardPartialCopy, prepareTarget, resolveTarget } from './relocate.ts'
import { DATA_ROUTE_PATH } from './routes.ts'
import type { DataFailure, DataLocationState, DataRequest, DataResponse, RelocationResult } from './types.ts'

export { DataError, statusOf } from './errors.ts'
export { DATA_ROUTE_PATH } from './routes.ts'
export type * from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'prism-data'

/** Services this plugin requires: the API route carrier. */
export const inject = ['connection']

/** The running home plus the directory holding the launch pointer. */
export interface DataRouteDeps {
  /** Absolute harness home this process runs from. */
  readonly root: string
  /** Operating-system home directory holding the launch pointer; omitted uses the OS home. */
  readonly osHome?: string | undefined
}

/**
 * Read the current location and the choice a fresh launch would follow.
 * @param deps - the running home and the pointer's directory.
 * @returns the root, the pointer path, and the recorded or pending home.
 */
export function stateOf(deps: DataRouteDeps): DataLocationState {
  const stored = readDataHomePointer(deps.osHome)
  const state: DataLocationState = {
    root: deps.root,
    pointerPath: dataHomePointerPath(deps.osHome),
    ...stored === undefined ? {} : { storedRoot: stored },
  }
  return stored !== undefined && stored !== deps.root ? { ...state, pendingRoot: stored } : state
}

/**
 * Copy the home to `requested` and record it as the next launch's home.
 *
 * A failed copy removes its partial destination and reports `copy-failed`; a
 * failed pointer write leaves the copy in place and reports `pointer-failed`,
 * because the copied tree is still usable.
 * @param deps - the running home and the pointer's directory.
 * @param requested - destination as the operator supplied it.
 * @param copy - copier; omitted walks the home.
 * @returns the destination, the source, and the copy counts.
 * @throws {DataError} with the code naming the refused step.
 */
export async function relocate(
  deps: DataRouteDeps,
  requested: string,
  copy: (source: string, target: string) => Promise<{ files: number; bytes: number; skippedLinks: readonly string[] }> = copyHome,
): Promise<RelocationResult> {
  const target = resolveTarget(deps.root, requested)
  await prepareTarget(target)
  let report
  try {
    report = await copy(deps.root, target)
  } catch (error: unknown) {
    await discardPartialCopy(target)
    throw new DataError('prism-data/copy-failed', `Could not copy ${deps.root} to ${target}: ${messageOf(error)}`)
  }
  try {
    writeDataHomePointer(target, deps.osHome)
  } catch (error: unknown) {
    throw new DataError(
      'prism-data/pointer-failed',
      `The data was copied to ${target}, but the location could not be recorded: ${messageOf(error)}`,
    )
  }
  return {
    target,
    previousRoot: deps.root,
    files: report.files,
    bytes: report.bytes,
    skippedLinks: report.skippedLinks,
  }
}

/**
 * Answer one call with a JSON body and the status its code implies.
 * @param body - success or failure envelope.
 * @param status - HTTP status.
 * @returns the response.
 */
function jsonResponse(body: DataResponse<unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * Parse one request body into a known action.
 * @param request - the POST request.
 * @returns the action and its argument.
 * @throws {DataError} `bad-request` for a body this route does not serve.
 */
async function requestOf(request: Request): Promise<DataRequest> {
  let body: unknown
  try {
    body = await request.json()
  } catch (_notJson) {
    throw new DataError('prism-data/bad-request', 'The request body is not JSON.')
  }
  if (typeof body !== 'object' || body === null) {
    throw new DataError('prism-data/bad-request', 'The request body must be a JSON object.')
  }
  const action = (body as { readonly action?: unknown }).action
  if (action === 'state' || action === 'reset') return { action }
  if (action === 'relocate') {
    const target = (body as { readonly target?: unknown }).target
    if (typeof target !== 'string' || target.trim() === '') {
      throw new DataError('prism-data/bad-request', 'The relocate action needs a target path.')
    }
    return { action, target }
  }
  throw new DataError('prism-data/bad-request', 'The request action must be "state", "relocate", or "reset".')
}

/**
 * Build the POST handler behind the settings page.
 * @param deps - the running home and the pointer's directory.
 * @returns the Fetch-shaped handler `ctx.connection.fetch.register` accepts.
 */
export function createDataRoute(deps: DataRouteDeps): ConnectionFetchRoute['fetch'] {
  let relocating: Promise<RelocationResult> | undefined
  return async (request) => {
    try {
      const call = await requestOf(request)
      if (call.action === 'state') return jsonResponse({ ok: true, value: stateOf(deps) }, 200)
      if (relocating !== undefined) throw new DataError('prism-data/busy', 'A relocation is already running.')
      if (call.action === 'reset') {
        clearDataHomePointer(deps.osHome)
        return jsonResponse({ ok: true, value: stateOf(deps) }, 200)
      }
      relocating = relocate(deps, call.target)
      try {
        return jsonResponse({ ok: true, value: await relocating }, 200)
      } finally {
        relocating = undefined
      }
    } catch (error: unknown) {
      /* v8 ignore next 3 -- every refusal this route raises is a DataError; the other arm guards a future throwing call */
      const failure = error instanceof DataError
        ? error
        : new DataError('prism-data/bad-request', messageOf(error))
      const body: DataFailure = { ok: false, error: { code: failure.code, message: failure.message } }
      return jsonResponse(body, statusOf(failure.code))
    }
  }
}


/**
 * Mount the data settings route.
 * @param ctx - Host context carrying the route carrier.
 */
export function apply(ctx: Context): void {
  const deps: DataRouteDeps = {
    root: ctx.get('profileContext')?.home ?? resolveDshHome(),
    osHome: homedir(),
  }
  const route: ConnectionFetchRoute = {
    path: DATA_ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: createDataRoute(deps),
  }
  ctx.effect(() => ctx.connection.fetch.register(route), 'prism-data: settings route')
}
