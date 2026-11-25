/**
 * Live session state contract: turn-enclosed calls and correlated results
 * drive a bounded state machine per session. Capability contract, not a
 * version check; never fold persisted events or question/answer text into
 * state caches.
 *
 * Port of upstream `integrations/dsh-hachimodock/dsh-state-contract.js`.
 *
 * @module @prism/prism-hachimodock/state-contract
 */

import type { SessionEventLike, SessionLike } from './types.ts'

const LIMIT = 64
const QUESTION_TOOLS = new Set(['ask_user_question'])

const idOf = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
const ordinal = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Public view of one session's lifecycle state. */
export interface SessionStateView {
  readonly state: 'unknown' | 'working' | 'tool_running' | 'waiting_user' | 'done' | 'stopped' | 'error'
  readonly waitKind: 'toolapproval' | 'question' | null
  readonly revision: number
  readonly epoch: string | null
  readonly sourceSeq: number | null
}

/** One observed tool call, returned when the event introduced it. */
export interface ObservedCall {
  readonly callId: string
  readonly name: string
  readonly question: boolean
  readonly turn: number
}

interface CallEntry extends ObservedCall {}

interface StateEntry {
  session: SessionLike
  state: SessionStateView['state']
  waitKind: SessionStateView['waitKind']
  revision: number
  seq: number
  turn: number | null
  lastTurn: number
  calls: Map<string, CallEntry>
  approvals: Map<string, number>
  continued: Map<string, CallEntry>
  uncertain: boolean
}

function turnEndState(data: Record<string, unknown>): SessionStateView['state'] {
  const kind = (data?.reason as Record<string, unknown> | undefined)?.kind
  if (kind === 'completed') return 'done'
  if (kind === 'error') return 'error'
  if (typeof kind === 'string' && ['aborted', 'interrupted', 'blocked', 'max-tokens', 'forked', 'cancelled', 'canceled'].includes(kind)) return 'stopped'
  return 'unknown'
}

function resultCallId(data: Record<string, unknown>): string | null {
  // rc5 uses message.toolCallId; retain the older structurally compatible seam.
  const message = data?.message as Record<string, unknown> | undefined
  const fields = [message?.toolCallId, message?.callId, data?.callId].filter(value => value !== undefined)
  if (!fields.length || fields.some(value => idOf(value) === null || value !== fields[0])) return null
  return fields[0] as string
}

function questionResult(data: Record<string, unknown>): 'failed' | 'continued' | 'answered' | 'unknown' {
  const message = data.message as Record<string, unknown> | undefined
  if (message?.isError === true || record(data.error)) return 'failed'
  const content = message?.content
  if (!Array.isArray(content) || content.length !== 1) return 'unknown'
  const block = content[0] as Record<string, unknown> | undefined
  if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length > 32768) return 'unknown'
  try {
    const value: unknown = JSON.parse(block.text)
    if (record(value) && value.pending === true) return 'continued'
    if (record(value) && Array.isArray(value.answers)) return 'answered'
  } catch {
    /* Unknown result shapes must not pretend the human answered. */
  }
  return 'unknown'
}

export interface ObserveResult extends SessionStateView {
  readonly accepted: boolean
  readonly changed: boolean
  readonly call: ObservedCall | null
}

/**
 * Create the bounded per-session state machine. `observe` accepts only the
 * committed live event at `session.seq - 1`; anything else is rejected or
 * invalidated, never replayed from disk.
 */
export function createStateContract({ limit = 256 }: { limit?: number } = {}): {
  observe: (session: SessionLike, event: SessionEventLike, epoch: string | null) => ObserveResult
  snapshot: (session: SessionLike, epoch: string | null) => SessionStateView
  forget: (session: SessionLike | undefined) => void
} {
  const sessions = new Map<string, StateEntry>()
  let currentEpoch: string | null = null
  function bind(session: SessionLike, epoch: string | null, beforeSeq?: number): StateEntry | null {
    if (!idOf(epoch)) {
      sessions.clear()
      currentEpoch = null
      return null
    }
    if (epoch !== currentEpoch) {
      sessions.clear()
      currentEpoch = epoch
    }
    if (!idOf(session?.id) || !ordinal(session.seq)) return null
    let entry = sessions.get(session.id)
    if (!entry || entry.session !== session) {
      entry = {
        session, state: 'unknown', waitKind: null, revision: 0,
        seq: beforeSeq ?? session.seq - 1, turn: null, lastTurn: -1,
        calls: new Map(), approvals: new Map(), continued: new Map(), uncertain: false,
      }
      sessions.delete(session.id)
      sessions.set(session.id, entry)
      if (sessions.size > limit) {
        const oldest = sessions.keys().next()
        if (!oldest.done) sessions.delete(oldest.value)
      }
    }
    return entry
  }
  function set(entry: StateEntry, state: SessionStateView['state'], waitKind: SessionStateView['waitKind'] = null): void {
    if (entry.state !== state || entry.waitKind !== waitKind) entry.revision += 1
    entry.state = state
    entry.waitKind = waitKind
  }
  function invalidate(entry: StateEntry): void {
    entry.turn = null
    entry.calls.clear()
    entry.approvals.clear()
    entry.continued.clear()
    entry.uncertain = true
    set(entry, 'unknown')
  }
  function active(entry: StateEntry): void {
    if (entry.uncertain || entry.turn === null) return set(entry, 'unknown')
    if (entry.approvals.size) return set(entry, 'waiting_user', 'toolapproval')
    if ([...entry.calls.values()].some(call => call.question)) return set(entry, 'waiting_user', 'question')
    set(entry, entry.calls.size ? 'tool_running' : 'working')
  }
  function view(entry: StateEntry | null | undefined, epoch: string | null): SessionStateView {
    return {
      state: entry?.state ?? 'unknown',
      waitKind: entry?.waitKind ?? null,
      revision: entry?.revision ?? 0,
      epoch: idOf(epoch),
      sourceSeq: entry?.seq ?? null,
    }
  }
  function snapshot(session: SessionLike, epoch: string | null): SessionStateView {
    return view(bind(session, epoch), epoch)
  }
  function forget(session: SessionLike | undefined): void {
    if (session !== undefined && sessions.get(session.id)?.session === session) sessions.delete(session.id)
  }
  function observe(session: SessionLike, event: SessionEventLike, epoch: string | null): ObserveResult {
    // This getter is the installed Session append contract. Missing
    // capabilities are unknown, not an invitation to replay the last event
    // from disk.
    if (!ordinal(event?.seq) || !ordinal(session?.seq)) {
      const entry = bind(session, epoch)
      if (entry) invalidate(entry)
      return { accepted: false, changed: true, call: null, ...view(entry, epoch) }
    }
    if (event.seq !== session.seq - 1) return { accepted: false, changed: false, call: null, ...view(sessions.get(session.id), epoch) }
    const entry = bind(session, epoch, event.seq - 1)
    if (!entry || event.seq <= entry.seq) return { accepted: false, changed: false, call: null, ...view(entry, epoch) }
    const previousRevision = entry.revision
    const gap = event.seq !== entry.seq + 1
    entry.seq = event.seq
    if (gap) invalidate(entry)
    const data = record(event.data) ? event.data : {}
    let accepted = true
    let call: ObservedCall | null = null
    const sameTurn = ordinal(data.turn) && data.turn === entry.turn
    switch (event.type) {
      case 'turn/start':
        if (!ordinal(data.turn)) {
          invalidate(entry)
          break
        }
        if (data.turn <= entry.lastTurn) {
          accepted = false
          break
        }
        entry.turn = data.turn
        entry.lastTurn = data.turn
        entry.calls.clear()
        entry.approvals.clear()
        entry.uncertain = false
        active(entry)
        break
      case 'turn/end': {
        if (!ordinal(data.turn)) {
          invalidate(entry)
          break
        }
        if (!sameTurn) {
          accepted = false
          break
        }
        const state = turnEndState(data)
        entry.turn = null
        entry.calls.clear()
        entry.approvals.clear()
        if (state !== 'done') entry.continued.clear()
        set(entry, state === 'done' && entry.continued.size ? 'waiting_user' : state,
          state === 'done' && entry.continued.size ? 'question' : null)
        break
      }
      case 'tool/call': {
        if (!ordinal(data.turn)) {
          invalidate(entry)
          break
        }
        if (!sameTurn) {
          accepted = false
          break
        }
        const id = idOf(data.callId)
        const name = typeof data.name === 'string' && data.name.length > 0 && data.name.length <= 120 ? data.name : null
        if (!id || !name || entry.calls.size >= LIMIT || entry.calls.has(id) || entry.continued.has(id)) {
          invalidate(entry)
          break
        }
        const turn = entry.turn
        if (turn === null) {
          invalidate(entry)
          break
        }
        call = { callId: id, name, question: QUESTION_TOOLS.has(name), turn }
        entry.calls.set(id, call)
        active(entry)
        break
      }
      case 'tool/result': {
        if (!ordinal(data.turn)) {
          invalidate(entry)
          break
        }
        if (!sameTurn) {
          accepted = false
          break
        }
        const id = resultCallId(data)
        if (!id) {
          invalidate(entry)
          break
        }
        const known = entry.calls.get(id)
        if (known === undefined || known.turn !== entry.turn) {
          accepted = false
          break
        }
        entry.calls.delete(id)
        call = known
        if (known.question) {
          const result = questionResult(data)
          if (result === 'continued') {
            if (entry.continued.size >= LIMIT) {
              invalidate(entry)
              break
            }
            entry.continued.set(id, known)
          } else if (result === 'unknown') {
            invalidate(entry)
            break
          }
        }
        active(entry)
        break
      }
      case 'user/message': {
        // Only this committed live Session event proves admission. A submit or
        // queued inbox notification never enters this branch.
        const source = data.source as Record<string, unknown> | undefined
        if (source?.kind !== 'user-question-reply') break
        const id = idOf(source.callId)
        if (!id || !entry.continued.has(id)) {
          accepted = false
          break
        }
        if (data.turn !== undefined
          && (entry.turn !== null ? !sameTurn : !ordinal(data.turn) || data.turn <= entry.lastTurn)) {
          accepted = false
          break
        }
        entry.continued.delete(id)
        active(entry)
        break
      }
      case 'approval/asked': {
        if (data.turn !== undefined && !sameTurn) {
          accepted = false
          break
        }
        const id = idOf(data.id)
        if (entry.turn === null) {
          accepted = false
          break
        }
        if (!id || entry.approvals.size >= LIMIT || entry.approvals.has(id)) {
          invalidate(entry)
          break
        }
        // The installed audit can omit turn; then an exact current call is
        // required. A new uncorrelated approval id cannot prove currentness.
        if (data.turn === undefined && data.callId === undefined) {
          invalidate(entry)
          break
        }
        if (data.callId !== undefined) {
          if (!idOf(data.callId)) {
            invalidate(entry)
            break
          }
          if (!entry.calls.has(data.callId as string)) {
            accepted = false
            break
          }
        }
        entry.approvals.set(id, entry.turn)
        active(entry)
        break
      }
      case 'approval/decided': {
        if (data.turn !== undefined && !sameTurn) {
          accepted = false
          break
        }
        const id = idOf(data.id)
        if (!id) {
          invalidate(entry)
          break
        }
        if (entry.turn === null || entry.approvals.get(id) !== entry.turn) {
          accepted = false
          break
        }
        entry.approvals.delete(id)
        if (!['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(data.outcome as string)) {
          invalidate(entry)
          break
        }
        active(entry)
        break
      }
      case 'step/start':
        if (!ordinal(data.turn)) {
          invalidate(entry)
          break
        }
        if (sameTurn) active(entry)
        else accepted = false
        break
      default:
        if (typeof event.type === 'string' && /^(turn|task|tool|user-questions|approval)\//.test(event.type)
          && !['tool/ptc-dispatch', 'approval/policy'].includes(event.type)) invalidate(entry)
        // PTC can contain timed human waits; an unsupported dispatch cannot be
        // presented as confidently working even if another tool is executing.
        else if (event.type === 'tool/ptc-dispatch') invalidate(entry)
        break
    }
    return { accepted, changed: previousRevision !== entry.revision, call, ...view(entry, epoch) }
  }
  return { observe, snapshot, forget }
}

export { turnEndState, resultCallId }
