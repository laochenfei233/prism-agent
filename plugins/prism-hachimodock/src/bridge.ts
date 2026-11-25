/**
 * Host boundary for the HachimoDock <-> Prism bridge. Only exact
 * SessionController admission/cancel and a single approval answerer live
 * here; every wire concern is `server.ts`, every state rule is
 * `state-contract.ts`.
 *
 * Port of upstream `integrations/dsh-hachimodock/dsh-bridge.js` with the
 * prism agent identity and the activation hub wiring.
 *
 * @module @prism/prism-hachimodock/bridge
 */

import fs from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { boundString, BridgeServer } from './server.ts'
import { createStateContract } from './state-contract.ts'
import { descriptorPath } from './capability.ts'
import type { ActivationHub } from './activation.ts'
import type {
  BridgeContextLike,
  BridgeOptions,
  LoggerLike,
  ProjectionsLike,
  SessionEventLike,
  SessionLike,
  SessionSummary,
  TitleReaderLike,
} from './types.ts'

/** Bounded cache for ids observed on live session events. */
const CACHE_LIMIT = 256
/** Default bound on one injected prompt before reporting `inject-timeout`. */
const DEFAULT_INJECT_TIMEOUT_MS = 10 * 60 * 1000
/** Sentinel timeout meaning "wait forever". */
const NEVER_APPROVAL_TIMEOUT_MS = 99999

/** Agent identity reported to HachimoDock. */
export const AGENT_ID = 'prism-agent'
/** Plugin display name registered with Cordis. */
export const PLUGIN_NAME = 'hachimodock-prism-bridge'
/** Required Cordis services: the plugin waits for them before mounting. */
export const INJECT = ['sessions', 'agents', 'sessionController']

/** Default prompt text characters mirrored to `/inject` token events. */
const MAX_INJECT_TOKEN_CHARS = 256 * 1024

/** Raw plugin config before normalization. */
export interface BridgeConfig {
  readonly port?: number
  readonly approvalTimeoutMs?: number
  readonly approvalFallback?: string
  readonly injectTimeoutMs?: number
  readonly allowedOrigins?: readonly string[]
  readonly descriptorPath?: string
  readonly writeBootstrap?: boolean
}

/**
 * Merge resolved config into bridge options; the schemastery Config already
 * enforced shapes, here only cross-field defaults apply.
 */
export function normalizeOptions(config: BridgeConfig = {}): BridgeOptions {
  const options = config !== null && typeof config === 'object' ? config : {}
  const configuredPort = options.port
  const port = typeof configuredPort === 'number' && Number.isSafeInteger(configuredPort) && configuredPort > 0 ? configuredPort : 0
  const configuredTimeout = options.approvalTimeoutMs
  const approvalTimeoutMs = typeof configuredTimeout === 'number' && Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 30000
  const fallback = typeof options.approvalFallback === 'string' ? options.approvalFallback : 'unavailable'
  const configuredInjectTimeout = options.injectTimeoutMs
  const injectTimeoutMs = typeof configuredInjectTimeout === 'number' && Number.isSafeInteger(configuredInjectTimeout) && configuredInjectTimeout > 0
    ? configuredInjectTimeout
    : DEFAULT_INJECT_TIMEOUT_MS
  return {
    port,
    approvalTimeoutMs,
    approvalFallback: fallback === 'delegate' ? 'delegate' : 'unavailable',
    injectTimeoutMs,
    maxInjectTokenChars: MAX_INJECT_TOKEN_CHARS,
    allowedOrigins: options.allowedOrigins ?? [],
    bootstrapFile: options.descriptorPath ?? descriptorPath(),
    writeBootstrap: options.writeBootstrap !== false,
  }
}

/** Read the host services the bridge consumes, structurally like `prism-pocket`. */
export function hostBridgeContext(ctx: object): BridgeContextLike {
  const read = (name: string): unknown => Reflect.get(ctx, name)
  const service = (name: string): unknown => {
    const value = read(name)
    return value !== null && typeof value === 'object' ? value : undefined
  }
  const fn = (name: string): unknown => {
    const value = read(name)
    return typeof value === 'function' ? value : undefined
  }
  return {
    sessions: service('sessions') as BridgeContextLike['sessions'],
    agents: service('agents') as BridgeContextLike['agents'],
    sessionController: service('sessionController') as BridgeContextLike['sessionController'],
    logger: service('logger') as BridgeContextLike['logger'],
    on: fn('on') as BridgeContextLike['on'],
    get: fn('get') as BridgeContextLike['get'],
  }
}

/** Build a logger that never lets a logging failure break the bridge. */
export function safeLogger(ctx: BridgeContextLike): Required<LoggerLike> {
  const log = (level: 'info' | 'warn' | 'error', detail: unknown): void => {
    try {
      const logger = ctx.logger
      if (!logger) return
      if (typeof logger[level] === 'function') logger[level](detail)
    } catch {
      /* ignore logging failures */
    }
  }
  return {
    info: detail => log('info', detail),
    warn: detail => log('warn', detail),
    error: detail => log('error', detail),
  }
}

/** Remember one bounded key/value pair, evicting the oldest entry. */
function remember(map: Map<string, unknown>, key: unknown, value: unknown): void {
  if (typeof key !== 'string' || key === '') return
  if (map.has(key)) map.delete(key)
  map.set(key, value)
  if (map.size > CACHE_LIMIT) {
    const oldest = map.keys().next()
    if (!oldest.done) map.delete(oldest.value)
  }
}

/** Read a live session by id through the session store. */
function getLiveSession(ctx: BridgeContextLike, sessionId: string): SessionLike | undefined {
  try {
    const sessions = ctx.sessions
    if (sessions && typeof sessions.get === 'function') return sessions.get(sessionId)
  } catch {
    /* fall through */
  }
  return undefined
}

/** Read the full live session list in store order. */
function getLiveSessions(ctx: BridgeContextLike): SessionLike[] {
  try {
    const sessions = ctx.sessions
    if (sessions && typeof sessions.list === 'function') {
      const list = sessions.list()
      if (Array.isArray(list)) return list.filter((session): session is SessionLike => session !== null && typeof session === 'object' && typeof session.id === 'string')
    }
  } catch {
    /* fall through */
  }
  return []
}

/**
 * Resolve the session a prompt should target. An explicit live session id is
 * required; auto/newest fallback is forbidden.
 */
export function resolveTargetSession(bridge: Bridge, sessionId: unknown): SessionLike | undefined {
  if (typeof sessionId !== 'string' || !sessionId || sessionId === 'auto') return undefined
  return getLiveSession(bridge.ctx, sessionId)
}

/** Read the current title of a session from the optional host projections. */
function titleOf(bridge: Bridge, session: SessionLike): string | null {
  const tracked = bridge.titleMap.get(session.id)
  if (typeof tracked === 'string') return boundString(tracked, 160) ?? null
  try {
    const sessionTitle = bridge.ctx.get?.('sessionTitle') as TitleReaderLike | undefined
    if (sessionTitle && typeof sessionTitle.get === 'function') {
      const snapshot = sessionTitle.get(session)
      if (snapshot && typeof snapshot.title === 'string') return boundString(snapshot.title, 160) ?? null
    }
  } catch {
    /* projection unavailable or session not live */
  }
  try {
    const projections = bridge.ctx.get?.('sessionProjections') as ProjectionsLike | undefined
    if (projections && typeof projections.stateOf === 'function') {
      const state = projections.stateOf(session, 'title')
      if (typeof state === 'string') return boundString(state, 160) ?? null
    }
  } catch {
    /* projection service absent */
  }
  return null
}

/** Build the compact session summary served by `GET /sessions` and `/events`. */
export function summarizeSession(bridge: Bridge, session: SessionLike): SessionSummary {
  let agent: { status?: string; session?: unknown } | undefined
  try {
    agent = bridge.ctx.agents?.get?.(session.id)
    if (agent?.session !== undefined && agent.session !== session) agent = undefined
  } catch {
    agent = undefined
  }
  const snapshot = bridge.stateContract.snapshot(session, bridge.server.epoch)
  // Current registry activity is safe even when attachment missed turn/start.
  // It cannot identify an outstanding question or prove task completion.
  const status = agent?.status === 'running' ? 'running' : agent?.status === 'idle' ? 'idle' : 'unknown'
  const lastModified = bridge.lastModified.get(session.id)
  const header = session.header
  const createdAt = header !== undefined && header.createdAt !== undefined && Number.isSafeInteger(header.createdAt)
    ? header.createdAt
    : 0
  return {
    id: String(session.id),
    title: titleOf(bridge, session),
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    lastModified: typeof lastModified === 'number' && Number.isFinite(lastModified) ? lastModified : createdAt,
    status,
    active: status === 'running' ? true : status === 'idle' ? false : null,
    activitySource: status === 'unknown' ? null : 'live-agent-status',
    stateDetailUnknown: snapshot.state === 'unknown',
    state: snapshot.state,
    waitKind: snapshot.waitKind,
    epoch: snapshot.epoch,
    sourceSeq: snapshot.sourceSeq,
    stateContract: 'live-session-seq-turn-call-v1',
    displayContent: bridge.sessionText.get(String(session.id)) ?? '',
    transitionRevision: snapshot.revision,
    agentId: AGENT_ID,
  }
}

/** Publish one `session` event carrying a fresh compact summary. */
function publishSessionSummary(bridge: Bridge, session: SessionLike): void {
  if (!session || typeof session.id !== 'string') return
  try {
    bridge.server.publish('session', { session: summarizeSession(bridge, session) })
  } catch (error) {
    bridge.logger.warn(error)
  }
}

/**
 * Extract the final assistant text blocks from one `assistant/message`
 * payload; tool-call/reasoning blocks are excluded from the device body.
 */
function assistantMessageText(message: unknown): string {
  const content = Array.isArray((message as { content?: unknown[] })?.content) ? (message as { content: unknown[] }).content : []
  const parts: string[] = []
  for (const block of content) {
    const typed = block as { type?: string; text?: string }
    if (typed && typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim()) {
      parts.push(typed.text.trim())
    }
  }
  return boundString(parts.join('\n'), 383) ?? ''
}

function rememberSessionText(bridge: Bridge, sessionId: string, text: string): void {
  if (!text) return
  bridge.sessionText.set(sessionId, text)
  if (bridge.sessionText.size > CACHE_LIMIT) {
    const oldest = bridge.sessionText.keys().next()
    if (!oldest.done) bridge.sessionText.delete(oldest.value)
  }
}

/**
 * Forward one live session event to `/events` as a compact bridge event.
 * Only bounded control-plane data is forwarded; transcript content is never
 * mirrored here.
 */
export function forwardSessionEvent(bridge: Bridge, session: SessionLike, event: SessionEventLike): void {
  if (!session || typeof session.id !== 'string' || !event || typeof event.type !== 'string') return
  // Reject a detached/replaced Session, even if an older object reuses its id.
  if (getLiveSession(bridge.ctx, session.id) !== session) return
  const normalized = bridge.stateContract.observe(session, event, bridge.server.epoch)
  if (!normalized.accepted) {
    if (normalized.changed) publishSessionSummary(bridge, session)
    return
  }
  const sessionId = session.id
  const time = Number.isSafeInteger(event.time) ? event.time : bridge.server.now()
  remember(bridge.lastModified, sessionId, time)
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
  const state = {
    state: normalized.state,
    waitKind: normalized.waitKind,
    epoch: normalized.epoch,
    sourceSeq: normalized.sourceSeq,
    transitionRevision: normalized.revision,
    stateContract: 'live-session-seq-turn-call-v1',
  }
  switch (event.type) {
    case 'session/title': {
      const title = boundString(data.title, 160) ?? ''
      remember(bridge.titleMap, sessionId, title)
      bridge.server.publish('session-title', { sessionId, title, ...state })
      break
    }
    case 'turn/start':
    case 'turn/end':
      bridge.server.publish('turn', {
        sessionId,
        ...state,
        phase: event.type === 'turn/start' ? 'start' : 'end',
        turn: Number.isSafeInteger(data.turn) ? data.turn : undefined,
        reason: boundString((data.reason as Record<string, unknown> | undefined)?.kind, 64) ?? undefined,
      })
      break
    case 'assistant/message': {
      const text = assistantMessageText(data.message)
      if (text) rememberSessionText(bridge, sessionId, text)
      publishSessionSummary(bridge, session)
      return
    }
    case 'tool/call':
    case 'tool/result': {
      const call = normalized.call
      if (!call) break
      const message = data.message as Record<string, unknown> | undefined
      bridge.server.publish('tool', {
        sessionId,
        ...state,
        phase: event.type === 'tool/call' ? 'start' : 'end',
        name: call.name,
        callId: call.callId,
        ok: event.type === 'tool/call' || (message?.isError !== true && !data.error),
      })
      break
    }
    case 'approval/asked':
      bridge.server.publish('approval-asked', {
        sessionId,
        ...state,
        approvalId: boundString(data.id, 256) ?? '',
        tool: boundString(data.toolName, 120) ?? 'unknown',
      })
      break
    case 'approval/decided':
      bridge.server.publish('approval-resolved', {
        sessionId,
        ...state,
        approvalId: boundString(data.id, 256) ?? '',
        outcome: typeof data.outcome === 'string' ? data.outcome : 'unavailable',
      })
      break
    default:
      if (!normalized.changed) return
  }
  publishSessionSummary(bridge, session)
}

/**
 * Deliver one prompt into a live session and emit `/inject` SSE events. The
 * terminal `done/stopReason:admitted` means admission only, never completion.
 */
export async function injectToSession(bridge: Bridge, args: {
  sessionId: unknown
  requestId?: unknown
  text: string
  emit: (event: Record<string, unknown>) => void
  signal?: AbortSignal
}): Promise<void> {
  const target = resolveTargetSession(bridge, args.sessionId)
  if (!target || typeof args.requestId !== 'string' || !args.requestId) {
    args.emit({ type: 'error', code: 'session-not-found', message: 'exact session/request required' })
    return
  }
  const controller = bridge.ctx.sessionController
  if (typeof controller?.prompt !== 'function') {
    args.emit({ type: 'error', code: 'session-controller-unavailable', message: 'supported sessionController required' })
    return
  }
  try {
    const result = await controller.prompt({
      requestId: args.requestId,
      sessionId: target.id,
      mode: 'queue',
      content: [{ type: 'text', text: args.text }],
    }, args.signal)
    if (result?.accepted !== true) throw new Error('prompt not admitted')
    // Admission is not completion of this utterance or the session.
    args.emit({ type: 'done', sessionId: target.id, tokens: 0, stopReason: 'admitted' })
  } catch {
    args.emit({ type: 'error', code: 'delivery-unknown', message: 'prompt admission unavailable or unknown; do not blindly retry' })
  }
}

/**
 * Resolve the live approval timeout from the HachimoDock bridge profile.
 * 0 means wait forever; absent/invalid falls back to the plugin config.
 */
function resolveApprovalTimeoutMs(bridge: Bridge): number {
  const envValue = process.env.HACHIMODOCK_PRISM_APPROVAL_TIMEOUT_MS
  if (typeof envValue === 'string' && envValue.trim() !== '') {
    const parsed = Number(envValue)
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed === 0 ? NEVER_APPROVAL_TIMEOUT_MS : parsed
  }
  try {
    const profilePath = process.env.HACHIMODOCK_BRIDGE_PROFILE ?? descriptorProfilePath()
    const raw = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as { dshApprovalTimeoutMs?: unknown }
    const value = raw?.dshApprovalTimeoutMs
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value === 0 ? NEVER_APPROVAL_TIMEOUT_MS : value
  } catch {
    /* profile missing or unreadable: use the plugin default */
  }
  return bridge.options.approvalTimeoutMs
}

function descriptorProfilePath(): string {
  return join(homedir(), '.claw-pet', 'pet-bridge.json')
}

/** Cancel the active turn of one live session. */
export async function interruptSession(bridge: Bridge, args: { sessionId?: unknown } = {}): Promise<{ ok: boolean; sessionId?: string; interrupted?: boolean; error?: string; state?: string }> {
  const target = resolveTargetSession(bridge, args.sessionId)
  if (!target) return { ok: false, error: 'session-not-found' }
  if (typeof bridge.ctx.sessionController?.cancel !== 'function') return { ok: false, error: 'session-controller-unavailable' }
  const receipt = await bridge.ctx.sessionController.cancel({ sessionId: target.id })
  return receipt?.accepted === true
    ? { ok: true, sessionId: target.id, interrupted: true, state: 'cancel-requested' }
    : { ok: false, error: 'interrupt-failed' }
}

/**
 * The Cordis `approval/request` answerer. Broadcasts the request to
 * HachimoDock `/events` subscribers and waits for the device decision:
 * allow -> `allowed-once`, deny -> `rejected`, timeout/abort/no connected
 * relay -> `unavailable` (fail closed). With `approvalFallback: 'delegate'`
 * a request with no attached relay consumer calls `next()` instead, which
 * keeps a resident approval UI as the answerer when HachimoDock is away.
 */
export async function handleApprovalRequest(bridge: Bridge, request: {
  agent?: { session?: { id?: string } }
  toolName?: string
  reason?: string
  displayReason?: unknown
  signal?: AbortSignal
}, next?: () => unknown): Promise<string> {
  const delegate = typeof next === 'function' ? next : () => Promise.resolve('unavailable')
  try {
    const sessionId = request?.agent?.session?.id
    if (typeof sessionId !== 'string') return 'unavailable'
    if (request.signal?.aborted) return 'cancelled'
    if (getLiveSession(bridge.ctx, sessionId) !== request.agent?.session) return 'unavailable'
    if (!bridge.server.hasEventSubscriber()) {
      if (bridge.options.approvalFallback === 'delegate') {
        const outcome = await delegate()
        return typeof outcome === 'string' ? outcome : 'unavailable'
      }
      return 'unavailable'
    }
    const prompt = bridge.server.requestApproval({
      agentId: AGENT_ID,
      sessionId,
      tool: typeof request.toolName === 'string' ? request.toolName : 'unknown',
      reason: typeof request.reason === 'string' ? request.reason : undefined,
      displayReason: typeof request.displayReason === 'string'
        ? request.displayReason
        : recordOf(request.displayReason),
      timeoutMs: resolveApprovalTimeoutMs(bridge),
      signal: request.signal,
    })
    // Claim once. No parallel next(), no DOM dismissal and no reassignment on disconnect.
    return await prompt.outcome
  } catch (error) {
    bridge.logger.warn(error)
    return 'unavailable'
  }
}

function recordOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  for (const key of ['zh-CN', 'zh', 'en']) {
    if (typeof record[key] === 'string') return record[key] as string
  }
  return undefined
}

/** The bridge: one server plus every host listener it needs. */
export interface Bridge {
  ctx: BridgeContextLike
  options: BridgeOptions
  logger: Required<LoggerLike>
  titleMap: Map<string, string>
  lastModified: Map<string, number>
  sessionText: Map<string, string>
  stateContract: ReturnType<typeof createStateContract>
  server: BridgeServer
  start: () => Promise<number>
  stop: () => Promise<void>
  handleApprovalRequest: (request: Parameters<typeof handleApprovalRequest>[1], next?: () => unknown) => Promise<string>
  interruptSession: (args?: { sessionId?: unknown }) => Promise<{ ok: boolean; sessionId?: string; interrupted?: boolean; error?: string; state?: string }>
  injectToSession: (args: Parameters<typeof injectToSession>[1]) => Promise<void>
  listSessions: () => SessionSummary[]
  resolveTargetSession: (sessionId: unknown) => SessionLike | undefined
  summarizeSession: (session: SessionLike) => SessionSummary
}


/**
 * Create the bridge: one `BridgeServer` plus every host listener it needs.
 * Listening is intentionally separate (`bridge.start()` / `bridge.stop()`)
 * so tests drive the transport and the host boundary independently.
 */
export function createBridge(ctx: BridgeContextLike, config: BridgeConfig = {}, activation?: ActivationHub): Bridge {
  const options = normalizeOptions(config)
  const logger = safeLogger(ctx)
  // The adapter callbacks close over the finished bridge through this holder;
  // the server only invokes them after `listen()`, once the holder is set.
  const holder: { current?: Bridge } = {}
  const server = new BridgeServer({
    port: options.port,
    approvalTimeoutMs: options.approvalTimeoutMs,
    injectTimeoutMs: options.injectTimeoutMs,
    logger,
    allowedOrigins: options.allowedOrigins,
    bootstrapFile: options.bootstrapFile,
    writeBootstrap: options.writeBootstrap,
    listSessions: () => {
      const current = holder.current
      if (current === undefined) return []
      const summaries: SessionSummary[] = []
      for (const session of getLiveSessions(ctx)) {
        try {
          summaries.push(summarizeSession(current, session))
        } catch (error) {
          logger.warn(error)
        }
      }
      return summaries
    },
    inject: (args) => {
      const current = holder.current
      if (current === undefined) return Promise.resolve()
      return injectToSession(current, args)
    },
    interrupt: (args) => {
      const current = holder.current
      if (current === undefined) return Promise.resolve({ ok: false, error: 'interrupt-unavailable' })
      return interruptSession(current, args)
    },
    activate: (args) => {
      // The device picked a conversation; push it to same-origin web clients.
      try {
        activation?.activate(args.sessionId)
      } catch (error) {
        logger.warn(error)
      }
    },
  })
  const bridge: Bridge = {
    ctx,
    options,
    logger,
    titleMap: new Map(),
    lastModified: new Map(),
    stateContract: createStateContract({ limit: CACHE_LIMIT }),
    sessionText: new Map(),
    server,
    start: async () => server.listen(),
    stop: async () => server.close(),
    handleApprovalRequest: (request, next) => handleApprovalRequest(bridge, request, next),
    interruptSession: args => interruptSession(bridge, args),
    injectToSession: args => injectToSession(bridge, args),
    listSessions: () => server.listSessions(),
    resolveTargetSession: sessionId => resolveTargetSession(bridge, sessionId),
    summarizeSession: session => summarizeSession(bridge, session),
  }
  holder.current = bridge

  // Compact control-plane forwarding to GET /events.
  ctx.on?.('session/event', (session: SessionLike, event: SessionEventLike) => {
    try {
      forwardSessionEvent(bridge, session, event)
    } catch (error) {
      logger.warn(error)
    }
  })
  ctx.on?.('session/created', (session: SessionLike) => {
    try {
      publishSessionSummary(bridge, session)
    } catch (error) {
      logger.warn(error)
    }
  })
  ctx.on?.('session/disposed', (session: SessionLike) => {
    try {
      if (session && typeof session.id === 'string') {
        const current = getLiveSession(bridge.ctx, session.id)
        if (current && current !== session) return
        bridge.stateContract.forget(session)
        bridge.server.retireSession(session.id)
        bridge.server.publish('session', { session: { id: session.id, removed: true } })
      }
    } catch (error) {
      logger.warn(error)
    }
  })
  ctx.on?.('agent/status', (payload: { agent?: { session?: SessionLike } }) => {
    try {
      const session = payload?.agent?.session
      if (session) publishSessionSummary(bridge, session)
    } catch (error) {
      logger.warn(error)
    }
  })

  // The answerer itself: terminal for HachimoDock, delegating by config.
  ctx.on?.('approval/request', (request: Parameters<typeof handleApprovalRequest>[1], next: () => unknown) =>
    handleApprovalRequest(bridge, request, next))

  bridge.start = async () => bridge.server.listen()
  bridge.stop = async () => bridge.server.close()
  return bridge
}
