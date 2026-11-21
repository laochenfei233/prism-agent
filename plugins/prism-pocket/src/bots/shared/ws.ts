/**
 * Reconnecting WebSocket for the outbound bot channels: capped exponential
 * backoff, reset on a successful open, and a heartbeat timer the adapter
 * arms per platform. `connect` runs per attempt — platforms that mint
 * one-time or short-lived URLs (Slack Socket Mode, DingTalk and Feishu
 * stream tickets, QQ gateways) re-mint inside it. IO only — every frame
 * transformation stays in the adapter's pure functions.
 *
 * @module @prism/prism-pocket/bots/shared
 */

/** First reconnect delay. */
const BACKOFF_BASE_MS = 1000

/** Reconnect delay ceiling. */
const BACKOFF_MAX_MS = 60_000

/** Hooks the adapter installs on one managed socket. */
export interface ManagedWsHooks {
  /** The socket opened; heartbeats and logins arm from here. */
  onOpen(socket: ManagedWs): void
  /** One frame arrived: text frames as strings, binary frames as bytes. */
  onMessage(data: string | Uint8Array): void
  /** The socket closed; `scheduled` tells whether a reconnect is pending. */
  onClosed(scheduled: boolean): void
  /** The socket errored. */
  onError(detail: string): void
}

/** The managed socket: send plus explicit close semantics. */
export interface ManagedWs {
  /** Send one text frame; failures surface through {@link ManagedWsHooks.onError}. */
  send(text: string): void
  /** Close without scheduling a reconnect (the adapter is stopping). */
  close(): void
}

/** Build one fresh WebSocket; the URL may be re-minted per attempt. */
export type WsConnect = () => WebSocket | Promise<WebSocket>

/**
 * A WebSocket that reconnects with capped exponential backoff until
 * {@link ManagedWs.close} or {@link ReconnectingWs.stop} stops it.
 */
export class ReconnectingWs {
  private socket: WebSocket | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private attempt = 0
  private stopping = false
  private connecting = false
  /** Rejects sockets dialed by a superseded attempt (slow mint racing a stop). */
  private generation = 0

  /**
   * @param connect - builds one fresh WebSocket; awaited when it returns a promise.
   * @param hooks - the adapter's IO hooks.
   * @param heartbeatMs - heartbeat interval, when the platform requires one.
   * @param onHeartbeat - heartbeat tick callback, when armed.
   */
  constructor(
    private readonly connect: WsConnect,
    private readonly hooks: ManagedWsHooks,
    private readonly heartbeatMs?: number,
    private readonly onHeartbeat?: () => void,
  ) {}

  /** Open the first connection. */
  start(): void {
    this.stopping = false
    void this.dial()
  }

  /** Stop reconnecting and close any open socket. */
  stop(): void {
    this.stopping = true
    this.generation += 1
    this.clearTimers()
    this.socket?.close()
    this.socket = undefined
  }

  /** Send one text frame on the current socket, when open. */
  send(text: string): void {
    this.socket?.send(text)
  }

  /** Whether a socket is currently open. */
  get open(): boolean {
    return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN
  }

  /** Clear the pending reconnect timer and the heartbeat. */
  clearTimers(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  /** One dial attempt: mint, guard the generation, wire the listeners. */
  private async dial(): Promise<void> {
    if (this.stopping || this.connecting) return
    this.connecting = true
    const gen = ++this.generation
    let socket: WebSocket
    try {
      socket = await this.connect()
    } catch (cause: unknown) {
      this.connecting = false
      if (this.stopping || gen !== this.generation) return
      this.hooks.onError(cause instanceof Error ? cause.message : String(cause))
      this.scheduleReconnect()
      return
    }
    if (this.stopping || gen !== this.generation) {
      this.connecting = false
      socket.close()
      return
    }
    this.connecting = false
    this.socket = socket
    this.wire(socket)
  }

  /** Attach the lifecycle listeners of one accepted socket. */
  private wire(socket: WebSocket): void {
    socket.addEventListener('open', () => {
      if (this.socket !== socket) return
      this.attempt = 0
      if (this.heartbeatMs !== undefined && this.onHeartbeat !== undefined) {
        this.heartbeat = setInterval(this.onHeartbeat, this.heartbeatMs)
      }
      this.hooks.onOpen(this.wrap(socket))
    })
    socket.addEventListener('message', (event: MessageEvent) => {
      if (this.socket !== socket) return
      if (typeof event.data === 'string') {
        this.hooks.onMessage(event.data)
        return
      }
      if (event.data instanceof ArrayBuffer) this.hooks.onMessage(new Uint8Array(event.data))
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.clearTimers()
      const scheduled = !this.stopping
      if (scheduled) this.scheduleReconnect()
      this.hooks.onClosed(scheduled)
    })
    socket.addEventListener('error', () => {
      if (this.socket !== socket) return
      this.hooks.onError('connection error')
    })
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.timer !== undefined) return
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt)
    this.attempt += 1
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.dial()
    }, delay)
  }

  private wrap(socket: WebSocket): ManagedWs {
    return {
      send: (text) => { socket.send(text) },
      close: () => {
        this.stopping = true
        this.generation += 1
        this.clearTimers()
        socket.close()
        this.socket = undefined
      },
    }
  }
}

/** Default give-up deadline for {@link waitForSocketReady}. */
export const READY_TIMEOUT_MS = 15_000

/** Default predicate poll interval for {@link waitForSocketReady}. */
export const READY_POLL_MS = 250

/** Labels and timing for one {@link waitForSocketReady} wait. */
export interface SocketReadyOptions {
  /** Bot channel whose socket is awaited, e.g. `discord`. */
  channel: string
  /**
   * What the predicate waits for, phrased as the timeout message's subject
   * with its verb, e.g. `gateway READY did not arrive`.
   */
  awaited: string
  /** Give-up deadline; defaults to {@link READY_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Predicate poll interval; defaults to {@link READY_POLL_MS}. */
  pollMs?: number
}

/**
 * The rejection {@link waitForSocketReady} settles with when the deadline
 * lapses: `channel` and `awaited` name the failing site, `timeoutMs` the
 * elapsed deadline. The message keeps the adapters' historical form,
 * `<awaited> within <seconds>s`.
 */
export class SocketReadyTimeoutError extends Error {
  constructor(
    public readonly channel: string,
    public readonly awaited: string,
    public readonly timeoutMs: number,
  ) {
    super(`${awaited} within ${Math.round(timeoutMs / 1000)}s`)
    this.name = 'SocketReadyTimeoutError'
  }
}

/**
 * Poll `predicate` until it turns true — the bounded wait the ws adapters
 * run after `ReconnectingWs.start()` for READY or login state. The predicate
 * is checked before the deadline on every tick, so an early success never
 * waits for the deadline to be exceeded first.
 *
 * @param predicate - polled each tick; resolves the wait once it returns true.
 * @param options - channel and awaited labels plus optional timing overrides.
 * @returns A promise that resolves once `predicate` returns true and rejects
 *   with {@link SocketReadyTimeoutError} after `timeoutMs`.
 */
export function waitForSocketReady(predicate: () => boolean, options: SocketReadyOptions): Promise<void> {
  const timeoutMs = options.timeoutMs ?? READY_TIMEOUT_MS
  const pollMs = options.pollMs ?? READY_POLL_MS
  return new Promise<void>((resolve, reject) => {
    const began = Date.now()
    const check = setInterval(() => {
      if (predicate()) {
        clearInterval(check)
        resolve()
      } else if (Date.now() - began > timeoutMs) {
        clearInterval(check)
        reject(new SocketReadyTimeoutError(options.channel, options.awaited, timeoutMs))
      }
    }, pollMs)
  })
}
