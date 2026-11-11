/**
 * Structural types for the HachimoDock bridge. Everything the bridge reads
 * from the host stays duck-typed: the plugin ships without workspace type
 * dependencies and loads on any profile that provides the session trio.
 *
 * @module @prism/prism-hachimodock/types
 */

/** The live session store surface the bridge consumes. */
export interface SessionLike {
  /** Stable session id; the bridge rejects ids outside 1..200 printable chars. */
  readonly id: string
  /** Monotonic append cursor; the state contract correlates events against it. */
  readonly seq?: number
  /** Session header with creation time and working directory. */
  readonly header?: {
    readonly createdAt?: number
    readonly cwd?: string
  }
}

/** One committed live session event. */
export interface SessionEventLike {
  /** Discriminant tag, e.g. `turn/start` or `tool/call`. */
  readonly type: string
  /** Append position; `event.seq === session.seq - 1` gates acceptance. */
  readonly seq?: number
  /** Wall-clock commit time in milliseconds. */
  readonly time?: number
  /** Event payload as committed. */
  readonly data?: Record<string, unknown> | null
}

/** Logger facade that never breaks the bridge. */
export interface LoggerLike {
  info?(detail: unknown): void
  warn?(detail: unknown): void
  error?(detail: unknown): void
}

/** Agent registry snapshot surface. */
export interface AgentRegistryLike {
  get?(sessionId: string): { status?: string; session?: unknown } | undefined
}

/** Session control surface used by `/inject` and `/interrupt`. */
export interface SessionControllerLike {
  prompt?(
    request: { requestId: string; sessionId: string; mode: 'queue'; content: Array<{ type: 'text'; text: string }> },
    signal?: AbortSignal,
  ): Promise<{ accepted?: boolean } | undefined>
  cancel?(request: { sessionId: string }): Promise<{ accepted?: boolean } | undefined> | { accepted?: boolean } | undefined
}

/** Session-title and projection readers, both optional host services. */
export interface TitleReaderLike {
  get?(session: SessionLike): { title?: string } | undefined
}

export interface ProjectionsLike {
  stateOf?(session: SessionLike, key: string): unknown
}

/**
 * The host context surface the bridge reads. Every member is optional because
 * unsupported services disable the affected feature instead of failing the
 * profile.
 */
export interface BridgeContextLike {
  readonly sessions?: { get?(sessionId: string): SessionLike | undefined; list?(): SessionLike[] | null }
  readonly agents?: AgentRegistryLike
  readonly sessionController?: SessionControllerLike
  readonly logger?: LoggerLike
  /** Cordis event subscription; returns a disposer when supported. */
  on?(event: string, listener: (...args: never[]) => unknown): unknown
  /** Public optional-service lookup. */
  get?(name: string): unknown
}

/** Resolved bridge options. */
export interface BridgeOptions {
  /** Loopback port; 0 binds a free port and records the result in the descriptor. */
  readonly port: number
  readonly approvalTimeoutMs: number
  readonly approvalFallback: 'unavailable' | 'delegate'
  readonly injectTimeoutMs: number
  readonly maxInjectTokenChars: number
  readonly allowedOrigins: readonly string[]
  readonly bootstrapFile?: string
  readonly writeBootstrap: boolean
}

/** One compact session summary served by `GET /sessions` and `/events`. */
export interface SessionSummary {
  readonly id: string
  readonly title: string | null
  readonly cwd: string | null
  readonly lastModified: number
  readonly status: 'idle' | 'running' | 'unknown'
  readonly active: boolean | null
  readonly activitySource: string | null
  readonly stateDetailUnknown: boolean
  readonly state: string
  readonly waitKind: string | null
  readonly epoch: string | null
  readonly sourceSeq: number | null
  readonly stateContract: string
  readonly displayContent: string
  readonly transitionRevision: number
  readonly agentId: string
}
