/**
 * Shared test doubles for the HachimoDock bridge tests.
 *
 * No host packages are imported here: `createFakeCtx` reproduces the small
 * structural surface `bridge.ts` uses (session/agent stores, `ctx.on`,
 * `ctx.get`, logger), so the suites run against the real transport with fake
 * host state.
 *
 * Port of upstream `integrations/dsh-hachimodock/test/helpers.js` adapted to
 * vitest cleanup and the prism bridge identity.
 */

import { BridgeServer, type BridgeServerOptions } from '../src/server.ts'
import { createBridge } from '../src/bridge.ts'
import type { BridgeContextLike, SessionLike, SessionEventLike } from '../src/types.ts'

export interface AfterRegistry {
  after(dispose: () => unknown | Promise<unknown>): void
}

const testServers = new Map<string, BridgeServer>()

function headersFor(url: string): Record<string, string> {
  const u = new URL(url)
  const server = testServers.get(u.origin)
  if (!server) return {}
  const role = u.pathname.startsWith('/approval') || u.pathname === '/events'
    ? 'relay'
    : u.pathname.startsWith('/voice') ? 'voice' : 'bus'
  return { Authorization: `Bearer ${server.tokens[role]}` }
}

/** Parse one SSE frame block (text between two blank lines). */
export function parseSseBlock(block: string): { id: string | undefined; event: string; data: unknown } | undefined {
  let id: string | undefined
  let event = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'id') id = value
    else if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }
  if (id === undefined && event === 'message' && dataLines.length === 0) return undefined
  let data: unknown
  try {
    data = dataLines.length > 0 ? JSON.parse(dataLines.join('\n')) : undefined
  } catch {
    data = dataLines.join('\n')
  }
  return { id, event, data }
}

export interface SseFrame {
  id: string | undefined
  event: string
  data: unknown
}

export interface SseReader {
  events: SseFrame[]
  next: (timeoutMs?: number) => Promise<SseFrame>
  close: () => void
  readonly closed: boolean
}

/** Consume a streaming `text/event-stream` response into sequential parsed frames. */
export function createSseReader(response: Response): SseReader {
  const events: SseFrame[] = []
  const waiters = new Set<() => void>()
  let cursor = 0
  let closed = false
  let failure: unknown

  const notify = (): void => {
    for (const waiter of [...waiters]) waiter()
  }

  const stream = response.body!.getReader()
  void (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await stream.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n\n')
        while (index >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const parsed = parseSseBlock(block)
          if (parsed) events.push(parsed)
          index = buffer.indexOf('\n\n')
        }
        notify()
      }
    } catch (error) {
      failure = error
    } finally {
      closed = true
      notify()
    }
  })()

  function next(timeoutMs = 3000): Promise<SseFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`timed out waiting for SSE frame (saw ${events.length})`))
      }, timeoutMs)
      timer.unref?.()
      const check = (): void => {
        if (cursor < events.length) {
          const frame = events[cursor]
          cursor += 1
          cleanup()
          if (frame === undefined) reject(new Error('SSE frame vanished'))
          else resolve(frame)
          return
        }
        if (closed) {
          cleanup()
          reject(failure ?? new Error('SSE stream closed before the expected frame'))
        }
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        waiters.delete(check)
      }
      waiters.add(check)
      check()
    })
  }

  return {
    events,
    next,
    close() {
      try {
        stream.cancel().catch(() => {})
      } catch {
        /* ignore */
      }
    },
    get closed() {
      return closed
    },
  }
}

/** Open an SSE endpoint (GET or POST) and return a frame reader. */
export async function openSse(url: string, options: RequestInit = {}): Promise<{
  response: Response
  next: SseReader['next']
  events: SseReader['events']
  close: () => void
}> {

  const controller = new AbortController()
  const response = await fetch(url, {
    ...options,
    headers: { accept: 'text/event-stream', ...headersFor(url), ...(options.headers as Record<string, string> | undefined) },
    signal: controller.signal,
  })
  if (response.status !== 200) {
    throw new Error(`expected 200 for ${url}, got ${response.status}: ${await response.text()}`)
  }
  const reader = createSseReader(response)
  return {
    response,
    events: reader.events,
    next: reader.next,
    close: () => {
      reader.close()
      controller.abort()
    },
  }
}

/** Read a JSON response with automatic role auth headers. */
export async function requestJson(url: string, options: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { ...options, headers: { ...headersFor(url), ...(options.headers as Record<string, string> | undefined) } })
  const text = await response.text()
  let body: unknown
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

/** POST one JSON body and return status plus parsed JSON. */
export function postJson(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const u = new URL(url)
  const server = testServers.get(u.origin)
  if (u.pathname === '/approval/decision' && server !== undefined && body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>
    const p = server.pending.get(String(record.requestId)) ?? server.resolved.get(String(record.requestId))
    if (p !== undefined) record.epoch = server.epoch, record.sessionId = p.sessionId, record.lease = p.lease
  }
  return requestJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** Wait until a predicate is satisfied (bounded polling). */
export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (!predicate()) throw new Error('waitFor timed out')
}

/** Create a fake live session with the fields the bridge reads. */
export function createFakeSession(id: string, extra: { createdAt?: number; cwd?: string; header?: Record<string, unknown> } = {}): SessionLike & { seq: number } {
  return {
    id,
    seq: 0,
    header: {
      version: 4,
      id,
      createdAt: extra.createdAt ?? Date.now(),
      isSeeded: false,
      ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
      ...(extra.header ?? {}),
    },
  } as SessionLike & { seq: number }
}

/** Mirror Session.append: assign the next seq, commit the increment, then notify. */
export function appendSessionEvent(ctx: FakeCtx, session: SessionLike & { seq: number }, event: Omit<SessionEventLike, 'seq'>): unknown[] {
  const committed = { ...event, seq: session.seq }
  session.seq += 1
  return ctx.dispatchSync('session/event', session, committed)
}

/** Skip session-summary frames and assert the next control event kind. */
export async function nextControlEvent(sse: { next: SseReader['next'] }, expected: string, sessionId: string): Promise<SseFrame> {
  for (let i = 0; i < 16; i++) {
    const frame = await sse.next()
    if (frame.event === 'session') {
      if ((frame.data as any)?.session?.id !== sessionId) throw new Error('unexpected session summary')
      continue
    }
    if (frame.event !== expected) throw new Error(`expected ${expected}, got ${frame.event}`)
    return frame
  }
  throw new Error(`no ${expected} within bounded summary window`)
}

/** Create a fake agent with the documented followup/whenIdle surface. */
export function createFakeAgent(session: SessionLike): Record<string, any> {
  const agent: Record<string, any> = {
    id: session.id,
    session,
    status: 'idle',
    followups: [],
    idle: null,
    cancelled: null,
    followup(message: unknown) {
      this.followups.push(message)
      this.status = 'running'
      this.idle = Promise.withResolvers()
    },
    cancel(cause: unknown) {
      this.cancelled = cause
      this.status = 'idle'
      if (this.idle !== null) {
        this.idle.resolve()
        this.idle = null
      }
    },
    whenIdle() {
      return this.idle === null ? Promise.resolve() : this.idle.promise
    },
    finish() {
      this.status = 'idle'
      if (this.idle !== null) {
        this.idle.resolve()
        this.idle = null
      }
    },
  }
  return agent
}

export type FakeCtx = BridgeContextLike & {
  handlers: Map<string, Array<(...args: any[]) => unknown>>
  logged: Array<[string, unknown]>
  sessions: { list: () => SessionLike[]; get: (id: string) => SessionLike | undefined }
  agents: { get: (id: string) => unknown; list: () => unknown[] }
  provide: (name: string, value: unknown) => void
  addSession: (session: SessionLike) => void
  removeSession: (id: string) => void
  addAgent: (agent: Record<string, unknown>) => void
  dispatchSync: (name: string, ...args: unknown[]) => unknown[]
  dispatch: (name: string, ...args: unknown[]) => Promise<unknown[]>
  invokeFirst: (name: string, ...args: unknown[]) => unknown
  sessionController?: unknown
}

/** Create a minimal Cordis-compatible context double. */
export function createFakeCtx(options: { sessions?: SessionLike[]; agents?: Array<Record<string, unknown>>; services?: Record<string, unknown> } = {}): FakeCtx {
  const handlers = new Map<string, Array<(...args: any[]) => unknown>>()
  const sessions = new Map<string, SessionLike>((options.sessions ?? []).map(session => [session.id, session]))
  const agents = new Map<string, Record<string, unknown>>((options.agents ?? []).map(agent => [String(agent.id), agent]))
  const services: Record<string, unknown> = { ...(options.services ?? {}) }
  const logged: Array<[string, unknown]> = []

  const ctx: FakeCtx = {
    handlers,
    logged,
    sessions: {
      list: () => [...sessions.values()],
      get: id => sessions.get(id),
    },
    agents: {
      get: id => agents.get(id),
      list: () => [...agents.values()],
    },
    get(name: string) {
      return services[name]
    },
    provide(name: string, value: unknown) {
      services[name] = value
    },
    on(name: string, listener: (...args: never[]) => unknown) {
      const list = handlers.get(name) ?? []
      list.push(listener as (...args: any[]) => unknown)
      handlers.set(name, list)
      return () => {
        const index = list.indexOf(listener as (...args: any[]) => unknown)
        if (index >= 0) list.splice(index, 1)
      }
    },
    logger: {
      info: detail => logged.push(['info', detail]),
      warn: detail => logged.push(['warn', detail]),
      error: detail => logged.push(['error', detail]),
    },
    addSession(session: SessionLike) {
      sessions.set(session.id, session)
    },
    removeSession(id: string) {
      sessions.delete(id)
    },
    addAgent(agent: Record<string, unknown>) {
      agents.set(String(agent.id), agent)
    },
    dispatchSync(name: string, ...args: unknown[]) {
      const list = [...(handlers.get(name) ?? [])]
      const results: unknown[] = []
      for (const listener of list) results.push(listener(...args))
      return results
    },
    async dispatch(name: string, ...args: unknown[]) {
      const list = [...(handlers.get(name) ?? [])]
      const results: unknown[] = []
      for (const listener of list) results.push(await listener(...args))
      return results
    },
    invokeFirst(name: string, ...args: unknown[]) {
      const list = handlers.get(name) ?? []
      const first = list[0]
      if (first === undefined) throw new Error(`no listener registered for ${name}`)
      return first(...args)
    },
  }
  return ctx
}

/** Build one fake approval request for the answerer. */
export function createApprovalRequest(session: SessionLike, extra: Record<string, unknown> = {}): any {
  return {
    agent: { id: session.id, session },
    toolName: 'bash',
    reason: 'run the test suite',
    displayReason: 'Run tests?',
    signal: new AbortController().signal,
    ...extra,
  }
}

/** Start a bare BridgeServer on an ephemeral port for transport tests. */
export async function startTestServer(t: AfterRegistry, options: Omit<BridgeServerOptions, 'port'> = {}): Promise<{ server: BridgeServer; url: string }> {
  const server = new BridgeServer({ port: 0, writeBootstrap: false, ...options })
  await server.listen(0)
  t.after(async () => {
    testServers.delete(server.url())
    await server.close()
  })
  testServers.set(server.url(), server)
  return { server, url: server.url() }
}

/** Start a full fake-host bridge on an ephemeral port for integration tests. */
export async function startTestBridge(t: AfterRegistry, ctx: FakeCtx, config: Record<string, unknown> = {}): Promise<{ bridge: ReturnType<typeof createBridge>; url: string }> {
  // Unit tests must not inherit the developer's real pet-bridge.json timeout.
  process.env.HACHIMODOCK_BRIDGE_PROFILE = '/nonexistent/hachimodock-test-profile.json'
  const bridge = createBridge(ctx, { port: 0, writeBootstrap: false, ...(config as object) })
  await bridge.server.listen(0)
  t.after(async () => {
    testServers.delete(bridge.server.url())
    await bridge.stop()
  })
  testServers.set(bridge.server.url(), bridge.server)
  return { bridge, url: bridge.server.url() }
}

/** A bare-bones in-memory POSIX fs double for capability store tests. */
export function createFakePosixFs(entries: Map<string, { directory?: boolean; data?: string; link?: boolean; mode?: number }>): {
  fs: any
  handles: Map<number, string>
} {
  const handles = new Map<number, string>()
  let fd = 0
  const stat = (p: string): any => {
    const e = entries.get(p)
    if (!e) throw Object.assign(Error('missing'), { code: 'ENOENT' })
    return {
      isSymbolicLink: () => !!e.link,
      isDirectory: () => !!e.directory,
      isFile: () => !e.directory,
      ino: 1,
      dev: 1,
      size: (e.data ?? '').length,
      mode: e.mode ?? (e.link ? 0o777 : 0o600),
      uid: 1000,
    }
  }
  const fs = {
    constants: { O_RDONLY: 0, O_NOFOLLOW: 0x20000 },
    lstatSync: stat,
    fstatSync: (n: number) => stat(handles.get(n) as string),
    openSync(p: string, _flags?: number | string) {
      if (_flags === 'wx' && entries.has(p)) throw Object.assign(Error('exists'), { code: 'EEXIST' })
      if (_flags === 'wx') entries.set(p, { data: '' })
      handles.set(++fd, p)
      return fd
    },
    readFileSync(p: string | number, _encoding?: string) {
      const key = typeof p === 'number' ? handles.get(p) : p
      const e = entries.get(key as string)
      if (!e) throw Object.assign(Error('missing'), { code: 'ENOENT' })
      return Buffer.from(e.data ?? '')
    },
    writeFileSync(n: number, data: Buffer | string) {
      const p = handles.get(n) as string
      const e = entries.get(p)
      if (!e) throw Object.assign(Error('missing'), { code: 'ENOENT' })
      e.data = String(data)
    },
    fsyncSync() {},
    closeSync(n: number) {
      handles.delete(n)
    },
    renameSync(a: string, b: string) {
      const e = entries.get(a)
      if (!e) throw Object.assign(Error('missing'), { code: 'ENOENT' })
      entries.set(b, e)
      entries.delete(a)
    },
    unlinkSync(p: string) {
      entries.delete(p)
    },
    mkdirSync(p: string, _opts?: unknown) {
      entries.set(p, { directory: true })
    },
  }
  return { fs, handles }
}
