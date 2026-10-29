/**
 * Wire and engine types of the cross-agent Session import. Every value here is
 * plain JSON so the Host route and the settings page share one declaration.
 *
 * @module @deepseek-ai/dsh-session-import/types
 */

/** Foreign conversation stores this feature can read. */
export type ImportSourceId =
  | 'claude'
  | 'codex'
  | 'grok'
  | 'dsh'
  | 'mimocode'
  | 'opencode'
  | 'openclaw'
  | 'hermes'
  | 'pi'
  | 'gemini'

/** One user prompt or assistant reply normalized from a foreign transcript. */
export interface ImportedMessage {
  /** Speaker of the message. */
  readonly role: 'user' | 'assistant'
  /** Plain text content; tool, reasoning, and synthetic blocks are absent. */
  readonly text: string
  /** Unix epoch milliseconds. */
  readonly time: number
}

/** One normalized conversation read from a foreign store. */
export interface ImportedSession {
  /** Stable identifier within the source store. */
  readonly key: string
  /** Store the conversation came from. */
  readonly source: ImportSourceId
  /** Title recorded by the source, when it keeps one. */
  readonly title?: string
  /** Absolute working directory recorded by the source. */
  readonly cwd?: string
  /** Unix epoch milliseconds of the first message. */
  readonly createdAt: number
  /** Unix epoch milliseconds of the last message. */
  readonly updatedAt: number
  /** Model id recorded for assistant replies, when the source keeps one. */
  readonly model?: string
  /** Conversation messages in source order. */
  readonly messages: readonly ImportedMessage[]
}

/** Discovered metadata that planning can read without parsing a transcript. */
export interface ImportedSessionMeta {
  /** Stable identifier within the source store. */
  readonly key: string
  /** Title recorded by the source, when it keeps one. */
  readonly title?: string
  /** Absolute working directory recorded by the source. */
  readonly cwd?: string
  /** Unix epoch milliseconds of the first message. */
  readonly createdAt: number
  /** Unix epoch milliseconds of the last message. */
  readonly updatedAt: number
  /** Message count when the source index carries one. */
  readonly messageCount?: number
  /** Approximate stored bytes for this session. */
  readonly bytes?: number
}

/** One discovered session plus the reader that materializes its transcript. */
export interface ScannedSession {
  /** Metadata shown by discovery and planning. */
  readonly meta: ImportedSessionMeta
  /** Read the normalized transcript. */
  readonly load: () => Promise<ImportedSession>
}

/** Result of scanning one source root. */
export interface ScannedSource {
  /** Sessions found under the root, in source order. */
  readonly sessions: readonly ScannedSession[]
  /** Sessions the reader found but could not parse. */
  readonly skipped?: readonly SourceSkip[]
}

/** A session a reader refused before planning. */
export interface SourceSkip {
  /** Stable source identifier. */
  readonly key: string
  /** Why the session cannot be imported. */
  readonly reason: string
}

/** Why an unavailable source cannot be scanned. */
export type ImportUnavailableReason = 'not-found' | 'current-home' | 'scan-failed'

/** Availability and size summary for one source. */
export interface SourceCandidate {
  /** Supported store id. */
  readonly id: ImportSourceId
  /** Display name of the store. */
  readonly label: string
  /** Absolute root that was inspected. */
  readonly root: string
  /** Whether the root exists and can be listed. */
  readonly available: boolean
  /** Reason code for an unavailable source. */
  readonly reason?: ImportUnavailableReason
  /** Number of importable sessions found. */
  readonly sessionCount: number
  /** Total bytes of the underlying artifacts, when cheaply known. */
  readonly bytes: number
  /** Latest session activity in Unix epoch milliseconds. */
  readonly latestAt?: number
}

/** Plan request for one source. */
export interface ImportPlanRequest {
  /** Source store to read. */
  readonly source: ImportSourceId
  /** Sessions to include; omitted means every discovered session. */
  readonly sessionIds?: readonly string[]
}

/** One session inside a planned project group. */
export interface PlanSession {
  /** Stable source identifier. */
  readonly key: string
  /** Title recorded by the source, when it keeps one. */
  readonly title?: string
  /** Unix epoch milliseconds of the first message. */
  readonly createdAt: number
  /** Unix epoch milliseconds of the last message. */
  readonly updatedAt: number
  /** Message count when the source index carries one. */
  readonly messageCount?: number
}

/** Planned sessions sharing one working folder. */
export interface PlanGroup {
  /** Canonical working folder; absent for sessions without a usable cwd. */
  readonly path?: string
  /** Workspace title that apply would use. */
  readonly title?: string
  /** Sessions assigned to this group. */
  readonly sessions: readonly PlanSession[]
  /** Existing workspace that would receive the sessions. */
  readonly existingWorkspace?: {
    /** Stored workspace id. */
    readonly id: string
    /** Current workspace title. */
    readonly title: string
    /** Current member count. */
    readonly sessionCount: number
  }
  /** Whether apply needs explicit merge confirmation for this group. */
  readonly merge: boolean
}

/** A discovered session excluded from the plan. */
export interface ImportSkip {
  /** Stable source identifier. */
  readonly key: string
  /** Why the session is not planned. */
  readonly reason: string
}

/** Dry-run description of one import. */
export interface ImportPlan {
  /** Source store the plan was computed from. */
  readonly source: ImportSourceId
  /** Groups of sessions by working folder. */
  readonly groups: readonly PlanGroup[]
  /** Sessions excluded before apply. */
  readonly skipped: readonly ImportSkip[]
}

/** Apply request for one source. */
export interface ImportApplyRequest {
  /** Source store to read. */
  readonly source: ImportSourceId
  /** Sessions to import. */
  readonly sessionIds: readonly string[]
  /** Explicit acknowledgement of every planned merge into an existing project. */
  readonly confirmMerge?: boolean
}

/** Outcome of one session write. */
export type ImportOutcome = 'imported' | 'duplicate' | 'skipped' | 'failed'

/** Result of one session write. */
export interface ImportApplyEntry {
  /** Stable source identifier. */
  readonly key: string
  /** Whether the conversation was written, already present, skipped, or failed. */
  readonly outcome: ImportOutcome
  /** Durable DSH session id, when one exists after the call. */
  readonly sessionId?: string
  /** Failure or skip detail. */
  readonly reason?: string
}

/** Result of applying one project group. */
export interface ImportWorkspaceOutcome {
  /** Canonical working folder. */
  readonly path: string
  /** Workspace that received the imported sessions. */
  readonly workspaceId: string
  /** Whether apply created the workspace. */
  readonly created: boolean
  /** Number of sessions imported into this workspace by this call. */
  readonly imported: number
}

/** Complete apply result. */
export interface ImportApplyResult {
  /** One entry per requested session, in request order. */
  readonly results: readonly ImportApplyEntry[]
  /** Workspaces that received at least one imported session. */
  readonly workspaces: readonly ImportWorkspaceOutcome[]
}

/** Structured route or engine failure. */
export interface ImportFailureBody {
  /** Stable machine-readable failure code. */
  readonly code: ImportFailureCode
  /** Human-readable detail safe to show in the settings page. */
  readonly message: string
}

/** Failure codes shared by the route and the engine. */
export type ImportFailureCode =
  | 'invalid-request'
  | 'unknown-source'
  | 'source-unavailable'
  | 'merge-confirmation-required'
  | 'import-failed'
