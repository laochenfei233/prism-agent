/**
 * Import engine: discovers foreign stores, plans one import without writing,
 * and writes each selected conversation as a durable DSH session.
 *
 * The engine writes through `SessionPersistence` and registers projects through
 * `WorkspaceRegistry`; it never edits persisted files directly.
 *
 * @module @prism/prism-session-import/engine
 */

import { createHash, randomUUID } from 'node:crypto'
import { cp } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import {
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
  type SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { AssistantMessage, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session-title'
import { SOURCE_READERS } from './sources/index.ts'
import { canonicalPath, isDirectory, messageOf as errorText, truncateUtf8 } from './sources/shared.ts'
import { SOURCE_DEFINITIONS, defaultRoot, definitionOf } from './catalog.ts'
import type {
  ImportApplyEntry,
  ImportApplyRequest,
  ImportApplyResult,
  ImportFailureCode,
  ImportPlan,
  ImportPlanRequest,
  ImportSourceId,
  ImportWorkspaceOutcome,
  ImportedMessage,
  ImportedSession,
  PlanGroup,
  PlanSession,
  ScannedSession,
  SourceCandidate,
} from './types.ts'

/** Write handle surface the engine appends one conversation through. */
export interface ImportSessionHandle {
  /** Append the conversation's contiguous event batch. */
  append(events: readonly SessionEvent[]): Promise<void>
  /** Make the batch durable. */
  flush(): Promise<void>
  /** Release write ownership. */
  close(): Promise<void>
}

/** Session writer surface used by the engine. */
export interface ImportPersistence {
  /** Whether a session id already exists. */
  stat(id: SessionId): Promise<unknown>
  /** Create one stored session and take write ownership. */
  create(header: SessionHeader): Promise<ImportSessionHandle>
}

/** One workspace surface used for project registration. */
export interface ImportWorkspace {
  /** Stored workspace id. */
  readonly id: string
  /** Display title. */
  readonly title: string
  /** Currently accounted sessions. */
  readonly sessionIds: readonly unknown[]
  /** Add one session to this workspace's account. */
  attachSession(id: SessionId): Promise<void>
}

/** Workspace registry surface used by the engine. */
export interface ImportWorkspaces {
  /** Find the workspace for a canonical path. */
  resolveByPath(path: string): Promise<ImportWorkspace | undefined>
  /** Create or return the workspace for a canonical path. */
  create(path: string): Promise<ImportWorkspace>
}

/**
 * Projection-cache fold that makes one written log readable as a cold list
 * row. The list serves a stored Session from its checkpoint alone, so a log
 * written outside the live Session lifecycle would otherwise list without its
 * title.
 */
export interface ImportProjections {
  /**
   * Fold one complete stored log into the durable projection cache.
   * @param header - the stored Session header (identity witness for the record).
   * @param events - the Session's complete log in seq order.
   * @returns resolution after the checkpoint is readable by the cold list.
   */
  checkpoint(header: SessionHeader, events: readonly SessionEvent[]): Promise<void>
}

/** Engine dependencies supplied by the Host plugin. */
export interface SessionImportEngineOptions {
  /** Durable session writer. */
  readonly persistence: ImportPersistence
  /** Live workspace registry. */
  readonly workspaces: ImportWorkspaces
  /** Current harness home, excluded from the DeepSeek Harness source. */
  readonly currentHome: string
  /** Per-source root overrides. */
  readonly roots: Partial<Record<ImportSourceId, string>>
  /** Retained message count per conversation. */
  readonly maxMessages: number
  /** UTF-8 byte budget for one message. */
  readonly maxMessageTextBytes: number
  /** Cold-list projection fold; absent compositions list rows without cached projections. */
  readonly projections?: ImportProjections
}

/** Typed engine refusal mapped onto a route status. */
export class ImportEngineError extends Error {
  /** Stable failure code. */
  readonly code: ImportFailureCode

  /**
   * @param code - stable failure code.
   * @param message - human-readable detail.
   */
  constructor(code: ImportFailureCode, message: string) {
    super(message)
    this.name = 'ImportEngineError'
    this.code = code
  }
}

/** Pure import planning and writing. */
export class SessionImportEngine {
  private attachmentsCopied = false

  /**
   * @param options - persistence, workspace registry, roots, and limits.
   */
  constructor(private readonly options: SessionImportEngineOptions) {}

  /**
   * Discover every supported source.
   * @returns one candidate per source, including unavailable ones.
   */
  async candidates(): Promise<SourceCandidate[]> {
    const candidates: SourceCandidate[] = []
    for (const definition of SOURCE_DEFINITIONS) {
      const root = this.rootOf(definition.id)
      const unavailable = await this.unavailableReason(definition.id, root)
      if (unavailable !== undefined) {
        candidates.push({
          id: definition.id,
          label: definition.label,
          root,
          available: false,
          reason: unavailable,
          sessionCount: 0,
          bytes: 0,
        })
        continue
      }
      try {
        const scanned = await SOURCE_READERS[definition.id].scan(root)
        let bytes = 0
        let latestAt = 0
        for (const session of scanned.sessions) {
          bytes += session.meta.bytes ?? 0
          latestAt = Math.max(latestAt, session.meta.updatedAt)
        }
        candidates.push({
          id: definition.id,
          label: definition.label,
          root,
          available: true,
          sessionCount: scanned.sessions.length,
          bytes,
          ...(latestAt > 0 ? { latestAt } : {}),
        })
      } catch {
        candidates.push({
          id: definition.id,
          label: definition.label,
          root,
          available: false,
          reason: 'scan-failed',
          sessionCount: 0,
          bytes: 0,
        })
      }
    }
    return candidates
  }

  /**
   * Compute one import without writing anything.
   * @param request - source and optional session selection.
   * @returns groups by working folder plus skipped sessions.
   */
  async plan(request: ImportPlanRequest): Promise<ImportPlan> {
    const definition = definitionOf(request.source)
    if (definition === undefined) throw new ImportEngineError('unknown-source', `Unknown source: ${request.source}`)
    const root = this.rootOf(request.source)
    const unavailable = await this.unavailableReason(request.source, root)
    if (unavailable !== undefined) throw new ImportEngineError('source-unavailable', unavailable)
    const scanned = await SOURCE_READERS[request.source].scan(root)
    const selected = this.select(scanned.sessions, request.sessionIds)
    const skipped = [
      ...(scanned.skipped ?? []).map(entry => ({ key: entry.key, reason: entry.reason })),
      ...selected.missing.map(key => ({ key, reason: 'session not found in source' })),
    ]
    const groups = new Map<string, { path?: string; sessions: PlanSession[] }>()
    for (const session of selected.sessions) {
      const cwd = await this.usableCwd(session.meta.cwd)
      const key = cwd ?? ''
      let group = groups.get(key)
      if (group === undefined) {
        group = { ...(cwd === undefined ? {} : { path: cwd }), sessions: [] }
        groups.set(key, group)
      }
      group.sessions.push({
        key: session.meta.key,
        ...(session.meta.title === undefined ? {} : { title: session.meta.title }),
        createdAt: session.meta.createdAt,
        updatedAt: session.meta.updatedAt,
        ...(session.meta.messageCount === undefined ? {} : { messageCount: session.meta.messageCount }),
      })
    }
    const planned: PlanGroup[] = []
    for (const group of groups.values()) {
      const existing = group.path === undefined
        ? undefined
        : await this.options.workspaces.resolveByPath(group.path)
      planned.push({
        ...(group.path === undefined ? {} : { path: group.path }),
        ...(group.path === undefined ? {} : { title: group.path.split(/[\\/]/).at(-1) ?? group.path }),
        sessions: group.sessions,
        ...(existing === undefined ? {} : {
          existingWorkspace: {
            id: existing.id,
            title: existing.title,
            sessionCount: existing.sessionIds.length,
          },
        }),
        merge: existing !== undefined,
      })
    }
    planned.sort((left, right) => (left.path ?? '').localeCompare(right.path ?? ''))
    return { source: request.source, groups: planned, skipped }
  }

  /**
   * Write the selected conversations and register their projects.
   * @param request - source, session selection, and merge confirmation.
   * @returns one entry per requested session plus workspace outcomes.
   */
  async apply(request: ImportApplyRequest): Promise<ImportApplyResult> {
    const plan = await this.plan({ source: request.source, sessionIds: request.sessionIds })
    const requested = new Set(request.sessionIds)
    if (request.confirmMerge !== true
      && await this.mergeConfirmationRequired(request.source, plan, requested)) {
      throw new ImportEngineError(
        'merge-confirmation-required',
        'Some sessions belong to projects that already exist; confirm the merge before importing.',
      )
    }
    const byKey = new Map<string, ScannedSession>()
    for (const session of (await SOURCE_READERS[request.source].scan(this.rootOf(request.source))).sessions) {
      if (requested.has(session.meta.key)) byKey.set(session.meta.key, session)
    }
    const groupOf = new Map<string, PlanGroup>()
    for (const group of plan.groups) {
      for (const session of group.sessions) groupOf.set(session.key, group)
    }
    const skipReason = new Map(plan.skipped.map(entry => [entry.key, entry.reason]))
    const results: ImportApplyEntry[] = []
    const workspaces = new Map<string, ImportWorkspaceOutcome>()
    const openWorkspaces = new Map<string, Promise<ImportWorkspace>>()
    const workspaceFor = (path: string): Promise<ImportWorkspace> => {
      let workspace = openWorkspaces.get(path)
      if (workspace === undefined) {
        workspace = this.options.workspaces.create(path)
        openWorkspaces.set(path, workspace)
      }
      return workspace
    }
    for (const key of request.sessionIds) {
      const session = byKey.get(key)
      const group = groupOf.get(key)
      if (session === undefined || group === undefined) {
        results.push({ key, outcome: 'skipped', reason: skipReason.get(key) ?? 'not planned' })
        continue
      }
      try {
        const entry = await this.writeOne(request.source, session, group, workspaceFor, workspaces)
        results.push(entry)
      } catch (error: unknown) {
        results.push({ key, outcome: 'failed', reason: errorText(error) })
      }
    }
    return { results, workspaces: [...workspaces.values()] }
  }

  /** Whether a new session would be added to a project the user already owns. */
  private async mergeConfirmationRequired(
    source: ImportSourceId,
    plan: ImportPlan,
    requested: ReadonlySet<string>,
  ): Promise<boolean> {
    for (const group of plan.groups) {
      if (!group.merge) continue
      for (const session of group.sessions) {
        if (!requested.has(session.key)) continue
        const id = source === 'dsh'
          ? brandString<SessionId>(session.key)
          : this.sessionIdFor(source, session.key)
        if ((await this.options.persistence.stat(id)) === undefined) return true
      }
    }
    return false
  }

  /** Write one session, returning its outcome without throwing for row-level failures. */
  private async writeOne(
    source: ImportSourceId,
    session: ScannedSession,
    group: PlanGroup,
    workspaceFor: (path: string) => Promise<ImportWorkspace>,
    workspaces: Map<string, ImportWorkspaceOutcome>,
  ): Promise<ImportApplyEntry> {
    if (session.loadNative !== undefined) {
      return this.writeNative(session, group, workspaceFor, workspaces)
    }
    const key = session.meta.key
    const id = this.sessionIdFor(source, key)
    if ((await this.options.persistence.stat(id)) !== undefined) {
      return { key, outcome: 'duplicate', sessionId: id }
    }
    const imported = await session.load()
    const messages = this.normalize(imported.messages)
    if (!messages.some(message => message.role === 'user')) {
      return { key, outcome: 'skipped', reason: 'no user message text' }
    }
    const cwd = group.path
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: imported.createdAt > 0 ? imported.createdAt : Date.now(),
      ...(cwd === undefined ? {} : { cwd }),
      isSeeded: false,
      delegationDepth: 0,
    }
    const events = this.eventsOf(imported, messages)
    const handle = await this.options.persistence.create(header)
    try {
      await handle.append(events)
      await handle.flush()
    } finally {
      await handle.close()
    }
    return this.finish(key, header, events, group, workspaceFor, workspaces)
  }

  /** Copy a DSH-compatible log without rewriting its events. */
  private async writeNative(
    session: ScannedSession,
    group: PlanGroup,
    workspaceFor: (path: string) => Promise<ImportWorkspace>,
    workspaces: Map<string, ImportWorkspaceOutcome>,
  ): Promise<ImportApplyEntry> {
    const key = session.meta.key
    const native = await session.loadNative?.()
    if (native === undefined) return { key, outcome: 'failed', reason: 'native reader unavailable' }
    const id = native.header.id
    if ((await this.options.persistence.stat(id)) !== undefined) {
      return { key, outcome: 'duplicate', sessionId: id }
    }
    await this.copyAttachments()
    const cwd = group.path ?? native.header.cwd
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: native.header.createdAt,
      ...(cwd === undefined ? {} : { cwd }),
      isSeeded: false,
      delegationDepth: 0,
    }
    const handle = await this.options.persistence.create(header)
    try {
      await handle.append(native.events)
      await handle.flush()
    } finally {
      await handle.close()
    }
    return this.finish(key, header, native.events, group, workspaceFor, workspaces)
  }

  /**
   * Finish one written Session: publish the log to the cold list, then
   * register its project. Both steps report a row-level failure instead of
   * failing an import whose log is already durable.
   * @param key - source session key reported to the caller.
   * @param header - the stored Session header.
   * @param events - the Session's complete log in seq order.
   * @param group - the planned project for this Session.
   * @param workspaceFor - per-path workspace creation memo.
   * @param workspaces - workspace outcomes accumulated for the response.
   * @returns the imported row with any contained failure text.
   */
  private async finish(
    key: string,
    header: SessionHeader,
    events: readonly SessionEvent[],
    group: PlanGroup,
    workspaceFor: (path: string) => Promise<ImportWorkspace>,
    workspaces: Map<string, ImportWorkspaceOutcome>,
  ): Promise<ImportApplyEntry> {
    const reasons = [
      await this.checkpoint(header, events),
      await this.attachProject(header.id, group, workspaceFor, workspaces),
    ].filter((reason): reason is string => reason !== undefined)
    return {
      key,
      outcome: 'imported',
      sessionId: header.id,
      ...(reasons.length === 0 ? {} : { reason: reasons.join('; ') }),
    }
  }

  /**
   * Publish one written log to the cold-list projection cache. The log is the
   * authority and the cache is derived, so a fold failure costs only the row's
   * title until its next open and never fails the import.
   * @param header - the stored Session header.
   * @param events - the Session's complete log in seq order.
   * @returns the row-level failure text, or `undefined` on success.
   */
  private async checkpoint(
    header: SessionHeader,
    events: readonly SessionEvent[],
  ): Promise<string | undefined> {
    const projections = this.options.projections
    if (projections === undefined) return undefined
    try {
      await projections.checkpoint(header, events)
      return undefined
    } catch (error: unknown) {
      return `session imported, list title unavailable: ${errorText(error)}`
    }
  }

  /** Register one written session under its canonical project folder. */
  private async attachProject(
    id: SessionId,
    group: PlanGroup,
    workspaceFor: (path: string) => Promise<ImportWorkspace>,
    workspaces: Map<string, ImportWorkspaceOutcome>,
  ): Promise<string | undefined> {
    const cwd = group.path
    if (cwd === undefined) return undefined
    try {
      const workspace = await workspaceFor(cwd)
      await workspace.attachSession(id)
      const existing = workspaces.get(cwd)
      workspaces.set(cwd, {
        path: cwd,
        workspaceId: workspace.id,
        created: existing?.created ?? group.existingWorkspace === undefined,
        imported: (existing?.imported ?? 0) + 1,
      })
      return undefined
    } catch (error: unknown) {
      return `session imported, project registration failed: ${errorText(error)}`
    }
  }

  /** Copy the source home's attachment store once for natively imported sessions. */
  private async copyAttachments(): Promise<void> {
    if (this.attachmentsCopied) return
    const source = join(dirname(this.rootOf('dsh')), 'attachments')
    if (!(await isDirectory(source))) {
      this.attachmentsCopied = true
      return
    }
    try {
      await cp(source, join(this.options.currentHome, 'attachments'), {
        recursive: true,
        force: false,
        errorOnExist: false,
      })
      this.attachmentsCopied = true
    } catch (error: unknown) {
      throw new ImportEngineError('import-failed', `attachment copy failed: ${errorText(error)}`)
    }
  }

  /** Normalize, bound, and merge raw messages into alternating turns. */
  private normalize(all: readonly ImportedMessage[]): ImportedMessage[] {
    const bounded = all.slice(-this.options.maxMessages)
    const firstUser = bounded.findIndex(message => message.role === 'user')
    const usable = firstUser < 0 ? [] : bounded.slice(firstUser)
    const result: ImportedMessage[] = []
    for (const message of usable) {
      const text = this.truncate(message.text)
      if (text.length === 0) continue
      const previous = result.at(-1)
      if (message.role === 'assistant' && previous?.role === 'assistant') {
        result[result.length - 1] = {
          role: 'assistant',
          text: `${previous.text}\n\n${text}`,
          time: previous.time,
        }
        continue
      }
      result.push({ role: message.role, text, time: message.time })
    }
    return result
  }

  /** Apply the configured UTF-8 byte budget to one message. */
  private truncate(text: string): string {
    return truncateUtf8(text, this.options.maxMessageTextBytes)
  }

  /** Build the durable event sequence for one conversation. */
  private eventsOf(
    imported: ImportedSession,
    messages: readonly ImportedMessage[],
  ): SessionEvent[] {
    const events: SessionEvent[] = []
    let seq = 0
    let lastTime = imported.createdAt
    const push = (event: SessionEvent): void => {
      events.push(event)
      seq += 1
    }
    let turn = 0
    let open = false
    let firstUserSeq: number | undefined
    const seqOf = (value: number): SessionSeq => brandNumber<SessionSeq>(value)
    for (const message of messages) {
      lastTime = Math.max(lastTime, message.time)
      if (message.role === 'user') {
        if (open) {
          push({ type: 'step/end', seq: seqOf(seq), time: lastTime, data: { turn, step: 1 } })
          push({ type: 'turn/end', seq: seqOf(seq), time: lastTime, data: { turn, reason: { kind: 'completed' } } })
        }
        turn += 1
        open = true
        push({ type: 'turn/start', seq: seqOf(seq), time: lastTime, data: { turn } })
        push({ type: 'step/start', seq: seqOf(seq), time: lastTime, data: { turn, step: 1 } })
        const user: UserMessage = {
          id: brandString<MessageId>(randomUUID()),
          role: 'user',
          content: [{ type: 'text', text: message.text }],
          source: { kind: 'user' },
        }
        firstUserSeq ??= seq
        push({ type: 'user/message', seq: seqOf(seq), time: lastTime, data: user, surfaceOp: 'append' })
        continue
      }
      if (!open) continue
      const assistant: AssistantMessage = {
        id: brandString<MessageId>(randomUUID()),
        role: 'assistant',
        content: [{ type: 'text', text: message.text }],
        source: { kind: 'model', provider: 'imported', model: imported.model ?? 'imported' },
      }
      push({
        type: 'assistant/message',
        seq: seqOf(seq),
        time: lastTime,
        data: { turn, step: 1, message: assistant, stream: [] },
        surfaceOp: 'append',
      })
    }
    if (open) {
      push({ type: 'step/end', seq: seqOf(seq), time: lastTime, data: { turn, step: 1 } })
      push({ type: 'turn/end', seq: seqOf(seq), time: lastTime, data: { turn, reason: { kind: 'completed' } } })
    }
    if (imported.title !== undefined && firstUserSeq !== undefined) {
      push({
        type: 'session/title',
        seq: seqOf(seq),
        time: lastTime,
        data: {
          title: imported.title,
          messageSeqs: [seqOf(firstUserSeq)],
          source: { kind: 'fallback' },
        },
      })
    }
    return events
  }

  /** Deterministic durable id for one source session. */
  private sessionIdFor(source: ImportSourceId, key: string): SessionId {
    const digest = createHash('sha256').update(`${source}:${key}`).digest('hex').slice(0, 32)
    return brandString<SessionId>(`session-import-${digest}`)
  }

  /** Resolve a configured or default root. */
  private rootOf(id: ImportSourceId): string {
    const definition = definitionOf(id)
    if (definition === undefined) throw new ImportEngineError('unknown-source', `Unknown source: ${id}`)
    return this.options.roots[id] ?? defaultRoot(definition)
  }

  /** Explain why a source cannot be scanned, if it cannot. */
  private async unavailableReason(id: ImportSourceId, root: string): Promise<'not-found' | 'current-home' | undefined> {
    if (!(await isDirectory(root))) return 'not-found'
    if (id === 'dsh') {
      if (await canonicalPath(root) === await canonicalPath(join(this.options.currentHome, 'sessions'))) {
        return 'current-home'
      }
    }
    return undefined
  }

  /** Keep only selected sessions; report ids that do not exist. */
  private select(
    sessions: readonly ScannedSession[],
    ids: readonly string[] | undefined,
  ): { sessions: ScannedSession[]; missing: string[] } {
    if (ids === undefined) return { sessions: [...sessions], missing: [] }
    const available = new Map(sessions.map(session => [session.meta.key, session]))
    const selected: ScannedSession[] = []
    const missing: string[] = []
    for (const id of ids) {
      const session = available.get(id)
      if (session === undefined) missing.push(id)
      else selected.push(session)
    }
    return { sessions: selected, missing }
  }

  /** Canonical cwd when the folder still exists and is absolute. */
  private async usableCwd(value: string | undefined): Promise<string | undefined> {
    if (value === undefined || !isAbsolute(value)) return undefined
    if (!(await isDirectory(value))) return undefined
    return canonicalPath(value)
  }
}
