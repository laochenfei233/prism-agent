/**
 * Transport and state for the HachimoDock <-> Prism bridge.
 *
 * This module knows nothing about Cordis or the host. It owns one loopback
 * `node:http` server (`127.0.0.1` only), the protocol v2 endpoints, the
 * bounded event ring behind `GET /events?after=<seq>`, pending approval
 * requests with idempotent one-shot decisions, and the conversation-switch
 * route `POST /sessions/activate`. Everything host-specific is injected
 * through `listSessions`, `inject`, `interrupt`, and `activate`, so tests
 * drive the wire contract with fake dependencies and no profile.
 *
 * Wire shapes (protocol version 2):
 *   GET  /health             -> {"ok":true,"version":2,"sessions":N,"pendingApprovals":N}
 *   GET  /sessions           -> {"version":2,"sessions":[summary...]}
 *   POST /inject             -> text/event-stream: token | tool | done | error
 *   GET  /events?after=<seq> -> text/event-stream: id/event/data frames
 *   POST /approval/decision  -> {"ok":true,"requestId":...,"accepted":true} | 400 | 409
 *   POST /sessions/activate  -> {"ok":true,"sessionId":"..."}
 *
 * Port of upstream `integrations/dsh-hachimodock/server.js` (HachimoDock main
 * `361cb0e`) with the prism conversation-switch addition.
 *
 * @module @prism/prism-hachimodock/server
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { equal, prepareDirectory, secret, writeDescriptor } from './capability.ts'
import type { LoggerLike, SessionSummary } from './types.ts'
import type { CapabilityDescriptor } from './capability.ts'

/** The compact session summary row served over the wire. */
export type SessionSummaryRow = SessionSummary

/** Protocol version advertised by `GET /health`. */
export const PROTOCOL_VERSION = 2
/** Default localhost port from the contract; the prism default is a free port. */
export const DEFAULT_PORT = 17892
/** Default approval wait before failing closed. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000
/** Sentinel used by the UI for 'never'; still a concrete large timeout. */
export const NEVER_APPROVAL_TIMEOUT_MS = 99999
/** Largest accepted JSON request body (contract: body limit 64KB). */
export const MAX_BODY_BYTES = 64 * 1024
/** Hard cap on `/inject` text after JSON decoding. */
export const MAX_INJECT_TEXT_CHARS = 32 * 1024
/** Bounded replay window for `/events?after=<seq>`. */
export const EVENT_BUFFER_LIMIT = 512
/** How many terminal approval ids stay queryable for duplicate detection. */
const RESOLVED_APPROVAL_LIMIT = 256
/** Comment interval keeping idle SSE connections alive. */
const SSE_KEEPALIVE_MS = 15_000
/** Longest single field mirrored from host state into an event. */
const MAX_EVENT_STRING = 200

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Whether a peer socket address is a loopback literal. */
export function isLoopbackAddress(address: string | undefined): boolean {
  return typeof address === 'string' && LOOPBACK_ADDRESSES.has(address)
}

/** Truncate one string field so event payloads stay bounded. */
export function boundString(value: unknown, max: number = MAX_EVENT_STRING): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

/** Error carrying an HTTP status and stable machine code for a JSON response. */
export function httpError(status: number, code: string, message?: string): Error & { status: number; code: string } {
  const error = new Error(message ?? code) as Error & { status: number; code: string }
  error.status = status
  error.code = code
  return error
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function sendSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders()
}

function writeSseFrame(res: ServerResponse, frame: { id?: string; event?: string; data?: unknown }): boolean {
  if (res.writableEnded || res.destroyed) return false
  let text = ''
  if (frame.id !== undefined) text += `id: ${frame.id}\n`
  if (frame.event !== undefined) text += `event: ${frame.event}\n`
  if (frame.data !== undefined) text += `data: ${JSON.stringify(frame.data)}\n`
  text += '\n'
  try {
    if (Buffer.byteLength(text) > 65536 || res.writableLength + Buffer.byteLength(text) > 131072) {
      res.destroy()
      return false
    }
    res.write(text) // bounded Node queue; disconnect at 128KiB even under backpressure
    return true
  } catch {
    return false
  }
}

function writeSseComment(res: ServerResponse, text: string): boolean {
  if (res.writableEnded || res.destroyed) return false
  try {
    if (res.writableLength > 131000) {
      res.destroy()
      return false
    }
    res.write(`: ${text}\n\n`)
    return true
  } catch {
    return false
  }
}

/** Read a bounded JSON request body; prototype-keyed or non-object bodies fail. */
export function readJsonBody(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > limit) {
      reject(httpError(413, 'payload-too-large', `request body exceeds ${limit} bytes`))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(httpError(413, 'payload-too-large', `request body exceeds ${limit} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        reject(httpError(400, 'invalid-json', 'request body must be JSON'))
        return
      }
      try {
        const value: unknown = JSON.parse(text, (key, inner) => {
          if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('invalid key')
          return inner
        })
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required')
        resolve(value as Record<string, unknown>)
      } catch {
        reject(httpError(400, 'invalid-json', 'request body is not valid JSON'))
      }
    })
    req.on('error', error => fail(httpError(400, 'invalid-json', error.message)))
  })
}

/** An authenticated caller: a native token role or a paired web client. */
export interface Caller {
  readonly role: 'relay' | 'bus' | 'voice' | 'web'
  readonly clientId: string
  readonly token?: string
  readonly origin?: string
  readonly sessionId?: string
  readonly expires?: number
}

interface Subscriber {
  res: ServerResponse
  ended: boolean
  role: Caller['role']
  clientId: string
  sessionId?: string
  expires?: number
  lease: string
}

interface PendingApproval {
  requestId: string
  sessionId: string
  expiresAtMs: number
  owner: string
  lease: string
  resolve: (outcome: string) => void
  timer: NodeJS.Timeout | null
  removeAbort: (() => void) | null
}

interface ResolvedApproval {
  outcome: string
  at: number
  expired: boolean
  owner: string
  lease: string
  sessionId: string
}

interface VoiceUtterance {
  sessionId: string
  owner: string
  epoch: string | null
  lease: string
  state: 'capturing' | 'captured' | 'inserting' | 'inserted' | 'submitting' | 'submit-requested' | 'delivery-unknown'
  created: number
  revision?: number | undefined
  text?: string | undefined
}

interface VoiceWaiter {
  finish: (result: { ok: boolean; error?: string; status?: string }) => void
  owner: string
  utteranceId: string
  action: string
  revision?: number | undefined
}

/** Host contract snapshot served through `/voice/status`. */
export interface HostCapabilities {
  readonly adapter: string
  readonly sessions: boolean
  readonly sessionList: boolean
  readonly liveState: boolean
  readonly events: boolean
  readonly readonlyStatus: boolean
  readonly agentSnapshot: boolean
  readonly clientBundle: boolean
  readonly backgroundPrompt: boolean
  readonly interrupt: boolean
  readonly approval: 'independent-relay'
}

export interface BridgeServerOptions {
  port?: number
  approvalTimeoutMs?: number
  injectTimeoutMs?: number
  logger?: LoggerLike
  allowedOrigins?: readonly string[]
  bootstrapFile?: string | undefined
  writeBootstrap?: boolean
  listSessions?: () => SessionSummaryRow[]
  inject?: (args: { sessionId: string; requestId: string; text: string; emit: (event: Record<string, unknown>) => void; signal: AbortSignal }) => Promise<void>
  interrupt?: (args: { sessionId: string }) => Promise<{ ok: boolean; sessionId?: string; interrupted?: boolean; error?: string }>
  activate?: (args: { sessionId: string }) => void
  now?: () => number
  createRequestId?: () => string
  /** Capability store seam; defaults to the real descriptor store. */
  capabilityIo?: Pick<typeof import('./capability.ts'), 'prepareDirectory' | 'writeDescriptor'>
}

/**
 * Bridge transport: HTTP server, event buffer, SSE subscribers, approvals,
 * and the conversation-switch fan-out.
 */
export class BridgeServer {
  epoch: string | null = null
  tokens: { relay?: string; bus?: string; voice?: string } = {}
  pairingCode: string | null = null
  pairingExpires = Date.now() + 120_000
  pairingAttempts = 0
  pairingSessionId: string | undefined
  pairingOrigin: string | undefined
  capabilities?: () => HostCapabilities
  readonly webClients = new Map<string, Caller & { token: string }>()
  private readonly origins: Set<string>
  private readonly bootstrapFile: string | undefined
  private readonly writeBootstrap: boolean
  readonly voiceOwners = new Map<string, Subscriber>()
  readonly utterances = new Map<string, VoiceUtterance>()
  private readonly voiceWaiters = new Map<string, VoiceWaiter>()
  readonly injecting = new Map<string, { pending: boolean }>()
  private activeInjects = 0
  readonly injectTimeoutMs: number
  private readonly injectControllers = new Set<AbortController>()
  readonly port: number
  readonly host = '127.0.0.1'
  private readonly approvalTimeoutMs: number
  readonly listSessions: () => SessionSummaryRow[]
  private readonly inject: NonNullable<BridgeServerOptions['inject']>
  private readonly interrupt: NonNullable<BridgeServerOptions['interrupt']>
  activate: BridgeServerOptions['activate']
  private readonly logger: LoggerLike | null
  readonly now: () => number
  private readonly createRequestId: () => string
  readonly capabilityIo: Pick<typeof import('./capability.ts'), 'prepareDirectory' | 'writeDescriptor'>
  httpServer: import('node:http').Server | null = null
  listeningPort: number | null = null
  private didListen = false
  events: Array<{ seq: number; type: string } & Record<string, unknown>> = []
  nextSeq = 1
  readonly subscribers = new Set<Subscriber>()
  /** Pending and terminal approvals stay inspectable for authenticated relays. */
  readonly pending = new Map<string, PendingApproval>()
  readonly resolved = new Map<string, ResolvedApproval>()

  constructor(options: BridgeServerOptions = {}) {
    this.origins = new Set(options.allowedOrigins ?? [])
    for (const origin of this.origins) {
      // Desktop scheme + issuer is a protocol contract, not a version pin.
      // URL.origin is "null" for this scheme; never accept that string itself.
      if (origin === 'dsh-app://app') continue
      const u = new URL(origin)
      if (!['http:', 'https:'].includes(u.protocol) || u.origin !== origin) throw new Error('exact Origin required')
    }
    this.bootstrapFile = options.bootstrapFile
    this.writeBootstrap = options.writeBootstrap !== false
    this.injectTimeoutMs = options.injectTimeoutMs ?? 600_000
    this.port = options.port ?? 0
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.listSessions = options.listSessions ?? (() => [])
    this.inject = options.inject
      ?? (async ({ emit }) => {
        emit({ type: 'error', code: 'inject-unavailable', message: 'no inject adapter configured' })
      })
    this.interrupt = options.interrupt ?? (async () => ({ ok: false, error: 'interrupt-unavailable' }))
    this.activate = options.activate
    this.logger = options.logger ?? null
    this.now = options.now ?? (() => Date.now())
    this.createRequestId = options.createRequestId ?? (() => `req-${randomUUID()}`)
    this.capabilityIo = options.capabilityIo ?? { prepareDirectory, writeDescriptor }
  }

  /** Start listening. Idempotent. Returns the actual listening port. */
  async listen(port?: number): Promise<number> {
    if (this.httpServer) return this.listeningPort as number
    // Authenticate the storage boundary before generating any new capability.
    if (this.writeBootstrap) {
      if (this.bootstrapFile === undefined) this.capabilityIo.prepareDirectory()
      else this.capabilityIo.prepareDirectory(this.bootstrapFile)
    }
    this.epoch = secret()
    this.tokens = { relay: secret(), bus: secret(), voice: secret() }
    this.pairingCode = secret()
    this.pairingExpires = Date.now() + 120_000
    this.pairingAttempts = 0
    if (this.didListen) {
      this.events = []
      this.nextSeq = 1
      this.resolved.clear()
      this.injecting.clear()
    }
    const server = createServer((req, res) => {
      this.handleRequest(req, res).catch((error) => this.failRequest(res, error))
    })
    server.headersTimeout = 10_000
    server.requestTimeout = 15_000
    server.keepAliveTimeout = 5_000
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('error', onError)
        reject(error)
      }
      server.once('error', onError)
      server.listen(port ?? this.port, this.host, () => {
        server.off('error', onError)
        server.on('error', (error) => this.log('error', error))
        resolve()
      })
    })
    this.httpServer = server
    this.didListen = true
    const address = server.address()
    this.listeningPort = typeof address === 'object' && address !== null ? address.port : null
    if (this.writeBootstrap) {
      try {
        const descriptor: CapabilityDescriptor = {
          version: 2,
          baseUrl: this.url(),
          epoch: this.epoch,
          tokens: this.tokens as CapabilityDescriptor['tokens'],
          pairingCode: this.pairingCode,
          pairingExpires: this.pairingExpires,
        }
        if (this.bootstrapFile === undefined) this.capabilityIo.writeDescriptor(descriptor)
        else this.capabilityIo.writeDescriptor(descriptor, this.bootstrapFile)
      } catch (error) {
        await this.close()
        throw error
      }
    }
    return this.listeningPort as number
  }

  /** Base URL of the running server. */
  url(): string {
    return `http://127.0.0.1:${this.listeningPort ?? this.port}`
  }

  /** Stop listening, end SSE connections, and fail pending approvals closed. */
  async close(): Promise<void> {
    for (const requestId of [...this.pending.keys()]) this.settleApproval(requestId, 'unavailable', { expired: true })
    for (const subscriber of [...this.subscribers]) this.closeSubscriber(subscriber)
    this.subscribers.clear()
    for (const c of this.injectControllers) c.abort()
    this.injectControllers.clear()
    this.webClients.clear()
    this.voiceOwners.clear()
    this.utterances.clear()
    for (const w of this.voiceWaiters.values()) w.finish({ ok: false, error: 'disconnected' })
    this.voiceWaiters.clear()
    const server = this.httpServer
    this.httpServer = null
    this.listeningPort = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    })
  }

  private log(level: 'info' | 'warn' | 'error', detail: unknown): void {
    try {
      this.logger?.[level]?.(detail)
    } catch {
      /* a logger must never break the bridge */
    }
  }

  /** Publish one event to the replay buffer and every `/events` subscriber. */
  publish(type: string, payload: Record<string, unknown> = {}): { seq: number; type: string } & Record<string, unknown> {
    if (Buffer.byteLength(JSON.stringify(payload)) > 32768) throw httpError(413, 'event-too-large')
    const event = { ...payload, seq: this.nextSeq, type }
    this.nextSeq += 1
    this.events.push(event)
    if (this.events.length > EVENT_BUFFER_LIMIT) this.events.splice(0, this.events.length - EVENT_BUFFER_LIMIT)
    for (const subscriber of this.subscribers) this.writeToSubscriber(subscriber, event)
    return event
  }

  /** Whether at least one authenticated `/events` relay consumer is attached. */
  hasEventSubscriber(): boolean {
    for (const subscriber of this.subscribers) {
      if (!subscriber.ended && subscriber.role === 'relay') return true
    }
    return false
  }

  /**
   * Broadcast an approval prompt and wait for its one-shot decision. The
   * returned promise settles with `allowed-once`, `rejected`, or `unavailable`;
   * an already-resolved id never resolves twice.
   */
  requestApproval(request: {
    agentId?: string | undefined
    sessionId: string
    tool?: string | undefined
    reason?: string | undefined
    displayReason?: string | undefined
    approvalId?: string | undefined
    timeoutMs?: number | undefined
    signal?: AbortSignal | undefined
  }): { requestId: string; expiresAtMs: number; outcome: Promise<string> } {
    const requestId = this.createRequestId()
    if (!validId(requestId) || requestId.length > 63 || this.pending.has(requestId) || this.resolved.has(requestId)) {
      return { requestId, expiresAtMs: 0, outcome: Promise.resolve('unavailable') }
    }
    const relay = [...this.subscribers].find(s => !s.ended && s.role === 'relay')
    if (!relay || this.pending.size >= 16 || request.signal?.aborted) {
      return { requestId, expiresAtMs: 0, outcome: Promise.resolve(request.signal?.aborted ? 'cancelled' : 'unavailable') }
    }
    const configuredTimeout = request.timeoutMs
    const timeoutMs = typeof configuredTimeout === 'number' && Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : this.approvalTimeoutMs
    const neverExpires = timeoutMs === NEVER_APPROVAL_TIMEOUT_MS
    const expiresAtMs = neverExpires ? 0 : this.now() + timeoutMs
    const outcome = new Promise<string>((resolve) => {
      const pending: PendingApproval = {
        requestId,
        sessionId: request.sessionId,
        expiresAtMs,
        owner: relay.clientId,
        lease: relay.lease,
        resolve,
        timer: null,
        removeAbort: null,
      }
      // Register before arming the timer/abort path so an already-aborted
      // signal or an immediate timeout can settle this exact request.
      this.pending.set(requestId, pending)
      if (!neverExpires) {
        pending.timer = setTimeout(() => {
          if (this.settleApproval(requestId, 'unavailable', { expired: true })) {
            this.publish('approval-expired', { requestId, epoch: this.epoch, lease: relay.lease, owner: relay.clientId })
          }
        }, timeoutMs)
        pending.timer.unref?.()
      }
      const signal = request.signal
      if (signal) {
        const onAbort = (): void => {
          if (this.settleApproval(requestId, 'cancelled', { expired: true })) {
            this.publish('approval-cancel', { requestId, epoch: this.epoch, lease: relay.lease, owner: relay.clientId })
          }
        }
        if (signal.aborted) onAbort()
        else {
          signal.addEventListener('abort', onAbort, { once: true })
          pending.removeAbort = () => signal.removeEventListener('abort', onAbort)
        }
      }
    })
    if (this.pending.has(requestId)) {
      this.publish('approval', {
        epoch: this.epoch,
        lease: relay.lease,
        owner: relay.clientId,
        requestId,
        agentId: boundString(request.agentId, 80) ?? 'prism-agent',
        sessionId: boundString(request.sessionId, 200) ?? '',
        tool: boundString(request.tool, 120) ?? 'unknown',
        reason: boundString(request.reason) ?? '',
        displayReason: boundString(request.displayReason) ?? '',
        ...(typeof request.approvalId === 'string' ? { approvalId: boundString(request.approvalId) } : {}),
        expiresAtMs,
        timeoutMs,
        neverExpires,
      })
    }
    return { requestId, expiresAtMs, outcome }
  }

  /** Apply one decision to a pending approval; pending ids are consumed once. */
  decideApproval(requestId: string, decision: 'allow' | 'deny', caller?: Caller | null, binding?: { epoch?: unknown; sessionId?: unknown; lease?: unknown }): { ok: boolean; requestId?: string; accepted?: boolean; error?: string } {
    const pending = this.pending.get(requestId)
    if (pending !== undefined) {
      if (pending.expiresAtMs && this.now() >= pending.expiresAtMs) {
        this.settleApproval(requestId, 'unavailable', { expired: true })
        return { ok: false, requestId, error: 'unknown-or-expired' }
      }
      if (!caller || caller.role !== 'relay' || pending.owner !== caller.clientId
        || binding?.epoch !== this.epoch || binding?.sessionId !== pending.sessionId || binding?.lease !== pending.lease
        || ![...this.subscribers].some(s => s.role === 'relay' && !s.ended && s.lease === pending.lease)) {
        return { ok: false, requestId, error: 'unknown-or-expired' }
      }
      const outcome = decision === 'allow' ? 'allowed-once' : 'rejected'
      this.settleApproval(requestId, outcome, { expired: false })
      return { ok: true, requestId, accepted: true }
    }
    const resolved = this.resolved.get(requestId)
    if (resolved !== undefined) {
      if (!caller || caller.clientId !== resolved.owner || binding?.epoch !== this.epoch
        || binding?.sessionId !== resolved.sessionId || binding?.lease !== resolved.lease) {
        return { ok: false, requestId, error: 'unknown-or-expired' }
      }
      if (resolved.expired) return { ok: false, requestId, error: 'unknown-or-expired' }
      if (resolved.outcome === (decision === 'allow' ? 'allowed-once' : 'rejected')) return { ok: true, requestId, accepted: true }
      return { ok: false, requestId, error: 'already-decided' }
    }
    return { ok: false, requestId, error: 'unknown-or-expired' }
  }

  /** Retire one claimed request without consulting a competing answerer. */
  cancelApproval(requestId: string, outcome = 'unavailable'): boolean {
    const p = this.pending.get(requestId)
    if (p === undefined) return false
    this.settleApproval(requestId, 'unavailable', { expired: true })
    this.publish('approval-cancel', { requestId, outcome, epoch: this.epoch, lease: p.lease, owner: p.owner })
    return true
  }

  private settleApproval(requestId: string, outcome: string, flags: { expired: boolean }): boolean {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return false
    this.pending.delete(requestId)
    if (pending.timer !== null) clearTimeout(pending.timer)
    if (typeof pending.removeAbort === 'function') {
      try {
        pending.removeAbort()
      } catch {
        /* ignore */
      }
    }
    this.resolved.set(requestId, {
      outcome, at: this.now(), expired: flags.expired, owner: pending.owner, lease: pending.lease, sessionId: pending.sessionId,
    })
    if (this.resolved.size > RESOLVED_APPROVAL_LIMIT) {
      const oldest = this.resolved.keys().next()
      if (!oldest.done) this.resolved.delete(oldest.value)
    }
    pending.resolve(outcome)
    return true
  }

  writeToSubscriber(subscriber: Subscriber, event: { seq: number; type: string } & Record<string, unknown>): void {
    if (subscriber.expires && subscriber.expires <= Date.now()) {
      this.closeSubscriber(subscriber)
      return
    }
    if (subscriber.role === 'web') {
      if (!['voice-begin', 'voice-insert', 'voice-submit'].includes(event.type) || event.owner !== subscriber.clientId || event.sessionId !== subscriber.sessionId) return
    } else if (subscriber.role !== 'relay' || event.type.startsWith('voice-')) return
    if (event.owner && event.owner !== subscriber.clientId) return
    const ok = writeSseFrame(subscriber.res, { id: `${this.epoch}:${subscriber.clientId}:${event.seq}`, event: event.type, data: event })
    if (!ok) this.closeSubscriber(subscriber)
  }

  private closeSubscriber(subscriber: Subscriber): void {
    if (subscriber.ended) return
    subscriber.ended = true
    this.subscribers.delete(subscriber)
    if (subscriber.role === 'relay') {
      for (const [id, p] of this.pending) if (p.lease === subscriber.lease) this.cancelApproval(id)
    } else if (subscriber.role === 'web') {
      if (this.voiceOwners.get(subscriber.sessionId ?? '') === subscriber) this.voiceOwners.delete(subscriber.sessionId ?? '')
      this.webClients.delete(subscriber.clientId)
      for (const [id, u] of this.utterances) if (u.owner === subscriber.clientId) this.utterances.delete(id)
      for (const w of this.voiceWaiters.values()) if (w.owner === subscriber.clientId) w.finish({ ok: false, error: 'delivery-unknown' })
    }
    try {
      subscriber.res.end()
    } catch {
      /* ignore */
    }
  }

  private authenticate(req: IncomingMessage): Caller | null {
    const raw = req.headers.authorization
    if (typeof raw !== 'string' || raw.length > 128 || !raw.startsWith('Bearer ')) return null
    const token = raw.slice(7)
    for (const [role, value] of Object.entries(this.tokens)) {
      if (equal(token, value) && req.headers.origin === undefined) return { role: role as Caller['role'], clientId: `native-${role}` }
    }
    for (const c of this.webClients.values()) {
      if (equal(token, c.token) && c.origin === req.headers.origin && (c.expires ?? 0) > Date.now()) return c
    }
    return null
  }

  /** Retire one session: approvals, subscribers, and voice utterances. */
  retireSession(sessionId: string): void {
    for (const [id, p] of this.pending) if (p.sessionId === sessionId) this.cancelApproval(id)
    for (const s of [...this.subscribers]) if (s.sessionId === sessionId) this.closeSubscriber(s)
    for (const [id, u] of this.utterances) if (u.sessionId === sessionId) this.utterances.delete(id)
  }

  private async handleVoice(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const b = await readJsonBody(req)
    checkBody(b, ['sessionId', 'utteranceId', 'revision', 'text', 'epoch', 'lease'])
    if (!validId(String(b.sessionId)) || !validId(String(b.utteranceId))) throw httpError(400, 'exact-target-required')
    for (const [id, u] of this.utterances) if (Date.now() - u.created > 120_000) this.utterances.delete(id)
    const currentSession = this.listSessions().find(s => s.id === b.sessionId)
    if (currentSession?.state === 'waiting_user' && currentSession.waitKind === 'question') throw httpError(409, 'question-pending')
    const owner = this.voiceOwners.get(String(b.sessionId))
    if (!owner || owner.ended || (owner.expires ?? 0) <= Date.now()) throw httpError(409, 'composer-unavailable')
    let u = this.utterances.get(String(b.utteranceId))
    if (path === '/voice/begin') {
      if (u || this.utterances.size >= 64) throw httpError(409, 'utterance-already-used')
      u = { sessionId: String(b.sessionId), owner: owner.clientId, epoch: this.epoch, lease: owner.lease, state: 'capturing', created: Date.now() }
      this.utterances.set(String(b.utteranceId), u)
    } else if (!u || u.sessionId !== b.sessionId || u.owner !== owner.clientId || b.epoch !== this.epoch || b.lease !== u.lease || Date.now() - u.created > 120_000) {
      throw httpError(409, 'stale-utterance')
    }
    const action = path.split('/').pop() ?? ''
    if (action === 'draft') {
      if (u.state !== 'captured' || !Number.isSafeInteger(b.revision) || (b.revision as number) < 1
        || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000) {
        throw httpError(409, 'draft-refused')
      }
      u.revision = b.revision as number
      u.state = 'inserting'
    }
    if (action === 'submit') {
      if (u.state !== 'inserted' || b.revision !== u.revision) throw httpError(409, 'submit-refused')
      u.state = 'submitting' // consume before dispatch: unknown is never resent
    }
    const actionId = secret()
    const result = await new Promise<{ ok: boolean; error?: string; status?: string }>((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const finish = (value: { ok: boolean; error?: string; status?: string }): void => {
        clearTimeout(timer)
        this.voiceWaiters.delete(actionId)
        resolve(value)
      }
      timer = setTimeout(() => finish({ ok: false, error: 'delivery-unknown' }), 1500)
      timer.unref?.()
      this.voiceWaiters.set(actionId, { finish, owner: u.owner, utteranceId: String(b.utteranceId), action, revision: u.revision })
      this.publish(
        action === 'begin' ? 'voice-begin' : action === 'draft' ? 'voice-insert' : 'voice-submit',
        {
          actionId, owner: u.owner, sessionId: u.sessionId, utteranceId: b.utteranceId, epoch: this.epoch, lease: u.lease, revision: u.revision,
          ...(action === 'draft' ? { text: b.text } : {}),
        },
      )
    })
    if (result.ok) u.state = action === 'begin' ? 'captured' : action === 'draft' ? 'inserted' : 'submit-requested'
    else u.state = 'delivery-unknown'
    sendJson(res, result.ok ? 200 : 409, { ...result, epoch: this.epoch, lease: u.lease, utteranceId: b.utteranceId, sessionId: b.sessionId })
  }

  private async handleVoiceAck(req: IncomingMessage, res: ServerResponse, caller: Caller): Promise<void> {
    const b = await readJsonBody(req)
    checkBody(b, ['actionId', 'utteranceId', 'sessionId', 'epoch', 'lease', 'ok', 'status'])
    const w = this.voiceWaiters.get(String(b.actionId))
    const u = this.utterances.get(String(b.utteranceId))
    if (!w || !u || w.owner !== caller.clientId || w.utteranceId !== b.utteranceId || u.sessionId !== caller.sessionId
      || b.sessionId !== u.sessionId || b.epoch !== this.epoch || b.lease !== u.lease || typeof b.ok !== 'boolean') {
      throw httpError(409, 'stale-ack')
    }
    w.finish(b.ok
      ? { ok: true, status: w.action === 'submit' ? 'submit-requested' : w.action === 'begin' ? 'captured' : 'inserted' }
      : { ok: false, error: 'composer-refused' })
    sendJson(res, 200, { ok: true })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid-request' })
      return
    }
    const path = url.pathname
    const method = req.method ?? 'GET'
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.headers.host !== `127.0.0.1:${this.listeningPort}` || url.searchParams.has('token')) {
      return sendJson(res, 403, { ok: false, error: 'forbidden' })
    }
    const origin = req.headers.origin
    if (origin !== undefined && (!this.origins.has(origin) || origin === 'null')) return sendJson(res, 403, { ok: false, error: 'forbidden-origin' })
    if (origin) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'Origin')
    }
    if (method === 'OPTIONS') {
      const requested = req.headers['access-control-request-method']
      const headers = String(req.headers['access-control-request-headers'] || '').split(',').filter(Boolean)
      if (!origin || (requested !== 'POST' && requested !== 'GET')
        || headers.some(h => !['authorization', 'content-type'].includes(h.trim().toLowerCase()))) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' })
      }
      res.setHeader('access-control-allow-methods', 'GET, POST')
      res.setHeader('access-control-allow-headers', 'Authorization, Content-Type')
      res.writeHead(204)
      res.end()
      return
    }
    if (method === 'POST' && !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
      return sendJson(res, 415, { ok: false, error: 'json-required' })
    }
    if (path === '/health' && method === 'GET') return sendJson(res, 200, { ok: true, version: PROTOCOL_VERSION })
    if (path === '/pair' && method === 'POST') {
      if (!origin || ++this.pairingAttempts > 8 || Date.now() > this.pairingExpires || !this.pairingCode) {
        return sendJson(res, 403, { ok: false, error: 'pairing-unavailable' })
      }
      const body = await readJsonBody(req)
      if (!equal(body.code, this.pairingCode)
        || (this.pairingSessionId !== undefined && this.pairingSessionId !== body.sessionId)
        || (this.pairingOrigin !== undefined && this.pairingOrigin !== origin)
        || !validId(String(body.sessionId))
        || !this.listSessions().some(s => s.id === body.sessionId)
        || Object.keys(body).some(k => !['code', 'sessionId'].includes(k))) {
        return sendJson(res, 403, { ok: false, error: 'pairing-refused' })
      }
      for (const [id, c] of this.webClients) if ((c.expires ?? 0) <= Date.now()) this.webClients.delete(id)
      if (this.webClients.size >= 8) throw httpError(429, 'client-capacity')
      this.pairingCode = null
      const clientId = randomUUID()
      const token = secret()
      const client: Caller & { token: string } = {
        clientId, token, role: 'web', origin, sessionId: String(body.sessionId), expires: Date.now() + 3_600_000,
      }
      this.webClients.set(clientId, client)
      return sendJson(res, 200, { ok: true, token, epoch: this.epoch, clientId, sessionId: body.sessionId })
    }
    const caller = this.authenticate(req)
    if (!caller) return sendJson(res, 401, { ok: false, error: 'unpaired' })
    const routes: Record<Caller['role'], string[]> = {
      relay: ['/events', '/approval/decision', '/relay/close'],
      bus: ['/sessions', '/inject', '/interrupt', '/sessions/activate'],
      voice: ['/voice/status', '/voice/begin', '/voice/draft', '/voice/submit', '/interrupt', '/pair/ticket'],
      web: ['/events', '/voice/ack'],
    }
    if (!Object.values(routes).some(r => r.includes(path)) && path !== '/health') return sendJson(res, 404, { ok: false, error: 'not-found' })
    if (path === '/health') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
    if (!routes[caller.role].includes(path)) return sendJson(res, 403, { ok: false, error: 'forbidden' })
    if (path === '/relay/close' && method === 'POST') {
      const b = await readJsonBody(req)
      checkBody(b, ['epoch', 'lease'])
      const s = [...this.subscribers].find(s => s.role === 'relay' && s.clientId === caller.clientId && s.lease === b.lease && b.epoch === this.epoch)
      if (!s) throw httpError(409, 'stale-lease')
      this.closeSubscriber(s)
      return sendJson(res, 200, { ok: true })
    }
    if (path === '/voice/status' && method === 'POST') {
      const b = await readJsonBody(req)
      checkBody(b, ['sessionId'])
      const sessionId = String(b.sessionId)
      if (sessionId !== '' && !validId(sessionId)) throw httpError(400, 'exact-session-required')
      const session = validId(sessionId) ? this.listSessions().find(s => s.id === sessionId) : undefined
      const sessionKnown = session !== undefined
      const questionStateKnown = sessionKnown && session.state !== 'unknown' && typeof session.state === 'string'
      const questionPending = questionStateKnown ? session.state === 'waiting_user' && session.waitKind === 'question' : null
      const owner = sessionKnown ? this.voiceOwners.get(sessionId) : undefined
      const composerMounted = owner !== undefined && !owner.ended && (owner.expires ?? 0) > Date.now()
      const composerReady = composerMounted && questionPending !== true
      const caps = typeof this.capabilities === 'function' ? this.capabilities() : null
      return sendJson(res, 200, {
        ok: true,
        protocol: 'hachimodock-scoped-input-v1',
        epoch: this.epoch,
        sessionId,
        hostReady: true,
        sessionKnown,
        composerReady,
        questionPending,
        questionStateKnown,
        clientBundleAvailable: caps?.clientBundle === true,
        composerMount: composerMounted ? 'paired-connected' : 'unverified',
        scopedInput: { capture: composerReady, insert: composerReady, submit: composerReady },
        capabilities: caps ?? { sessions: false, sessionList: false, liveState: false, events: false, readonlyStatus: false, approval: 'independent-relay' },
        reason: !sessionKnown ? 'exact-session-required' : questionPending ? 'question-pending' : !composerReady ? 'composer-unpaired' : 'ready',
      })
    }
    if (path === '/pair/ticket' && method === 'POST') {
      const b = await readJsonBody(req)
      checkBody(b, ['sessionId', 'origin'])
      if (!this.origins.has(String(b.origin)) || !validId(String(b.sessionId))
        || !this.listSessions().some(s => s.id === b.sessionId)) {
        throw httpError(400, 'exact-pair-target-required')
      }
      this.pairingCode = secret()
      this.pairingExpires = Date.now() + 120_000
      this.pairingAttempts = 0
      this.pairingSessionId = String(b.sessionId)
      this.pairingOrigin = String(b.origin)
      return sendJson(res, 200, { ok: true, epoch: this.epoch, code: this.pairingCode, expiresAtMs: this.pairingExpires })
    }
    if (path === '/voice/ack' && method === 'POST') return this.handleVoiceAck(req, res, caller)
    if (['/voice/begin', '/voice/draft', '/voice/submit'].includes(path) && method === 'POST') return this.handleVoice(req, res, path)

    if (path === '/sessions') {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return this.handleSessions(res)
    }
    if (path === '/sessions/activate') {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return this.handleActivate(req, res)
    }
    if (path === '/inject') {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return this.handleInject(req, res)
    }
    if (path === '/interrupt') {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return this.handleInterrupt(req, res)
    }
    if (path === '/events') {
      if (method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return this.handleEvents(req, res, url, caller)
    }
    if (path === '/approval/decision') {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return this.handleApprovalDecision(req, res, caller)
    }
    sendJson(res, 404, { ok: false, error: 'not-found' })
  }

  /** Answer unexpected route failures. */
  failRequest(res: ServerResponse, error: unknown): void {
    this.log('warn', 'bridge request failed or rejected')
    if (res.headersSent) {
      try {
        res.end()
      } catch {
        /* ignore */
      }
      return
    }
    if (error && typeof error === 'object' && Number.isSafeInteger((error as { status?: number }).status)) {
      const tagged = error as { status: number; code?: string; message?: string }
      sendJson(res, tagged.status, { ok: false, error: tagged.code ?? 'invalid-request', message: String(tagged.message) })
      return
    }
    sendJson(res, 500, { ok: false, error: 'internal', message: 'bridge request failed' })
  }

  private handleSessions(res: ServerResponse): void {
    let sessions: SessionSummaryRow[]
    try {
      sessions = this.listSessions()
    } catch (error) {
      this.log('warn', error)
      sendJson(res, 500, { ok: false, error: 'internal' })
      return
    }
    if (!Array.isArray(sessions)) sessions = []
    sendJson(res, 200, { version: PROTOCOL_VERSION, sessions: sessions.slice(0, 128) })
  }

  /** POST /sessions/activate: fan one device conversation switch to the web client. */
  private async handleActivate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      this.failRequest(res, error)
      return
    }
    checkBody(body, ['sessionId'])
    const sessionId = String(body.sessionId)
    if (!validId(sessionId) || !this.listSessions().some(s => s.id === sessionId)) throw httpError(400, 'exact-session-required')
    if (this.activate) this.activate({ sessionId })
    sendJson(res, 200, { ok: true, sessionId })
  }

  private async handleInterrupt(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (typeof this.capabilities === 'function' && this.capabilities().interrupt !== true) {
      return sendJson(res, 503, { ok: false, error: 'control-contract-unsupported' })
    }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      this.failRequest(res, error)
      return
    }
    checkBody(body, ['sessionId'])
    const sessionId = String(body.sessionId)
    if (!validId(sessionId) || !this.listSessions().some(s => s.id === sessionId)) throw httpError(400, 'exact-session-required')
    try {
      const result = await this.interrupt({ sessionId })
      if (!result || result.ok !== true) {
        sendJson(res, 409, {
          ok: false,
          error: result?.error === 'session-not-found' ? 'session-not-found' : 'interrupt-failed',
          message: String(result?.error ?? 'interrupt failed'),
        })
        return
      }
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: 'interrupt-failed', message: String((error as Error)?.message || error) })
    }
  }

  private async handleInject(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (typeof this.capabilities === 'function' && this.capabilities().backgroundPrompt !== true) {
      return sendJson(res, 503, { ok: false, error: 'control-contract-unsupported' })
    }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      this.failRequest(res, error)
      return
    }
    checkBody(body, ['sessionId', 'text', 'requestId'])
    const sessionId = String(body.sessionId)
    if (!validId(sessionId) || !validId(String(body.requestId)) || !this.listSessions().some(s => s.id === sessionId)) {
      throw httpError(400, 'exact-session-required')
    }
    if (this.activeInjects >= 8 || this.injecting.has(String(body.requestId))) throw httpError(409, 'request-already-used')
    const text = typeof body.text === 'string' ? body.text : ''
    if (text.trim() === '') {
      sendJson(res, 400, { ok: false, error: 'invalid-request', message: 'text must be a non-empty string' })
      return
    }
    if (text.length > MAX_INJECT_TEXT_CHARS) {
      sendJson(res, 400, {
        ok: false,
        error: 'invalid-request',
        message: `text exceeds ${MAX_INJECT_TEXT_CHARS} characters`,
      })
      return
    }

    // Invalid requests must not consume receipts; bounded history may evict
    // completed entries, but never an admission that is still in flight.
    const receipt = { pending: true }
    this.injecting.set(String(body.requestId), receipt)
    for (const [id, retained] of this.injecting) {
      if (this.injecting.size <= 256) break
      if (!retained.pending) this.injecting.delete(id)
    }
    this.activeInjects += 1
    sendSseHeaders(res)
    const controller = new AbortController()
    this.injectControllers.add(controller)
    let deadlineTimer: NodeJS.Timeout | undefined
    let finished = false
    let errored = false
    let doneSent = false
    const keepAlive = setInterval(() => writeSseComment(res, 'keep-alive'), SSE_KEEPALIVE_MS)
    keepAlive.unref?.()
    const stop = (): void => {
      if (finished) return
      finished = true
      clearInterval(keepAlive)
      try {
        res.end()
      } catch {
        /* ignore */
      }
    }
    res.on('close', () => {
      controller.abort()
      finished = true
      clearInterval(keepAlive)
    })
    const emit = (event: Record<string, unknown>): void => {
      if (finished || !event || typeof event !== 'object') return
      switch (event.type) {
        case 'token':
          if (typeof event.text !== 'string' || event.text === '') return
          writeSseFrame(res, { event: 'token', data: { text: boundString(event.text, 4096) } })
          return
        case 'tool':
          writeSseFrame(res, {
            event: 'tool',
            data: {
              name: boundString(event.name, 120) ?? 'tool',
              phase: event.phase === 'end' ? 'end' : 'start',
              ok: event.ok !== false,
            },
          })
          return
        case 'done':
          doneSent = true
          writeSseFrame(res, {
            event: 'done',
            data: {
              sessionId: boundString(event.sessionId, 200) ?? sessionId,
              ...(event.stopReason === 'admitted' ? { stopReason: 'admitted' } : {}),
              tokens: Number.isSafeInteger(event.tokens) && (event.tokens as number) >= 0 ? event.tokens : 0,
            },
          })
          stop()
          return
        case 'error':
          errored = true
          writeSseFrame(res, {
            event: 'error',
            data: {
              code: boundString(event.code, 80) ?? 'inject-failed',
              message: boundString(event.message, 500) ?? 'inject failed',
            },
          })
          stop()
          return
        default:
          return
      }
    }
    writeSseComment(res, 'connected')
    try {
      await Promise.race([
        this.inject({ sessionId, requestId: String(body.requestId), text, emit, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => {
            controller.abort()
            reject(new Error('inject admission timeout; delivery unknown'))
          }, this.injectTimeoutMs)
          deadlineTimer.unref?.()
        }),
      ])
    } catch (error) {
      this.log('warn', error)
      if (!errored) {
        errored = true
        emit({ type: 'error', code: 'inject-failed', message: errorMessage(error) })
      }
    } finally {
      clearTimeout(deadlineTimer)
      this.injectControllers.delete(controller)
      this.activeInjects -= 1
      receipt.pending = false
      if (!doneSent && !errored && !finished) emit({ type: 'done', sessionId, tokens: 0 })
      stop()
    }
  }

  private handleEvents(req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller): void {
    if (this.subscribers.size >= 8 || [...this.subscribers].some(s => s.clientId === caller.clientId)) {
      return sendJson(res, 409, { ok: false, error: 'subscriber-owned' })
    }
    if (caller.role === 'web' && caller.sessionId !== undefined && this.voiceOwners.has(caller.sessionId)) {
      return sendJson(res, 409, { ok: false, error: 'session-owned' })
    }
    const afterParam = url.searchParams.get('after') ?? (req.headers['last-event-id'] as string | undefined) ?? null
    let after: number | null = null
    if (afterParam !== null) {
      const parts = afterParam.split(':')
      if (parts.length !== 3 || parts[0] !== this.epoch || parts[1] !== caller.clientId) {
        return sendJson(res, 409, { ok: false, error: 'stale-cursor' })
      }
      const parsed = Number(parts[2])
      if (!Number.isSafeInteger(parsed) || parsed < 0) {
        sendJson(res, 400, { ok: false, error: 'invalid-after', message: 'after must be a non-negative integer' })
        return
      }
      after = parsed
    }
    const subscriber: Subscriber = {
      res,
      ended: false,
      ...caller,
      lease: secret(),
    }
    res.setHeader('x-hachimodock-lease', subscriber.lease)
    sendSseHeaders(res)
    this.subscribers.add(subscriber)
    if (subscriber.role === 'web' && subscriber.sessionId !== undefined) this.voiceOwners.set(subscriber.sessionId, subscriber)
    const keepAlive = setInterval(() => {
      if (subscriber.expires !== undefined && subscriber.expires <= Date.now() || !writeSseComment(res, 'keep-alive')) this.closeSubscriber(subscriber)
    }, SSE_KEEPALIVE_MS)
    keepAlive.unref?.()
    res.on('close', () => {
      clearInterval(keepAlive)
      this.closeSubscriber(subscriber)
    })
    try {
      if (after !== null) {
        for (const event of this.events) {
          if (event.seq > after && !event.type.startsWith('approval') && !event.type.startsWith('voice-')) this.writeToSubscriber(subscriber, event)
        }
      }
      writeSseComment(res, 'connected')
    } catch (error) {
      this.log('warn', error)
      this.closeSubscriber(subscriber)
      clearInterval(keepAlive)
    }
  }

  private async handleApprovalDecision(req: IncomingMessage, res: ServerResponse, caller: Caller): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      this.failRequest(res, error)
      return
    }
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
    const decision = body.decision
    if (requestId === '' || (decision !== 'allow' && decision !== 'deny')) {
      sendJson(res, 400, {
        ok: false,
        error: 'invalid-request',
        message: 'requestId must be a string and decision must be "allow" or "deny"',
      })
      return
    }
    checkBody(body, ['requestId', 'decision', 'epoch', 'lease', 'sessionId'])
    const result = this.decideApproval(requestId, decision, caller, body as { epoch?: unknown; sessionId?: unknown; lease?: unknown })
    if (result.ok) {
      sendJson(res, 200, result)
      return
    }
    sendJson(res, 409, result)
  }
}

function validId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 && v !== 'auto' && !/[\r\n\0]/.test(v)
}

function checkBody(b: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(b).some(k => !keys.includes(k))) throw httpError(400, 'unknown-field')
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
