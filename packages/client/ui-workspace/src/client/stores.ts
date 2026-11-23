/**
 * The workspace browser's viewing store: the session-list grouping mode,
 * persisted across reloads. Module level exports the factory only (a
 * module-level handle would pin the store identity across plugin reloads);
 * register() receives the factory and the browser derives its PropsStore
 * share from the return type.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  type AnnotationFilter, DEFAULT_PRIORITY, isEmptyAnnotation, isRecord, type SessionAnnotation, sameAnnotation,
  validatedPriority,
} from './annotations.ts'
import { reconcileManualOrder, type ArchivedFilter, type SessionRowState } from './tree.ts'

/** Browser-local order account for the hierarchy-free flat Session list. */
export const FLAT_SESSION_ORDER_KEY = '__flat_session_order__'

/** Session-list grouping mode: sibling Workspace sections, a Workspace tree, or one flat list. */
export type SessionGroupBy = 'workspace' | 'workspace-tree' | 'flat'
/** Session order: saved manual positions, current recency, or annotation priority. */
export type SessionOrderBy = 'manual' | 'updated' | 'priority'

/** Workspace browser viewing state persisted across surface remounts and reloads. */
export type WorkspaceViewState = {
  groupBy: SessionGroupBy
  orderBy: SessionOrderBy
  /** Explicit group expansion keyed by Workspace identity, including descendants in tree mode. */
  groupExpansion: Record<string, boolean>
  /** Saved manual order per Workspace group plus the browser-local flat-list account. */
  sessionOrderByAccount: Record<string, string[]>
  /** Archived-row visibility; omitted in pre-filter v5 snapshots and read as 'default'. */
  archivedFilter?: ArchivedFilter
  /** Per-Session user annotations keyed by id; omitted in blobs written before annotations existed. */
  annotations?: Record<string, SessionAnnotation>
  /** Annotation filter; omitted in blobs written before the filter existed and read as 'all'. */
  annotationFilter?: AnnotationFilter
}

type SessionOrderSource = {
  members: Readonly<Record<string, readonly SessionId[]>>
  summaries: SessionListState['byId']
  rowState: Pick<SessionRowState, 'pinnedSessionIds' | 'archivedSessionIds'>
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type WorkspaceViewActions = {
  setGroupBy: (draft: WorkspaceViewState, mode: SessionGroupBy) => void
  setOrderBy: (
    draft: WorkspaceViewState,
    mode: SessionOrderBy,
    initialOrders: Readonly<Record<string, readonly string[]>>,
  ) => void
  setGroupExpanded: (draft: WorkspaceViewState, key: string, expanded: boolean) => void
  retainAccountKeys: (draft: WorkspaceViewState, workspaceKeys: readonly string[]) => void
  syncSessionOrders: (
    draft: WorkspaceViewState,
    orders: Readonly<Record<string, readonly string[]>>,
  ) => void
  setSessionOrder: (
    draft: WorkspaceViewState,
    accountKey: string,
    order: readonly string[],
    initialOrders: Readonly<Record<string, readonly string[]>>,
  ) => void
  pinSessionOrder: (
    draft: WorkspaceViewState,
    sessionId: string,
    accountKeys: readonly string[],
    source: SessionOrderSource,
  ) => void
  setArchivedFilter: (draft: WorkspaceViewState, filter: ArchivedFilter) => void
  setAnnotationFilter: (draft: WorkspaceViewState, filter: AnnotationFilter) => void
  setAnnotation: (
    draft: WorkspaceViewState,
    sessionId: string,
    annotation: SessionAnnotation,
  ) => void
}

/** Copy read-only projections into the persisted mutable store representation. */
function copySessionOrders(
  orders: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  return Object.fromEntries(Object.entries(orders).map(([key, order]) => [key, [...order]]))
}

/** Member tables of the persisted closed unions; rehydration accepts exactly these strings. */
const GROUP_BY_MEMBERS: readonly SessionGroupBy[] = ['workspace', 'workspace-tree', 'flat']
const ORDER_BY_MEMBERS: readonly SessionOrderBy[] = ['manual', 'updated', 'priority']
const ARCHIVED_FILTER_MEMBERS: readonly ArchivedFilter[] = ['default', 'show', 'only']
const ANNOTATION_FILTER_MEMBERS: readonly AnnotationFilter[] = ['all', 'favorite', 'reviewLater']

/**
 * The value when it is a member of the closed union, else undefined.
 * @param value - parsed JSON value.
 * @param members - the union's members.
 * @returns the member, or undefined when the value is not one.
 */
function unionMember<T extends string>(value: unknown, members: readonly T[]): T | undefined {
  return members.find(member => member === value)
}

/**
 * The value when it is a boolean, else undefined.
 * @param value - parsed JSON value.
 * @returns the boolean, or undefined.
 */
function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * The value when it is an array of strings, else undefined.
 * @param value - parsed JSON value.
 * @returns the strings, or undefined.
 */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    items.push(item)
  }
  return items
}

/**
 * The record's entries whose value passes `guard`, in entry order.
 * @param record - parsed JSON record.
 * @param guard - per-value check returning the typed value or undefined to drop.
 * @returns the passing entries.
 */
function passingEntries<V>(
  record: Record<string, unknown>,
  guard: (value: unknown) => V | undefined,
): [string, V][] {
  const entries: [string, V][] = []
  for (const [key, value] of Object.entries(record)) {
    const guarded = guard(value)
    if (guarded !== undefined) entries.push([key, guarded])
  }
  return entries
}

/**
 * Re-validate one stored annotation against the record's field types: only
 * well-typed fields survive (booleans other than true read as absent, since
 * the write path only ever stores true), and an entry left with nothing worth
 * storing is dropped entirely.
 * @param raw - one parsed entry of the persisted annotations table.
 * @returns the annotation, or undefined when the entry carries nothing.
 */
function sanitizeAnnotation(raw: unknown): SessionAnnotation | undefined {
  if (!isRecord(raw)) return undefined
  const annotation: SessionAnnotation = {}
  if (raw['favorite'] === true) annotation.favorite = true
  if (raw['reviewLater'] === true) annotation.reviewLater = true
  const priority = validatedPriority(raw['priority'])
  if (priority !== DEFAULT_PRIORITY) annotation.priority = priority
  const tags = stringArray(raw['tags'])
  if (tags !== undefined) annotation.tags = tags
  const note = raw['note']
  if (typeof note === 'string' && note !== '') annotation.note = note
  return isEmptyAnnotation(annotation) ? undefined : annotation
}

/**
 * Validate one JSON.parse product of the `dsh.workspace.view.v5` persisted
 * blob: unknown keys are dropped, every kept key is type-checked against the
 * view state (the closed-union filters must be members, the annotation records
 * must carry well-typed fields), and a mistyped key is dropped so the store's
 * init default applies. Never throws; the output is safe to merge over the
 * store defaults before any tree.ts derivation reads it.
 * @param raw - the parsed localStorage value (any JSON).
 * @returns the partial state safe to merge over the store defaults.
 */
export function sanitizeWorkspaceView(raw: unknown): Partial<WorkspaceViewState> {
  if (!isRecord(raw)) return {}
  const view: Partial<WorkspaceViewState> = {}
  const groupBy = unionMember(raw['groupBy'], GROUP_BY_MEMBERS)
  if (groupBy !== undefined) view.groupBy = groupBy
  const orderBy = unionMember(raw['orderBy'], ORDER_BY_MEMBERS)
  if (orderBy !== undefined) view.orderBy = orderBy
  const archivedFilter = unionMember(raw['archivedFilter'], ARCHIVED_FILTER_MEMBERS)
  if (archivedFilter !== undefined) view.archivedFilter = archivedFilter
  const annotationFilter = unionMember(raw['annotationFilter'], ANNOTATION_FILTER_MEMBERS)
  if (annotationFilter !== undefined) view.annotationFilter = annotationFilter
  const groupExpansion = raw['groupExpansion']
  if (isRecord(groupExpansion)) view.groupExpansion = Object.fromEntries(passingEntries(groupExpansion, booleanValue))
  const sessionOrderByAccount = raw['sessionOrderByAccount']
  if (isRecord(sessionOrderByAccount)) {
    view.sessionOrderByAccount = Object.fromEntries(passingEntries(sessionOrderByAccount, stringArray))
  }
  const annotations = raw['annotations']
  if (isRecord(annotations)) view.annotations = Object.fromEntries(passingEntries(annotations, sanitizeAnnotation))
  return view
}

/**
 * Create the workspace browser viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createWorkspaceViewStore(): EngineStoreHandle<WorkspaceViewState, WorkspaceViewActions> {
  return defineStore({
    init: (): WorkspaceViewState => ({
      groupBy: 'workspace',
      orderBy: 'updated',
      groupExpansion: {},
      sessionOrderByAccount: {},
      archivedFilter: 'default',
    }),
    // Untrusted localStorage content must never reach the derived selectors
    // unvalidated: the tree derivations switch on these closed unions and end
    // in assertNever, so a malformed-but-parseable blob would throw during
    // render. The merge hook is the rehydration gate — the blob installs only
    // through sanitizeWorkspaceView, and every dropped key falls back to init.
    persist: 'dsh.workspace.view.v5',
    merge: (persisted, current) => ({ ...current, ...sanitizeWorkspaceView(persisted) }),
    actions: {
      setGroupBy: (d, mode: SessionGroupBy) => { d.groupBy = mode },
      setOrderBy: (d, mode: SessionOrderBy, initialOrders) => {
        if (mode === d.orderBy) return
        d.sessionOrderByAccount = mode === 'manual' ? copySessionOrders(initialOrders) : {}
        d.orderBy = mode
      },
      setGroupExpanded: (d, key: string, expanded: boolean) => { d.groupExpansion[key] = expanded },
      retainAccountKeys: (d, workspaceKeys: readonly string[]) => {
        const retained = new Set(workspaceKeys)
        d.groupExpansion = Object.fromEntries(
          Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)),
        )
        d.sessionOrderByAccount = Object.fromEntries(
          Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)),
        )
        delete (d as WorkspaceViewState & { sessionUpdatedAtByAccount?: unknown }).sessionUpdatedAtByAccount
      },
      syncSessionOrders: (d, orders) => {
        if (d.orderBy !== 'manual') return
        Object.assign(d.sessionOrderByAccount, copySessionOrders(orders))
      },
      setSessionOrder: (d, accountKey, order, initialOrders) => {
        if (d.orderBy === 'updated') d.sessionOrderByAccount = copySessionOrders(initialOrders)
        else Object.assign(d.sessionOrderByAccount, copySessionOrders(initialOrders))
        d.orderBy = 'manual'
        d.sessionOrderByAccount[accountKey] = [...order]
      },
      pinSessionOrder: (d, sessionId, accountKeys, source) => {
        const selected = new Set(accountKeys)
        d.sessionOrderByAccount = Object.fromEntries(Object.entries(source.members).map(([key, members]) => {
          const order = reconcileManualOrder(members, d.sessionOrderByAccount[key], source.summaries, source.rowState)
          return [key, selected.has(key) ? [sessionId, ...order.filter(id => id !== sessionId)] : order]
        }))
      },
      setArchivedFilter: (d, filter: ArchivedFilter) => { d.archivedFilter = filter },
      setAnnotationFilter: (d, filter) => { d.annotationFilter = filter },
      setAnnotation: (d, sessionId, annotation) => {
        const current = d.annotations?.[sessionId]
        if (current !== undefined && sameAnnotation(current, annotation)) return
        // An emptied annotation leaves the table, so it stays proportional to
        // what the user actually marked rather than to every Session opened.
        const kept = Object.entries(d.annotations ?? {}).filter(([id]) => id !== sessionId)
        d.annotations = Object.fromEntries(isEmptyAnnotation(annotation) ? kept : [...kept, [sessionId, annotation]])
      },
    },
  })
}

/** The bound write set of one viewing-store instance (what the UiWorkspace service drives). */
export type WorkspaceViewStoreActions = ReturnType<ReturnType<typeof createWorkspaceViewStore>['create']>['actions']
