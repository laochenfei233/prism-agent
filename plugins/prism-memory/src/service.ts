/**
 * Durable long-term memory service (`ctx.prismMemory`).
 *
 * Design constraints this module encodes, in priority order:
 *
 * 1. **The cached prefix stays byte-stable.** Nothing here writes to the system
 *    prompt per turn, and nothing rewrites earlier history. The one model-visible
 *    dynamic contribution is a user-role message appended at the request tail by
 *    a prepended `agent/pre-step` listener, and only when retrieval finds
 *    something above the configured score.
 * 2. **Everything model-visible is logged.** Recall text lands as an ordinary
 *    durable `user/message`, so replay, fork, and resume reconstruct it.
 * 3. **A record is invalidated, never silently rewritten.** Supersede, expiry,
 *    merge, and forget all preserve the record with dates and a successor link.
 *
 * @module @prism/prism-memory
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context, Fiber, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine, SessionSurfaceSnapshot } from '@deepseek-ai/dsh-session-query'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, Message } from '@deepseek-ai/dsh-llm'
import {
  extractInjectedIds,
  findNearDuplicates,
  groupConversations,
  isExpired,
  isLive,
  jaccard,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  rankRecords,
  recordTokens,
  renderConversations,
  renderExport,
  renderIndex,
  suggestTags,
  textFingerprint,
  tokenize,
} from './memory.ts'
import type { ConversationBucket, MemoryHit, MemoryKind, MemoryOrigin, MemoryScope, MemoryStatus } from './memory.ts'
import {
  assertIdentityLayers,
  DEFAULT_LAYER,
  kindForLayer,
  layerOf,
  SHIPPED_IDENTITY_LAYERS,
} from './layers.ts'
import type { MemoryLayer } from './layers.ts'
import { distillCandidates } from './distill.ts'
import {
  DREAM_TAG,
  planDream,
  REFLECTION_TAG,
  renderDreamJournal,
  renderReflection,
  TOPIC_TAG,
} from './dream.ts'
import type { TopicDigest } from './dream.ts'
import {
  collectMemoryFiles,
  IMPORT_SOURCE_IDS,
  parseMemoryClaims,
  readMemoryFile,
} from './import.ts'
import { renderOrientation, renderTail } from './recall.ts'
import type { MemoryRecord } from './domain.ts'
import { prismMemoryDomainSpec } from './domain.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'prism-memory': { kind: 'prism-memory' } & ContextFormed
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    prismMemory: PrismMemoryService
  }
}

/**
 * Prompt-section order for the memory protocol. `getSectionOrder()` only knows
 * repository-allocated names, so this plugin claims a slot inside the tool
 * guidance band, between the goal section (2400) and workflow (2600).
 */
const MEMORY_SECTION_ORDER = 2500

/** Upper bound on the recalled ids one session's projection carries. */
const MAX_TRACKED_INJECTIONS = 200

/** Upper bound on a supersede chain walk, so a corrupted store cannot spin. */
const MAX_CHAIN_LENGTH = 64

/** Mirrored file names under the configured export directory. */
export const EXPORT_MARKDOWN_FILE = 'memory.md'
export const EXPORT_INDEX_FILE = 'memory.index.json'

/**
 * The fixed, short memory protocol placed in the stable prompt prefix.
 *
 * It names the layer axis because the model cannot use a field it has not been
 * told about, and it is the only place that can say so without costing bytes on
 * every turn.
 */
const DEFAULT_PROTOCOL = [
  'Long-term memory is available through memory_search, memory_conversations, memory_open, memory_remember, and memory_forget.',
  'Search memory before starting work that may repeat an earlier decision, and record a durable claim with memory_remember',
  'once it is settled. Give each claim a layer saying what it is about — soul, user, project, fact, lesson, topic, or rule —',
  'because a user preference and a hard rule are recalled on their own while other layers are recalled by relevance.',
  'Recalled memory is background: verify it against the workspace before relying on it.',
].join(' ')

/**
 * Statuses an automatic recall may inject. A `pending` record is never injected
 * — it is held back precisely because no operator has confirmed it yet.
 */
const INJECTION_STATUSES = ['active'] as const

/**
 * Statuses a model search may return. `pending` belongs here unconditionally:
 * a write below `pendingBelowConfidence` was recorded by the model itself, and a
 * record the model can never find again is worse than no record at all. Search
 * visibility and injection are separate decisions.
 */
const SEARCH_STATUSES = ['active', 'pending'] as const

/** The status an automatically written claim may take: never a third state. */
export const ADMISSION_STATUSES = ['pending', 'active'] as const

/**
 * Admission of a caller with no session. The operator surfaces — the Web memory
 * page and, through it, the person using it — govern the whole corpus rather
 * than one session's slice, so nothing is filtered out. Every other caller
 * derives its admission from the session it runs in.
 */
const WHOLE_STORE: MemoryAdmission = { cwd: null, sessionId: null, isEligible: () => true }

/** One status an automatic write may use. */
export type AdmissionStatus = (typeof ADMISSION_STATUSES)[number]

/** Milliseconds in one day, for the day-denominated configuration bounds. */
const DAY_MS = 86_400_000

/**
 * Ranked candidates fetched before the already-injected filter runs. Without the
 * margin, a session that has already received the top hits would fetch only those
 * and find nothing new below them.
 */
const CANDIDATE_OVERFETCH = 50

/** Member claims one topic digest lists. */
const DREAM_DIGEST_MEMBERS = 3

/** Characters one topic digest's text may take. */
const DREAM_DIGEST_CHARS = 400

/** Corroborations that make a claim independently confirmed: one other conversation. */
const CORROBORATION_FLOOR = 2

/** Files one import reads, and bytes it reads from each. */
const IMPORT_MAX_FILES = 50
const IMPORT_MAX_FILE_BYTES = 131_072

/** A memory operation failed for a reason the caller can act on. */
export class PrismMemoryError extends Error {
  /** Stable failure code, so a model tool or a command can branch on it. */
  readonly code: string

  /**
   * @param message - Operator-facing description.
   * @param code - Stable failure code.
   */
  constructor(message: string, code: string) {
    super(message)
    this.name = 'PrismMemoryError'
    this.code = code
  }
}

/** One write request, already narrowed by a caller. */
export interface RememberInput {
  /** One self-contained claim. */
  readonly text: string
  /** Claim class; defaults to `fact`. */
  readonly kind?: MemoryKind
  /** What the claim is about; defaults to `fact`. */
  readonly layer?: MemoryLayer
  /** Requested visibility; defaults to `global`. */
  readonly scope?: MemoryScope
  /** Optional recall keywords; when omitted the service derives them. */
  readonly tags?: readonly string[]
  /** Producer's certainty, `0..1`. */
  readonly confidence?: number
  /** The record this claim replaces. */
  readonly supersedes?: string
  /** Days until the claim expires; `0` or absent means it never expires. */
  readonly ttlDays?: number
  /** Absolute instant this claim becomes actionable; absent means it has no date. */
  readonly dueAt?: number
  /** Recording time of the claim; defaults to now. */
  readonly validAt?: number
  /** Who caused the write; defaults to `model`. */
  readonly origin?: MemoryOrigin
  /** Where the write came from, overriding the calling session; used by the importer. */
  readonly evidenceNote?: string
  /**
   * The message this claim is grounded in, with the fingerprint of its
   * model-visible text at write time. A caller with no cited message omits it;
   * no source is invented. `/memory verify` re-reads it.
   */
  readonly evidenceMessage?: EvidenceMessage
  /** Status an automatic write takes; a model write overrides this with the review rules. */
  readonly status?: AdmissionStatus
}

/** The outcome of one write. */
export interface RememberResult {
  /** The stored record. */
  readonly record: MemoryRecord
  /** `created` for a new record, `existing` when an identical claim already stood. */
  readonly outcome: 'created' | 'existing'
  /** Live near-duplicates the caller may prefer to supersede instead of duplicating. */
  readonly duplicates: readonly { readonly id: string, readonly similarity: number, readonly text: string }[]
}

/** One hygiene pass over the store. */
export interface MaintenanceReport {
  /** Whether the pass committed. A dry run reports the same plan without writing. */
  readonly applied: boolean
  /** Live records past their deadline, archived by this pass. */
  readonly expired: readonly string[]
  /** Near-duplicate pairs, the merged-away record first. */
  readonly duplicates: readonly { readonly keep: string, readonly drop: string, readonly similarity: number }[]
  /** Archived records dropped because the store was at capacity. */
  readonly evicted: readonly string[]
  /** Records whose supersede links no longer resolve in the store. */
  readonly orphaned: readonly string[]
  /** Records whose derivation parents no longer resolve, such as after an eviction. */
  readonly orphanedParents: readonly string[]
  /** Store size before the pass. */
  readonly totalBefore: number
  /** Store size after the pass. */
  readonly totalAfter: number
}

/** One completed export. */
export interface ExportResult {
  /** Directory the mirror was written to. */
  readonly dir: string
  /** Written file paths, in write order. */
  readonly files: readonly string[]
  /** Records mirrored. */
  readonly total: number
}

/** One mirrored file's state against what the current store renders. */
export type ExportFileState = 'match' | 'stale' | 'missing' | 'unreadable'

/** What one mirror check found. */
export interface ExportCheckResult {
  /** Directory checked. */
  readonly dir: string
  /** The Markdown mirror's state. */
  readonly markdown: ExportFileState
  /** The JSON index's state. */
  readonly index: ExportFileState
}

/** The message one claim is grounded in, as its identity and write-time fingerprint. */
export interface EvidenceMessage {
  /** The cited message's stable id. */
  readonly id: string
  /** SHA-256 of the message's model-visible text at write time. */
  readonly textHash: string
}

/** What re-reading one cited source found. */
export type EvidenceOutcome = 'intact' | 'drifted' | 'missing' | 'unavailable'

/** One cited record's verification verdict. */
export interface EvidenceVerdict {
  /** The record checked. */
  readonly id: string
  /** What the re-read found. */
  readonly outcome: EvidenceOutcome
}

/** What one evidence verification read. */
export interface VerificationReport {
  /** Every record citing a message, newest first, with its verdict. */
  readonly verdicts: readonly EvidenceVerdict[]
  /** Records citing no message; they carry nothing to verify and are counted, not listed. */
  readonly uncited: number
  /** Whether no session-query engine was mounted, so nothing could be re-read. */
  readonly readerUnavailable: boolean
}

/** Two claims set side by side, with the mechanical facts and verdict. */
export interface ComparisonReport {
  /** One record. */
  readonly left: MemoryRecord
  /** The other record. */
  readonly right: MemoryRecord
  /** Jaccard similarity of the two claims' text, as the ranker's tokenizer sees it. */
  readonly similarity: number
  /** Recall tags both records carry. */
  readonly sharedTags: readonly string[]
  /** Direct supersede, merge, or derivation link between the two, named from the left side, or `null`. */
  readonly relation: string | null
  /** Mechanical verdict over the deployment's own thresholds; a reader decides what it means. */
  readonly verdict: 'equivalent' | 'conflicting' | 'complementary' | 'unrelated'
}

/** What one consolidation pass found and, when committed, what it changed. */
export interface DreamReport {
  /** Whether the pass wrote anything. A dry run reports the same plan and writes nothing. */
  readonly applied: boolean
  /** New-material records the pass looked at. */
  readonly scanned: number
  /** Claims corroborated by more than one conversation, which this pass confirmed. */
  readonly corroborated: readonly { readonly id: string, readonly corroborations: number }[]
  /** Topic digests the pass wrote or would write. */
  readonly topics: readonly TopicDigest[]
  /** Unresolved contradictions, for a person to settle. */
  readonly conflicts: readonly { readonly left: string, readonly right: string, readonly similarity: number }[]
  /** The journal record this pass wrote, or `null`. */
  readonly journalId: string | null
  /** The daily reflection record this pass wrote, or `null` when today's already stood. */
  readonly reflectionId: string | null
}

/** What one import read and stored. */
export interface ImportReport {
  /** Whether the import committed. A dry run reports the same reads and writes nothing. */
  readonly applied: boolean
  /** Layout ids that were read. */
  readonly sources: readonly string[]
  /** Files that contributed at least one claim. */
  readonly files: readonly string[]
  /** Claims parsed out of those files. */
  readonly scanned: number
  /** Ids of the records the import stored. */
  readonly created: readonly string[]
  /** Claims dropped as already known, or as unreadable. */
  readonly skipped: number
}

/** The caller's admission context, derived from the immutable agent and session. */
export interface MemoryAdmission {
  /** The calling session's working directory, or `null` when it has none. */
  readonly cwd: string | null
  /** The calling session's identity, or `null` for a non-session caller. */
  readonly sessionId: string | null
  /**
   * Whether one record is visible to this caller.
   * @param record - the record to admit or reject.
   * @returns true when the record's scope covers this caller.
   */
  isEligible(record: MemoryRecord): boolean
}

/** Deployment-owned retrieval, injection, and governance bounds. */
export interface PrismMemoryConfig {
  /** Static system-prompt text describing the tools. */
  protocolSection: Volatile<string>
  /** Whether the pre-step listener may inject. */
  injectEnabled: Volatile<boolean>
  /** Records per injected block. */
  maxInjectedRecords: Volatile<number>
  /** Character cap on the injected block. */
  maxInjectedChars: Volatile<number>
  /** Relevance floor for injection. */
  minInjectScore: Volatile<number>
  /** Inject the L0 index when no record matched. */
  residentIndex: Volatile<boolean>
  /** Character cap on the L0 index. */
  maxIndexChars: Volatile<number>
  /** Hard cap on model-requested search results. */
  searchLimit: Volatile<number>
  /** Stored text cap. */
  maxTextChars: Volatile<number>
  /** Stored tag cap. */
  maxTags: Volatile<number>
  /** Store cap; a write at the cap evicts an archived record. */
  maxRecords: Volatile<number>
  /** Route every write through `pending`: it never injects, but stays searchable. */
  requireApproval: Volatile<boolean>
  /** Writes below this confidence become `pending`: it never injects, but stays searchable. */
  pendingBelowConfidence: Volatile<number>
  /** Similarity floor at which a write reports a near-duplicate. */
  dedupeJaccard: Volatile<number>
  /** Similarity floor at which a write is treated as an identical claim. */
  dedupeReplaceJaccard: Volatile<number>
  /** Derive recall tags for a write that supplied none. */
  autoTag: Volatile<boolean>
  /** Expiry applied to writes that request no time-to-live; `0` means never. */
  defaultTtlDays: Volatile<number>
  /** Default directory for `/memory export`; a command argument overrides it. */
  exportDir: Volatile<string | undefined>

  // --- Layer axis -----------------------------------------------------------

  /**
   * Layers recalled on a session's first turn without a keyword match, in
   * injection order. Empty turns the always-on path off entirely.
   */
  identityLayers: Volatile<readonly string[]>
  /** Records the always-on path may inject per first turn. */
  maxIdentityRecords: Volatile<number>

  // --- Retrieval ------------------------------------------------------------

  /** BM25 term-frequency saturation. */
  bm25K1: Volatile<number>
  /** BM25 document-length normalization. */
  bm25B: Volatile<number>
  /** Inject on a turn's later steps when that step admitted new user text. */
  injectEveryStep: Volatile<boolean>

  // --- Orientation and dates ------------------------------------------------

  /**
   * Inject the local date, weekday, and greeting on a session's first turn.
   * Off by default: it is the one contribution that says something on a turn
   * with no memory to recall, so enabling it is a deployment's decision rather
   * than a side effect of installing the plugin.
   */
  orientationEnabled: Volatile<boolean>
  /** Surface records whose due date has arrived. */
  reminderEnabled: Volatile<boolean>
  /** How far ahead a due date is surfaced. */
  reminderWindowDays: Volatile<number>
  /** Reminders injected per first turn. */
  maxReminders: Volatile<number>

  // --- Distillation ---------------------------------------------------------

  /** Read each turn's own text for durable claims, with no extra model call. */
  autoDistill: Volatile<boolean>
  /** Status a distilled claim is written with. */
  autoDistillStatus: Volatile<AdmissionStatus>
  /** Confidence a distilled claim is written with. */
  autoDistillConfidence: Volatile<number>
  /** Claims one turn may contribute. */
  autoDistillLimit: Volatile<number>

  // --- Consolidation --------------------------------------------------------

  /** Run the consolidation pass on a window. */
  dreamEnabled: Volatile<boolean>
  /** Claims written since the last pass before another one runs. */
  dreamEveryWrites: Volatile<number>
  /** New-material records the pass compares against the corpus. */
  dreamWindowRecords: Volatile<number>
  /** Similarity floor at which two live claims count as comparable but disagreeing. */
  dreamConflictFloor: Volatile<number>
  /** Claims sharing a tag before that tag earns a digest. */
  dreamClusterFloor: Volatile<number>
  /** Digests one pass writes. */
  dreamMaxTopics: Volatile<number>
  /** Write one account of the day per local day. */
  dailyReflection: Volatile<boolean>

  // --- Import ---------------------------------------------------------------

  /** External layouts `/memory import` reads; none is read unless named. */
  importSources: Volatile<readonly string[]>
  /** Status an imported claim is written with. */
  importStatus: Volatile<AdmissionStatus>
  /** Confidence an imported claim is written with. */
  importConfidence: Volatile<number>
}

/** Convert a day count to an absolute deadline, or `null` for "never". */
function deadlineFrom(now: number, ttlDays: number): number | null {
  return ttlDays > 0 ? now + ttlDays * 86_400_000 : null
}

/** Trim, collapse whitespace, and bound one stored memory text. */
function normalizeText(text: string, maxChars: number): string {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (collapsed === '') throw new PrismMemoryError('memory text must not be empty', 'PRISM_MEMORY_EMPTY_TEXT')
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}…`
}

/** Normalize one tag list, dropping empties and duplicates. */
function normalizeTags(tags: readonly string[] | undefined, limit: number): string[] {
  const seen = new Set<string>()
  for (const tag of tags ?? []) {
    const normalized = String(tag).trim().toLowerCase()
    if (normalized !== '' && !seen.has(normalized)) seen.add(normalized)
    if (seen.size >= limit) break
  }
  return [...seen]
}

/** Concatenate the direct-user text of one step's accepted messages. */
function directUserText(messages: readonly UserMessage[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message.source.kind !== 'user') continue
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** Every text block of one message, for reading back what a prior injection said. */
function textBlocks(message: UserMessage): string[] {
  const texts: string[] = []
  for (const block of message.content) if (block.type === 'text') texts.push(block.text)
  return texts
}

/** Write one file durably: a full write to a sibling temporary path, then a rename. */
async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}

/**
 * The direct derivation or replacement link between two records, named from the
 * compare report's left side, or `null` when none exists.
 * @param left - one record of the comparison.
 * @param right - the other record.
 * @returns the link, or `null`.
 */
function relationBetween(left: MemoryRecord, right: MemoryRecord): string | null {
  if (left.supersedes === right.id) return 'left supersedes right'
  if (right.supersedes === left.id) return 'right supersedes left'
  if (left.mergedInto === right.id) return 'left was merged into right'
  if (right.mergedInto === left.id) return 'right was merged into left'
  if ((left.parents ?? []).includes(right.id)) return 'left derives from right'
  if ((right.parents ?? []).includes(left.id)) return 'right derives from left'
  return null
}

/**
 * The model-visible text of every message on one session's current surface, by
 * message id. A read failure resolves to `undefined`, which the verifier
 * reports as `unavailable` rather than guessing at the cause.
 * @param reader - the session-query engine.
 * @param sessionId - the stored session id, which names a session by construction.
 * @returns message id → its text blocks joined, or `undefined` when the session could not be read.
 */
async function readSurfaceTexts(
  reader: SessionQueryEngine,
  sessionId: string,
): Promise<Map<string, string> | undefined> {
  let snapshot: SessionSurfaceSnapshot
  try {
    // Stored as plain text; the id space is the session id space by construction.
    snapshot = await reader.readSurface(sessionId as SessionId)
  } catch {
    // Unknown session, unparsable log, or backend failure: the cited records
    // are unverifiable, and no outcome in between is knowable here.
    return undefined
  }
  const texts = new Map<string, string>()
  for (const event of snapshot.events) {
    const message = 'message' in event.data ? event.data.message : event.data
    texts.set(message.id, messageText(message))
  }
  return texts
}

/**
 * Classify one mirrored file against the bytes the current store renders.
 * @param path - the file to read.
 * @param expected - the expected bytes.
 * @returns the file's state.
 */
async function mirroredFileState(path: string, expected: string): Promise<ExportFileState> {
  try {
    await stat(path)
  } catch {
    // No mirror written yet — the ordinary pre-export state.
    return 'missing'
  }
  let actual: string
  try {
    actual = await readFile(path, 'utf8')
  } catch {
    // The file exists but cannot be read; report that rather than guess.
    return 'unreadable'
  }
  return actual === expected ? 'match' : 'stale'
}

/** Order records newest first, ties broken by id so the order stays total. */
function newestFirst(left: MemoryRecord, right: MemoryRecord): number {
  return right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1)
}

/** Every text block of one derived message. */
function messageText(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) if (block.type === 'text') parts.push(block.text)
  return parts.join('\n')
}

/**
 * The messages of the turn that is closing, oldest first: the person's message
 * and everything the assistant said after it.
 *
 * The walk runs backwards and stops at that message, so an earlier turn's words
 * cannot be distilled a second time, and a tool result between them is ignored —
 * a command's output is not a claim the turn made.
 * @param messages - the session's derived model-visible history.
 * @returns the turn's user message followed by its assistant messages.
 */
function turnMessages(messages: readonly Message[]): Message[] {
  const turn: Message[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined) continue
    if (message.role === 'assistant') {
      turn.unshift(message)
      continue
    }
    if (message.role === 'user') {
      turn.unshift(message)
      break
    }
  }
  return turn
}

/** One record this plugin writes for itself: a journal entry, a reflection, or a digest. */
interface AutomaticRecordInput {
  /** The record's text. */
  readonly text: string
  /** Recall tags; one of them marks the record as this plugin's own. */
  readonly tags: readonly string[]
  /** Lifecycle state. */
  readonly status: MemoryStatus
  /** What the record is about. */
  readonly layer: MemoryLayer
  /** The claim class. */
  readonly kind: MemoryKind
  /** Why this record exists, recorded on its evidence. */
  readonly note: string
  /** Records this digest was derived from; absent on records that are not syntheses. */
  readonly parents?: readonly string[]
}

/**
 * Durable long-term memory over one `prism_memory` domain.
 *
 * Reads are synchronous against the domain's in-memory state, so retrieval
 * never blocks a model step on storage. Writes are durable before they resolve.
 */
export class PrismMemoryService extends Service {
  /** Services required before memory work can activate. */
  static readonly inject = ['storageDomain', 'systemPrompt', 'sessionProjections', 'agents'] as const

  /** Deployment-owned retrieval, injection, and governance bounds. */
  static readonly Config = z.object({
    protocolSection: z.string().default(DEFAULT_PROTOCOL).volatile(),
    injectEnabled: z.boolean().default(true).volatile(),
    maxInjectedRecords: z.number().step(1).min(1).default(3).volatile(),
    maxInjectedChars: z.number().step(1).min(1).default(900).volatile(),
    minInjectScore: z.number().min(0).default(0.6).volatile(),
    residentIndex: z.boolean().default(false).volatile(),
    maxIndexChars: z.number().step(1).min(1).default(600).volatile(),
    searchLimit: z.number().step(1).min(1).default(6).volatile(),
    maxTextChars: z.number().step(1).min(1).default(2000).volatile(),
    maxTags: z.number().step(1).min(1).default(8).volatile(),
    maxRecords: z.number().step(1).min(1).default(5000).volatile(),
    requireApproval: z.boolean().default(false).volatile(),
    pendingBelowConfidence: z.number().min(0).max(1).default(0.5).volatile(),
    dedupeJaccard: z.number().min(0).max(1).default(0.85).volatile(),
    dedupeReplaceJaccard: z.number().min(0).max(1).default(0.97).volatile(),
    autoTag: z.boolean().default(true).volatile(),
    defaultTtlDays: z.number().min(0).default(0).volatile(),
    exportDir: z.string().volatile(),
    identityLayers: z.array(z.string()).default([...SHIPPED_IDENTITY_LAYERS]).volatile(),
    maxIdentityRecords: z.number().step(1).min(1).default(4).volatile(),
    bm25K1: z.number().min(0).default(1.2).volatile(),
    bm25B: z.number().min(0).max(1).default(0.75).volatile(),
    injectEveryStep: z.boolean().default(false).volatile(),
    orientationEnabled: z.boolean().default(false).volatile(),
    reminderEnabled: z.boolean().default(true).volatile(),
    reminderWindowDays: z.number().min(0).default(7).volatile(),
    maxReminders: z.number().step(1).min(1).default(3).volatile(),
    autoDistill: z.boolean().default(true).volatile(),
    autoDistillStatus: z.union([z.const('pending'), z.const('active')]).default('pending').volatile(),
    autoDistillConfidence: z.number().min(0).max(1).default(0.4).volatile(),
    autoDistillLimit: z.number().step(1).min(1).default(3).volatile(),
    dreamEnabled: z.boolean().default(true).volatile(),
    dreamEveryWrites: z.number().step(1).min(1).default(25).volatile(),
    dreamWindowRecords: z.number().step(1).min(1).default(200).volatile(),
    dreamConflictFloor: z.number().min(0).max(1).default(0.5).volatile(),
    dreamClusterFloor: z.number().step(1).min(2).default(3).volatile(),
    dreamMaxTopics: z.number().step(1).min(1).default(3).volatile(),
    dailyReflection: z.boolean().default(true).volatile(),
    importSources: z.array(z.string()).default([]).volatile(),
    importStatus: z.union([z.const('pending'), z.const('active')]).default('pending').volatile(),
    importConfidence: z.number().min(0).max(1).default(0.6).volatile(),
  })

  /** The durable record table; assigned by {@link PrismMemoryService.init}. */
  private records!: KvTable<string, MemoryRecord>

  /**
   * The session-query engine, bound for `/memory verify` while the composition
   * mounts one. It is optional on purpose: a composition without it keeps every
   * other memory path, and verification reports its cited sources as
   * `unavailable` instead of failing the row.
   */
  private sessionReader: SessionQueryEngine | undefined

  /** The binding fiber for {@link PrismMemoryService.sessionReader}, disposed with the service. */
  private sessionReaderFiber: Fiber | undefined

  /** Validated deployment configuration, read through each field's `get()`. */
  private readonly config: PrismMemoryConfig

  /**
   * @param ctx - Registrant context carrying storage, prompt, projection, and agent services.
   * @param config - Validated deployment-owned memory bounds.
   */
  constructor(ctx: Context, config: PrismMemoryConfig) {
    super(ctx, 'prismMemory')
    this.config = config
    assertBounds(config)
  }

  /** Open the durable domain and install the prompt, projection, and recall contributions. */
  async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(prismMemoryDomainSpec)
    this.records = domain.table('records')
    this.ctx.effect(() => async () => {
      await domain.close()
    }, 'prismMemory.domainClose')

    this.ctx.systemPrompt.section({
      name: 'prism-memory',
      order: MEMORY_SECTION_ORDER,
      text: () => this.config.protocolSection.get(),
    })

    this.ctx.sessionProjections.register({
      key: 'prismMemory',
      stateVersion: 1,
      stateSchema: zod.object({ injected: zod.array(zod.string()) }),
      init: () => ({ injected: [] }),
      apply: (state, event) => {
        if (event.type !== 'user/message' || event.data.source.kind !== 'prism-memory') return state
        const ids = extractInjectedIds(textBlocks(event.data))
        if (ids.length === 0) return state
        const merged = new Set(state.injected)
        for (const id of ids) merged.add(id)
        return { injected: [...merged].slice(-MAX_TRACKED_INJECTIONS) }
      },
    })

    // The optional read path behind `/memory verify`, bound the way an optional
    // service is bound anywhere else: a fiber that re-resolves when the service
    // appears and clears the field when it goes.
    this.sessionReaderFiber = this.ctx.inject(['sessionQuery'], childCtx => {
      const reader = childCtx.sessionQuery
      this.sessionReader = reader
      childCtx.effect(() => () => {
        if (this.sessionReader === reader) this.sessionReader = undefined
      }, 'prismMemory.sessionReaderRelease')
    })
    this.ctx.effect(() => () => this.sessionReaderFiber?.dispose(), 'prismMemory.sessionReaderBinding')

    this.ctx.on('agent/turn-stopping', async ({ agent, signal }): Promise<void> => {
      if (signal.aborted) return
      await this.afterTurn(agent)
    })

    this.ctx.on('agent/pre-step', async ({ agent, step, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const text = this.tailText(agent, decision.messages, step)
      if (text === '') return decision
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'prism-memory', form: 'snapshot', sections: [{ name: 'prism-memory', text }] },
          }),
        ],
      }
    }, { prepend: true })
  }

  /**
   * The caller's admission context. Scope is derived here from the immutable
   * agent and session, never from model-supplied arguments, so one workspace or
   * conversation cannot read another's records.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns scope keys and the resulting admission predicate.
   */
  admission(agent: Agent | undefined): MemoryAdmission {
    const session = agent?.session
    const cwd = session?.header.cwd ?? null
    const sessionId = session?.id ?? null
    return {
      cwd,
      sessionId,
      isEligible: record => (
        record.scope === 'global'
        || (record.scope === 'project' && cwd !== null && record.scopeKey === cwd)
        || (record.scope === 'conversation' && sessionId !== null && record.scopeKey === sessionId)
      ),
    }
  }

  /** Every stored record, in unspecified order. */
  all(): MemoryRecord[] {
    return [...this.records.entries()].map(([, record]) => record)
  }

  /**
   * Every record the caller may see.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the caller-visible corpus.
   */
  visible(agent: Agent | undefined): MemoryRecord[] {
    return this.visibleIn(this.admission(agent))
  }

  /** Every record one admission admits. */
  private visibleIn(admission: MemoryAdmission): MemoryRecord[] {
    return this.all().filter(record => admission.isEligible(record))
  }

  /**
   * Every stored record, newest first, for the operator surface.
   *
   * A Web page belongs to no session: it governs the whole corpus a person owns
   * rather than one session's slice, so no scope narrows this read. Every record
   * renders its own scope, so the narrowing stays visible where it matters.
   * @returns every stored record, newest first.
   */
  operatorRecords(): MemoryRecord[] {
    return this.all().sort(newestFirst)
  }

  /** Recalled ids already injected into one session. */
  injectedIds(agent: Agent): Set<string> {
    const state = this.ctx.sessionProjections.stateOf(agent.session, 'prismMemory')
    return new Set(state?.injected ?? [])
  }

  /**
   * Render the tail block for one step, or an empty string when nothing is worth
   * injecting.
   *
   * Four contributions may ride in the single appended message — the local date,
   * standing memory on an identity layer, records whose due date has arrived, and
   * keyword-matched recall — because one message costs one tail append while four
   * would cost four. A record the session already received is never repeated.
   * @param agent - The agent entering the step.
   * @param messages - Messages this step's downstream listeners accepted.
   * @param step - One-based step index within the turn.
   * @returns the block text, or an empty string.
   */
  tailText(agent: Agent, messages: readonly UserMessage[], step: number): string {
    if (!this.config.injectEnabled.get()) return ''
    const firstStep = step === 1
    if (!firstStep && !this.config.injectEveryStep.get()) return ''
    const admission = this.admission(agent)
    const now = Date.now()
    const already = this.injectedIds(agent)
    const query = directUserText(messages)
    const recall = query === ''
      ? []
      : rankRecords(this.all(), query, {
        isEligible: admission.isEligible,
        statuses: INJECTION_STATUSES,
        // Over-fetch before the already-injected filter so a session that has
        // seen the top hits still reaches the next distinct record.
        limit: CANDIDATE_OVERFETCH,
        now,
        k1: this.config.bm25K1.get(),
        b: this.config.bm25B.get(),
      })
        .filter(hit => hit.matched.length > 0
          && hit.score >= this.config.minInjectScore.get()
          && !already.has(hit.record.id))
        .slice(0, this.config.maxInjectedRecords.get())
    let text = renderTail(
      firstStep
        ? {
          orientation: this.config.orientationEnabled.get() ? renderOrientation(now) : undefined,
          identity: this.identityRecords(admission, already, now),
          due: this.dueRecords(admission, already, now),
          recall,
        }
        : { recall },
      { maxChars: this.config.maxInjectedChars.get() },
    )
    if (text === '' && firstStep && this.config.residentIndex.get()) {
      const index = renderIndex(this.visible(agent), { maxChars: this.config.maxIndexChars.get() })
      text = index === '' ? '' : `<prism-memory-index>\n${index}\n</prism-memory-index>`
    }
    return text
  }

  /**
   * Standing memory for a first turn: live records on a configured identity
   * layer, which are worth stating before anything is asked for.
   * @param admission - the caller's scope admission.
   * @param already - ids this session has already received.
   * @param now - current time in epoch milliseconds.
   * @returns the records to inject, in configured layer order.
   */
  private identityRecords(
    admission: MemoryAdmission,
    already: ReadonlySet<string>,
    now: number,
  ): MemoryRecord[] {
    const layers = assertIdentityLayers(this.config.identityLayers.get())
    if (layers.length === 0) return []
    const order = new Map(layers.map((layer, index) => [layer, index]))
    return this.all()
      .filter(record => (
        order.has(layerOf(record))
        && isLive(record, now)
        && !already.has(record.id)
        && admission.isEligible(record)
      ))
      .sort((left, right) => (
        (order.get(layerOf(left)) ?? 0) - (order.get(layerOf(right)) ?? 0)
        || right.createdAt - left.createdAt
        || (left.id < right.id ? -1 : 1)
      ))
      .slice(0, this.config.maxIdentityRecords.get())
  }

  /**
   * Records whose recorded date has arrived or is close enough to matter. This
   * is what makes a memory actionable rather than merely true.
   * @param admission - the caller's scope admission.
   * @param already - ids this session has already received.
   * @param now - current time in epoch milliseconds.
   * @returns dated records, soonest first.
   */
  private dueRecords(
    admission: MemoryAdmission,
    already: ReadonlySet<string>,
    now: number,
  ): MemoryRecord[] {
    if (!this.config.reminderEnabled.get()) return []
    const horizon = now + this.config.reminderWindowDays.get() * DAY_MS
    return this.all()
      .filter(record => (
        record.dueAt !== null
        && record.dueAt !== undefined
        && record.dueAt <= horizon
        && isLive(record, now)
        && !already.has(record.id)
        && admission.isEligible(record)
      ))
      .sort((left, right) => (left.dueAt ?? 0) - (right.dueAt ?? 0) || (left.id < right.id ? -1 : 1))
      .slice(0, this.config.maxReminders.get())
  }

  /**
   * Resolve the durable scope fields for one write.
   * @param agent - The calling agent, when the caller is model-facing.
   * @param scope - Requested scope; defaults to global.
   * @returns the stored scope and scope key.
   */
  resolveScope(agent: Agent | undefined, scope: MemoryScope | undefined): { scope: MemoryScope, scopeKey: string } {
    const requested = scope ?? 'global'
    if (!MEMORY_SCOPES.includes(requested)) {
      throw new PrismMemoryError(`unknown memory scope: ${String(requested)}`, 'PRISM_MEMORY_INVALID_SCOPE')
    }
    const admission = this.admission(agent)
    if (requested === 'project') {
      if (admission.cwd === null) {
        throw new PrismMemoryError('project-scoped memory requires a session working directory', 'PRISM_MEMORY_NO_WORKSPACE')
      }
      return { scope: requested, scopeKey: admission.cwd }
    }
    if (requested === 'conversation') {
      if (admission.sessionId === null) {
        throw new PrismMemoryError('conversation-scoped memory requires a calling session', 'PRISM_MEMORY_NO_SESSION')
      }
      return { scope: requested, scopeKey: admission.sessionId }
    }
    return { scope: 'global', scopeKey: '' }
  }

  /**
   * Resolve the status one write takes.
   *
   * Two rules are absolute and bind every writer: `requireApproval` means nothing
   * becomes live without a human, and a claim below `pendingBelowConfidence` is
   * not certain enough to inject on its own. Only past those does the writer's own
   * choice apply, which is what lets an automatic pass name `active` for a class
   * of claim the deployment trusts while a low-confidence inference still parks.
   * @param requested - the status the writer asked for, when it named one.
   * @param confidence - the certainty the claim is being written with.
   * @returns the status to store.
   */
  private admissionStatus(requested: AdmissionStatus | undefined, confidence: number): AdmissionStatus {
    if (this.config.requireApproval.get()) return 'pending'
    if (confidence < this.config.pendingBelowConfidence.get()) return 'pending'
    return requested ?? 'active'
  }

  /** The oldest archived record, the eviction candidate when the store is full. */
  private evictionCandidate(): MemoryRecord | undefined {
    let oldest: MemoryRecord | undefined
    for (const record of this.all()) {
      if (record.status !== 'archived') continue
      if (oldest === undefined || record.updatedAt < oldest.updatedAt) oldest = record
    }
    return oldest
  }

  /**
   * Store one memory.
   *
   * Two writes may already cover the same claim. An identical one (similarity at
   * or above `dedupeReplaceJaccard`) is not stored twice: the existing record is
   * reused and its reuse count rises, which keeps the corpus a set of claims
   * rather than a pile of paraphrases. A merely similar one is stored, and the
   * near-duplicates it competes with come back in the result so the caller can
   * supersede instead of leaving two live phrasings to rank against each other.
   * @param input - Text, kind, scope, tags, confidence, evidence, and optional supersede target.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the stored record, whether it was new, and its near-duplicates.
   */
  async remember(input: RememberInput, agent: Agent | undefined): Promise<RememberResult> {
    const now = Date.now()
    const kind = input.kind ?? 'fact'
    if (!MEMORY_KINDS.includes(kind)) {
      throw new PrismMemoryError(`unknown memory kind: ${String(kind)}`, 'PRISM_MEMORY_INVALID_KIND')
    }
    const text = normalizeText(input.text, this.config.maxTextChars.get())
    const { scope, scopeKey } = this.resolveScope(agent, input.scope)
    const admission = this.admission(agent)
    const corpus = this.all()

    const near = findNearDuplicates(corpus, { kind, scope, text }, {
      threshold: this.config.dedupeJaccard.get(),
      isEligible: admission.isEligible,
      now,
    })
    const identical = near.find(entry => entry.similarity >= this.config.dedupeReplaceJaccard.get())
    if (identical !== undefined) {
      // A claim arriving again from a *different* conversation is evidence the
      // write path cannot otherwise record, and the consolidation pass reads it.
      const writer = agent?.session.id ?? null
      const independent = writer !== null && writer !== identical.record.evidence.sessionId
      const reuse = writer === null || !independent ? 0 : 1
      const reused = await this.records.update(identical.record.id, current => ({
        ...current,
        hits: current.hits + 1,
        corroborations: (current.corroborations ?? 0) + reuse,
        updatedAt: now,
      }))
      return {
        record: reused,
        outcome: 'existing',
        duplicates: near.map(entry => ({ id: entry.record.id, similarity: entry.similarity, text: entry.record.text })),
      }
    }

    if (this.records.size >= this.config.maxRecords.get()) {
      const candidate = this.evictionCandidate()
      if (candidate === undefined) {
        throw new PrismMemoryError(
          `memory capacity ${this.config.maxRecords.get()} reached with nothing archived to evict`,
          'PRISM_MEMORY_FULL',
        )
      }
      await this.records.delete(candidate.id)
    }

    const confidence = input.confidence ?? 1
    const id = `mem_${randomUUID()}`
    const status = this.admissionStatus(input.status, confidence)
    const suppliedTags = normalizeTags(input.tags, this.config.maxTags.get())
    const tags = suppliedTags.length > 0 || !this.config.autoTag.get()
      ? suppliedTags
      : suggestTags(text, corpus.map(recordTokens), this.config.maxTags.get())
    const record: MemoryRecord = {
      id,
      scope,
      scopeKey,
      kind,
      layer: input.layer ?? DEFAULT_LAYER,
      text,
      tags,
      status,
      confidence,
      createdAt: now,
      updatedAt: now,
      validAt: input.validAt ?? now,
      invalidAt: null,
      supersedes: null,
      supersededBy: null,
      evidence: {
        sessionId: agent?.session.id ?? null,
        messageId: input.evidenceMessage?.id ?? null,
        textHash: input.evidenceMessage?.textHash ?? null,
        note: input.evidenceNote ?? null,
      },
      hits: 0,
      expiresAt: deadlineFrom(now, input.ttlDays ?? this.config.defaultTtlDays.get()),
      dueAt: input.dueAt ?? null,
      origin: input.origin ?? 'model',
    }
    if (input.supersedes !== undefined) {
      const previous = this.records.get(input.supersedes)
      if (previous === undefined) {
        throw new PrismMemoryError(`unknown memory id: ${input.supersedes}`, 'PRISM_MEMORY_NOT_FOUND')
      }
      if (!admission.isEligible(previous)) {
        throw new PrismMemoryError(`memory ${input.supersedes} is outside the caller's scope`, 'PRISM_MEMORY_OUT_OF_SCOPE')
      }
      record.supersedes = previous.id
      await this.records.put(previous.id, {
        ...previous,
        status: 'superseded',
        invalidAt: now,
        supersededBy: id,
        updatedAt: now,
      })
    }
    await this.records.put(id, record)
    return {
      record,
      outcome: 'created',
      duplicates: near.map(entry => ({ id: entry.record.id, similarity: entry.similarity, text: entry.record.text })),
    }
  }

  /**
   * Rank the caller-visible corpus against a literal query.
   *
   * `pending` records are included. Search visibility and injection are separate
   * decisions: a write the model made is a write the model must be able to find
   * again, whatever confidence it carried, while a pending record never injects.
   * @param query - Literal query text.
   * @param agent - The calling agent, when the caller is model-facing.
   * @param options - Optional result cap and attribution narrowing.
   * @returns ranked hits.
   */
  search(
    query: string,
    agent: Agent | undefined,
    options: { readonly limit?: number, readonly sessionId?: string } = {},
  ): MemoryHit[] {
    return this.rankIn(query, this.admission(agent), options)
  }

  /**
   * Rank the whole corpus against a literal query, for the operator surface.
   *
   * The retrieval model and the admitted statuses are {@link search}'s; only the
   * scope narrow differs, because this caller has no session to derive one from.
   * @param query - Literal query text.
   * @param options - Optional result cap.
   * @returns ranked hits.
   */
  operatorSearch(query: string, options: { readonly limit?: number } = {}): MemoryHit[] {
    return this.rankIn(query, WHOLE_STORE, options)
  }

  /** Shared body of the two searches: one retrieval model, one caller narrow. */
  private rankIn(
    query: string,
    admission: MemoryAdmission,
    options: { readonly limit?: number, readonly sessionId?: string },
  ): MemoryHit[] {
    const cap = this.config.searchLimit.get()
    const requested = options.limit ?? cap
    const limit = Math.min(Math.max(1, Math.trunc(requested)), cap)
    return rankRecords(this.all(), query, {
      isEligible: admission.isEligible,
      statuses: SEARCH_STATUSES,
      limit,
      ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
    })
  }

  /**
   * Read one memory by exact id and record the read as a reuse signal.
   * @param id - Opaque memory id.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the record.
   */
  async open(id: string, agent: Agent | undefined): Promise<MemoryRecord> {
    return this.records.update(this.require(id, agent).id, current => ({
      ...current,
      hits: current.hits + 1,
      updatedAt: Date.now(),
    }))
  }

  /**
   * Stop injecting one memory without destroying it.
   * @param id - Opaque memory id.
   * @param reason - Optional operator note appended to the record's evidence.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the retired record.
   */
  async forget(id: string, reason: string | undefined, agent: Agent | undefined): Promise<MemoryRecord> {
    const target = this.require(id, agent)
    const now = Date.now()
    return this.records.update(target.id, record => ({
      ...record,
      status: 'archived',
      invalidAt: record.invalidAt ?? now,
      updatedAt: now,
      ...reason === undefined ? {} : { evidence: { ...record.evidence, note: reason } },
    }))
  }

  /**
   * List caller-visible records, newest first.
   * @param agent - The calling agent, when the caller is model-facing.
   * @param options - Optional status filter and result cap.
   * @returns the selected records.
   */
  list(
    agent: Agent | undefined,
    options: { readonly statuses?: readonly MemoryRecord['status'][], readonly limit?: number } = {},
  ): MemoryRecord[] {
    const statuses = options.statuses ?? MEMORY_STATUSES
    const limit = options.limit ?? 50
    return this.visible(agent)
      .filter(record => statuses.includes(record.status))
      .sort(newestFirst)
      .slice(0, limit)
  }

  /**
   * The L0 index for the caller's visible corpus.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the index text, or an empty string.
   */
  index(agent: Agent | undefined): string {
    return renderIndex(this.visible(agent), { maxChars: this.config.maxIndexChars.get() })
  }

  /**
   * Browse the caller-visible corpus by originating conversation.
   * @param agent - The calling agent, when the caller is model-facing.
   * @param options - Bucket cap and clock.
   * @returns conversation buckets, newest first.
   */
  conversations(
    agent: Agent | undefined,
    options: { readonly limit?: number, readonly now?: number } = {},
  ): ConversationBucket[] {
    return groupConversations(this.visible(agent), {
      limit: options.limit ?? 20,
      ...options.now === undefined ? {} : { now: options.now },
    })
  }

  /**
   * Read one record's supersede chain, oldest first: every claim it replaced,
   * then every claim that replaced it. This is the audit read behind a
   * rollback, and the answer to "what did this used to say".
   * @param id - Opaque memory id.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the chain, oldest first.
   */
  history(id: string, agent: Agent | undefined): MemoryRecord[] {
    const start = this.require(id, agent)
    const admission = this.admission(agent)
    const chain: MemoryRecord[] = []
    const seen = new Set<string>()
    let cursor: MemoryRecord | undefined = start
    while (cursor !== undefined && chain.length < MAX_CHAIN_LENGTH) {
      if (seen.has(cursor.id)) break
      seen.add(cursor.id)
      const previous: MemoryRecord | undefined = cursor.supersedes === null
        ? undefined
        : this.records.get(cursor.supersedes)
      if (previous === undefined || !admission.isEligible(previous)) break
      chain.unshift(previous)
      cursor = previous
    }
    chain.push(start)
    cursor = start
    while (cursor !== undefined && chain.length < MAX_CHAIN_LENGTH) {
      const next: MemoryRecord | undefined = cursor.supersededBy === null
        ? undefined
        : this.records.get(cursor.supersededBy)
      if (next === undefined || seen.has(next.id) || !admission.isEligible(next)) break
      seen.add(next.id)
      chain.push(next)
      cursor = next
    }
    return chain
  }

  /**
   * Roll a record back to current.
   *
   * Rollback is invalidation in the other direction, so it stays auditable: the
   * restored record becomes active again, and a live successor is archived with
   * the rollback recorded in its evidence, never deleted.
   * @param id - Opaque memory id to restore.
   * @param reason - Optional operator note.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the restored record.
   */
  async restore(id: string, reason: string | undefined, agent: Agent | undefined): Promise<MemoryRecord> {
    const target = this.require(id, agent)
    if (target.status === 'active') {
      throw new PrismMemoryError(`memory ${id} is already active`, 'PRISM_MEMORY_ALREADY_ACTIVE')
    }
    const now = Date.now()
    const successor = target.supersededBy === null ? undefined : this.records.get(target.supersededBy)
    const admission = this.admission(agent)
    if (successor !== undefined && successor.status === 'active' && admission.isEligible(successor)) {
      await this.records.update(successor.id, record => ({
        ...record,
        status: 'archived',
        invalidAt: now,
        updatedAt: now,
        evidence: { ...record.evidence, note: `replaced by rollback to ${target.id}` },
      }))
    }
    return this.records.update(target.id, record => ({
      ...record,
      status: 'active',
      invalidAt: null,
      restoredAt: now,
      updatedAt: now,
      supersededBy: null,
      ...reason === undefined ? {} : { evidence: { ...record.evidence, note: reason } },
    }))
  }

  // --- Governance -----------------------------------------------------------

  /**
   * The review inbox: records held back from injection until a human decides.
   * Approval is deliberately absent from the model tool surface, so a pending
   * record can only be promoted by an operator.
   * @param agent - The calling agent, when the caller is model-facing.
   * @param options - Result cap.
   * @returns pending records, newest first.
   */
  review(agent: Agent | undefined, options: { readonly limit?: number } = {}): MemoryRecord[] {
    return this.list(agent, { statuses: ['pending'], limit: options.limit ?? 50 })
  }

  /**
   * Promote one pending record to active.
   * @param id - Opaque memory id.
   * @param note - Optional operator note.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the promoted record.
   */
  approve(id: string, note: string | undefined, agent: Agent | undefined): Promise<MemoryRecord> {
    return this.settleReview(id, 'active', note, this.admission(agent))
  }

  /**
   * Reject one pending record: it is archived and never injects.
   * @param id - Opaque memory id.
   * @param reason - Optional operator note.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the archived record.
   */
  reject(id: string, reason: string | undefined, agent: Agent | undefined): Promise<MemoryRecord> {
    return this.settleReview(id, 'archived', reason, this.admission(agent))
  }

  /**
   * Promote one pending record from the operator surface, which has no session.
   * @param id - Opaque memory id.
   * @param note - Optional operator note.
   * @returns the promoted record.
   */
  operatorApprove(id: string, note?: string): Promise<MemoryRecord> {
    return this.settleReview(id, 'active', note, WHOLE_STORE)
  }

  /**
   * Reject one pending record from the operator surface, which has no session.
   * @param id - Opaque memory id.
   * @param reason - Optional operator note.
   * @returns the archived record.
   */
  operatorReject(id: string, reason?: string): Promise<MemoryRecord> {
    return this.settleReview(id, 'archived', reason, WHOLE_STORE)
  }

  /** Shared body of approve and reject: both require a pending record. */
  private async settleReview(
    id: string,
    status: 'active' | 'archived',
    note: string | undefined,
    admission: MemoryAdmission,
  ): Promise<MemoryRecord> {
    const target = this.requireIn(id, admission)
    if (target.status !== 'pending') {
      throw new PrismMemoryError(
        `memory ${id} is ${target.status}, not pending, so there is no review to settle`,
        'PRISM_MEMORY_NOT_PENDING',
      )
    }
    const now = Date.now()
    return this.records.update(target.id, record => ({
      ...record,
      status,
      updatedAt: now,
      reviewedAt: now,
      reviewNote: note ?? null,
      ...status === 'archived' ? { invalidAt: record.invalidAt ?? now } : {},
    }))
  }

  /**
   * Run one hygiene pass.
   *
   * A dry run is the default: it reports exactly what a committed pass would do,
   * because the store is the user's accumulated knowledge and an unattended
   * sweep must be inspectable before it changes anything.
   * @param options - Whether to commit, and the clock.
   * @returns what the pass found and, when committed, what it changed.
   */
  async maintain(options: { readonly apply?: boolean, readonly now?: number } = {}): Promise<MaintenanceReport> {
    const applied = options.apply ?? false
    const now = options.now ?? Date.now()
    const totalBefore = this.records.size
    const expired: string[] = []
    const duplicates: { keep: string, drop: string, similarity: number }[] = []
    const evicted: string[] = []
    const orphaned: string[] = []

    const corpus = this.all()
    const byId = new Map(corpus.map(record => [record.id, record]))
    const orphanedParents: string[] = []
    for (const record of corpus) {
      const successor = record.supersededBy === null ? undefined : byId.get(record.supersededBy)
      if (record.supersededBy !== null && successor === undefined) orphaned.push(record.id)
      // Only a digest carries parents, so the link points digest → claim; an
      // evicted claim is the one way it stops resolving.
      if ((record.parents ?? []).some(parent => !byId.has(parent))) orphanedParents.push(record.id)
    }

    // Expiry first: an expired record should not be paired as a merge survivor.
    const expiredTargets = corpus.filter(record => record.status === 'active' && isExpired(record, now))
    for (const record of expiredTargets) expired.push(record.id)

    const live = corpus.filter(record => isLive(record, now) && !expiredTargets.includes(record))
    const claimed = new Set<string>()
    for (const [index, record] of live.entries()) {
      if (claimed.has(record.id)) continue
      const later = live.slice(index + 1).filter(candidate => !claimed.has(candidate.id))
      const match = findNearDuplicates(later, record, {
        // Maintenance consolidates at the reporting floor, not the write-reuse
        // floor: a write merely reports a paraphrase so the caller can decide,
        // while an operator running this pass has decided to merge them.
        threshold: this.config.dedupeJaccard.get(),
        limit: 1,
        now,
      })[0]
      if (match === undefined) continue
      // Keep the record a reader would keep: higher confidence, then newer.
      const [survivor, dropped] = match.record.confidence > record.confidence
        ? [match.record, record]
        : [record, match.record]
      claimed.add(dropped.id)
      duplicates.push({ keep: survivor.id, drop: dropped.id, similarity: match.similarity })
    }

    let projected = totalBefore - expired.length - duplicates.length
    const evictionCandidates = corpus
      .filter(record => record.status === 'archived' && !expiredTargets.includes(record))
      .sort((left, right) => left.updatedAt - right.updatedAt)
    for (const candidate of evictionCandidates) {
      if (projected < this.config.maxRecords.get()) break
      evicted.push(candidate.id)
      projected -= 1
    }

    if (applied) {
      for (const id of expired) {
        await this.records.update(id, record => ({
          ...record,
          status: 'archived',
          invalidAt: record.invalidAt ?? now,
          updatedAt: now,
          evidence: { ...record.evidence, note: record.evidence.note ?? 'archived by maintenance: time-to-live elapsed' },
        }))
      }
      for (const pair of duplicates) {
        await this.records.update(pair.drop, record => ({
          ...record,
          status: 'archived',
          invalidAt: record.invalidAt ?? now,
          updatedAt: now,
          mergedInto: pair.keep,
          evidence: { ...record.evidence, note: `merged into ${pair.keep} by maintenance` },
        }))
      }
      for (const id of evicted) await this.records.delete(id)
    }

    return {
      applied,
      expired,
      duplicates,
      evicted,
      orphaned,
      orphanedParents,
      totalBefore,
      totalAfter: applied ? this.records.size : projected,
    }
  }

  // --- Automatic memory -----------------------------------------------------

  /**
   * The turn-end pass: read the closing turn's own text, then consolidate when
   * the window has filled.
   *
   * Both run on the turn's path rather than on a timer, so memory keeps up with
   * a session without a scheduler, and neither is on the critical path of the
   * model request: distillation writes records, and nothing it writes reaches a
   * request until a later turn recalls it.
   * @param agent - the agent whose turn is closing.
   */
  private async afterTurn(agent: Agent): Promise<void> {
    if (this.config.autoDistill.get()) await this.distillTurn(agent)
    if (this.config.dreamEnabled.get() && this.dreamWindow(Date.now()) !== null) {
      await this.dream({ apply: true })
    }
  }

  /**
   * Read the closing turn for durable claims, without an extra model call.
   *
   * Both sides are read: the person's message carries the constraints and
   * preferences they stated, and the assistant's own account carries the causes
   * it established. Each claim cites the message its sentence came from, with
   * that message's write-time fingerprint, so a later `/memory verify` can
   * re-read it. A candidate an identical claim already covers is dropped
   * rather than written, because the write path would only raise that record's
   * reuse count, and an automatic pass must not inflate a signal that ranking
   * reads as evidence of use.
   * @param agent - the agent whose turn is closing.
   */
  private async distillTurn(agent: Agent): Promise<void> {
    const limit = this.config.autoDistillLimit.get()
    const candidates = turnMessages(agent.session.deriveMessages()).flatMap(message => {
      const text = messageText(message)
      return distillCandidates(text, { limit }).map(candidate => ({
        ...candidate,
        evidence: { id: message.id, textHash: textFingerprint(text) },
      }))
    })
    if (candidates.length === 0) return
    const admission = this.admission(agent)
    const now = Date.now()
    const stored: string[] = []
    for (const candidate of candidates) {
      if (stored.length >= limit) break
      if (stored.includes(candidate.text)) continue
      const scope: MemoryScope = candidate.layer === 'project' && admission.cwd !== null ? 'project' : 'global'
      // Every status counts as known. A claim this pass already parked is a claim
      // it has already read, and one an operator rejected must not be proposed
      // again on every following turn.
      if (this.hasIdenticalClaim(candidate.kind, scope, candidate.text, now, MEMORY_STATUSES)) continue
      await this.remember({
        text: candidate.text,
        kind: candidate.kind,
        layer: candidate.layer,
        scope,
        confidence: this.config.autoDistillConfidence.get(),
        origin: 'session',
        status: this.config.autoDistillStatus.get(),
        evidenceMessage: candidate.evidence,
      }, agent)
      stored.push(candidate.text)
    }
  }

  /**
   * Whether the same claim already stands, in which case a write would store
   * nothing and only move a reuse counter.
   * @param kind - the candidate's claim class.
   * @param scope - the candidate's visibility class.
   * @param text - the candidate's claim.
   * @param now - current time in epoch milliseconds.
   * @param statuses - statuses that count as holding the claim; omitted, only a live record does.
   * @returns true when the corpus already holds this claim.
   */
  private hasIdenticalClaim(
    kind: MemoryKind,
    scope: MemoryScope,
    text: string,
    now: number,
    statuses?: readonly MemoryStatus[],
  ): boolean {
    return findNearDuplicates(this.all(), { kind, scope, text }, {
      threshold: this.config.dedupeReplaceJaccard.get(),
      isEligible: () => true,
      now,
      ...statuses === undefined ? {} : { statuses },
    }).length > 0
  }

  /**
   * The material one consolidation pass would consider, or `null` when the window
   * has not filled and no daily account is due.
   *
   * The window boundary is the corpus itself rather than a counter: it is the
   * last journal entry's write time, so it survives a restart, a fork, and a
   * second process reading the same store, none of which a private counter would.
   * @param now - current time in epoch milliseconds.
   * @returns the window, or `null` when there is nothing to do.
   */
  private dreamWindow(
    now: number,
  ): {
    readonly candidates: readonly MemoryRecord[]
    readonly reflection: { readonly since: number, readonly until: number } | null
    readonly triggered: boolean
  } | null {
    const since = this.newestTagged([DREAM_TAG])?.createdAt ?? 0
    const internal = new Set<string>([DREAM_TAG, REFLECTION_TAG, TOPIC_TAG])
    const written = this.all().filter(record => (
      record.createdAt > since && !record.tags.some(tag => internal.has(tag))
    ))
    const day = new Date(now)
    day.setHours(0, 0, 0, 0)
    const dayStart = day.getTime()
    const previousDayStart = dayStart - DAY_MS
    // A reflection reports a completed day, so it is due only once the clock has
    // rolled over and only when that day actually wrote something. Reporting a
    // day that is still running would mean reporting a number that keeps moving.
    const wrotePreviousDay = this.all().some(record => (
      record.createdAt > previousDayStart
      && record.createdAt <= dayStart
      && !record.tags.some(tag => internal.has(tag))
    ))
    const lastReflection = this.newestTagged([REFLECTION_TAG])
    const reflection = this.config.dailyReflection.get()
      && wrotePreviousDay
      && (lastReflection === undefined || lastReflection.createdAt < dayStart)
      ? { since: previousDayStart, until: dayStart }
      : null
    const triggered = written.length >= this.config.dreamEveryWrites.get()
    if (!triggered && reflection === null) return null
    const candidates = written
      .filter(record => isLive(record, now))
      .sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : 1))
      .slice(0, this.config.dreamWindowRecords.get())
    return { candidates, reflection, triggered }
  }

  /** The newest record carrying one of these tags, which fixes a window boundary. */
  private newestTagged(tags: readonly string[]): MemoryRecord | undefined {
    return this.all()
      .filter(record => record.tags.some(tag => tags.includes(tag)))
      .sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1))[0]
  }

  /**
   * Run one consolidation pass.
   *
   * A dry run is the default, for the same reason maintenance's is: the pass
   * writes records the model will later read, so an operator must be able to see
   * what it concluded before it is committed. What it never does is decide a
   * contradiction — those are reported for a person.
   * @param options - whether to commit, and the clock.
   * @returns what the pass found and, when committed, what it wrote.
   */
  async dream(options: { readonly apply?: boolean, readonly now?: number } = {}): Promise<DreamReport> {
    const applied = options.apply ?? false
    const now = options.now ?? Date.now()
    const window = this.dreamWindow(now)
    const plan = planDream({
      candidates: window?.candidates ?? [],
      corpus: this.all(),
      now,
      corroborationFloor: CORROBORATION_FLOOR,
      conflictFloor: this.config.dreamConflictFloor.get(),
      duplicateFloor: this.config.dedupeReplaceJaccard.get(),
      clusterFloor: this.config.dreamClusterFloor.get(),
      maxTopics: this.config.dreamMaxTopics.get(),
      maxMembers: DREAM_DIGEST_MEMBERS,
      maxDigestChars: DREAM_DIGEST_CHARS,
    })
    const report: DreamReport = {
      applied,
      scanned: plan.scanned,
      corroborated: plan.corroborated,
      topics: plan.topics,
      conflicts: plan.conflicts,
      journalId: null,
      reflectionId: null,
    }
    if (!applied) return report

    for (const entry of plan.corroborated) {
      const record = this.records.get(entry.id)
      if (record === undefined || (record.corroboratedAt ?? null) !== null) continue
      await this.records.update(entry.id, current => ({ ...current, corroboratedAt: now, updatedAt: now }))
    }
    for (const topic of plan.topics) {
      await this.putAutomatic({
        text: topic.text,
        tags: [topic.tag, TOPIC_TAG],
        // A digest is machine-written prose about other records. It is offered
        // for review rather than injected, because a wrong index entry would
        // misdirect every later recall through it.
        status: 'pending',
        layer: 'topic',
        kind: 'fact',
        note: `topic digest over ${topic.memberIds.join(', ')}`,
        parents: topic.memberIds,
      }, now)
    }
    const journal = window?.triggered === true || plan.corroborated.length > 0
      || plan.topics.length > 0 || plan.conflicts.length > 0
      ? await this.putAutomatic({
        text: renderDreamJournal(plan),
        tags: [DREAM_TAG],
        status: 'archived',
        layer: 'topic',
        kind: 'fact',
        note: 'consolidation pass',
      }, now)
      : null
    let reflectionId: string | null = null
    if (window?.reflection !== null && window?.reflection !== undefined) {
      const reflection = await this.putAutomatic({
        text: renderReflection(this.all(), window.reflection),
        tags: [REFLECTION_TAG],
        status: 'archived',
        layer: 'topic',
        kind: 'fact',
        note: 'daily reflection',
      }, now)
      reflectionId = reflection.id
    }
    return { ...report, journalId: journal?.id ?? null, reflectionId }
  }

  /**
   * Store a record this plugin generated for itself, without the write path's
   * dedupe: journal entries and digests are dated accounts, not claims, and two
   * identical ones from different days are two different facts.
   * @param input - the record to store.
   * @param now - current time in epoch milliseconds.
   * @returns the stored record.
   */
  private async putAutomatic(input: AutomaticRecordInput, now: number): Promise<MemoryRecord> {
    if (this.records.size >= this.config.maxRecords.get()) {
      const candidate = this.evictionCandidate()
      if (candidate !== undefined) await this.records.delete(candidate.id)
    }
    const record: MemoryRecord = {
      id: `mem_${randomUUID()}`,
      scope: 'global',
      scopeKey: '',
      kind: input.kind,
      layer: input.layer,
      text: input.text,
      tags: [...input.tags],
      status: input.status,
      confidence: 1,
      createdAt: now,
      updatedAt: now,
      validAt: now,
      invalidAt: input.status === 'archived' ? now : null,
      supersedes: null,
      supersededBy: null,
      evidence: { sessionId: null, messageId: null, note: input.note },
      hits: 0,
      expiresAt: null,
      dueAt: null,
      origin: 'operator',
      ...(input.parents === undefined ? {} : { parents: [...input.parents] }),
    }
    await this.records.put(record.id, record)
    return record
  }

  /**
   * The consolidation journal: what each pass concluded, and the daily accounts.
   * @param agent - The calling agent, when the caller is model-facing.
   * @param limit - Maximum entries, newest first.
   * @returns the journal entries.
   */
  journal(agent: Agent | undefined, limit = 20): MemoryRecord[] {
    return this.visible(agent)
      .filter(record => record.tags.includes(DREAM_TAG) || record.tags.includes(REFLECTION_TAG))
      .sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1))
      .slice(0, limit)
  }

  /**
   * Read another tool's memory files into this store.
   *
   * A dry run is the default: these files were written for a different tool with
   * a different notion of what belongs in long-term memory, so what they yield is
   * shown before it is adopted. A claim already known in the target scope is
   * counted as skipped rather than stored a second time.
   * @param options - the layouts to read, whether to commit, the clock, and the calling agent.
   * @returns what was read and, when committed, what was stored.
   */
  async importMemories(options: {
    readonly sources?: readonly string[]
    readonly apply?: boolean
    readonly now?: number
    readonly agent?: Agent
  } = {}): Promise<ImportReport> {
    const applied = options.apply ?? false
    const now = options.now ?? Date.now()
    const sources = options.sources ?? this.config.importSources.get()
    if (sources.length === 0) {
      throw new PrismMemoryError(
        `no import source named: pass one of ${IMPORT_SOURCE_IDS.join(', ')}, or set importSources on the prism-memory row`,
        'PRISM_MEMORY_NO_IMPORT_SOURCE',
      )
    }
    const admission = this.admission(options.agent)
    const files = await collectMemoryFiles(sources, { home: homedir(), cwd: admission.cwd }, {
      maxFiles: IMPORT_MAX_FILES,
      maxFileBytes: IMPORT_MAX_FILE_BYTES,
    })
    const contributed: string[] = []
    const created: string[] = []
    let scanned = 0
    let skipped = 0
    for (const file of files) {
      const claims = parseMemoryClaims(await readMemoryFile(file), { defaultLayer: file.defaultLayer })
      if (claims.length === 0) continue
      contributed.push(file.path)
      for (const claim of claims) {
        scanned += 1
        const kind = kindForLayer(claim.layer)
        const scope: MemoryScope = file.scope === 'project' && admission.cwd !== null ? 'project' : 'global'
        // Every status counts as known: a claim this importer already parked for
        // review is a claim it has read, and re-reading the file must not add it
        // again. Archived counts too, so a retired claim is not resurrected.
        if (this.hasIdenticalClaim(kind, scope, claim.text, now, MEMORY_STATUSES)) {
          skipped += 1
          continue
        }
        if (!applied) continue
        const result = await this.remember({
          text: claim.text,
          kind,
          layer: claim.layer,
          scope,
          tags: [file.sourceId],
          confidence: this.config.importConfidence.get(),
          origin: 'import',
          status: this.config.importStatus.get(),
          evidenceNote: `imported from ${file.path}`,
        }, options.agent)
        created.push(result.record.id)
      }
    }
    return { applied, sources: [...sources], files: contributed, scanned, created, skipped }
  }

  /**
   * Write the durable Markdown mirror plus its machine-readable companion.
   * @param options - Target directory and clock.
   * @returns the written files and the mirrored record count.
   */
  async exportMarkdown(options: { readonly dir?: string, readonly now?: number } = {}): Promise<ExportResult> {
    const dir = options.dir ?? this.config.exportDir.get()
    if (dir === undefined || dir.trim() === '') {
      throw new PrismMemoryError(
        'no export directory: pass one to /memory export, or set exportDir on the prism-memory row',
        'PRISM_MEMORY_NO_EXPORT_DIR',
      )
    }
    const records = this.all()
    const rendered = renderExport(records, options.now === undefined ? {} : { now: options.now })
    await mkdir(dir, { recursive: true })
    const markdownPath = join(dir, EXPORT_MARKDOWN_FILE)
    const indexPath = join(dir, EXPORT_INDEX_FILE)
    await writeAtomically(markdownPath, rendered.markdown)
    await writeAtomically(indexPath, rendered.index)
    return { dir, files: [markdownPath, indexPath], total: records.length }
  }

  /** Render the model-facing browse list for {@link conversations}. */
  conversationText(agent: Agent | undefined, limit = 20): string {
    return renderConversations(this.conversations(agent, { limit }))
  }

  /**
   * The evidence anchor for a write made from this agent: the user message the
   * claim is being recorded while answering, with its write-time fingerprint.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the anchor, or `null` when there is no user message to cite.
   */
  evidenceAnchor(agent: Agent | undefined): EvidenceMessage | null {
    if (agent === undefined) return null
    const messages = agent.session.deriveMessages()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message === undefined || message.role !== 'user') continue
      const text = messageText(message)
      return { id: message.id, textHash: textFingerprint(text) }
    }
    return null
  }

  // --- Operator audits ------------------------------------------------------

  /**
   * Re-read the cited message of every record that carries one, and report
   * whether its model-visible text still matches the write-time fingerprint.
   *
   * The surface is read through the session-query engine, which prefers a live
   * session and falls back to the persisted log, so the comparison sees the same
   * projection surface the write did. A record citing no message carries
   * nothing to verify and is counted, not listed.
   * @returns one verdict per citing record and the uncited count.
   */
  async verifyEvidence(): Promise<VerificationReport> {
    const corpus = this.all()
    const cited = corpus.filter(record => record.evidence.messageId !== null).sort(newestFirst)
    const uncited = corpus.length - cited.length
    const reader = this.sessionReader
    if (reader === undefined) {
      return {
        verdicts: cited.map(record => ({ id: record.id, outcome: 'unavailable' as const })),
        uncited,
        readerUnavailable: true,
      }
    }
    // One read per cited session: the surface map answers every record citing
    // it. A session that could not be read is left unset, which the verdict
    // step reports as `unavailable` rather than as a missing source.
    const sessionIds = new Set(cited.map(record => record.evidence.sessionId)
      .filter((sessionId): sessionId is string => sessionId !== null))
    const surfaces = new Map<string, Map<string, string>>()
    for (const sessionId of sessionIds) {
      const texts = await readSurfaceTexts(reader, sessionId)
      if (texts !== undefined) surfaces.set(sessionId, texts)
    }
    const verdicts = cited.map(record => {
      const sessionId = record.evidence.sessionId
      const messageId = record.evidence.messageId
      const textHash = record.evidence.textHash ?? null
      if (sessionId === null || messageId === null || textHash === null) {
        // A cite without its session, message id, or fingerprint cannot resolve.
        return { id: record.id, outcome: 'missing' as const }
      }
      const surface = surfaces.get(sessionId)
      if (surface === undefined) return { id: record.id, outcome: 'unavailable' as const }
      const text = surface.get(messageId)
      if (text === undefined) return { id: record.id, outcome: 'missing' as const }
      return {
        id: record.id,
        outcome: textFingerprint(text) === textHash ? ('intact' as const) : ('drifted' as const),
      }
    })
    return { verdicts, uncited, readerUnavailable: false }
  }

  /**
   * Set two claims side by side for a person, with the mechanical facts and a
   * mechanical verdict over the deployment's own thresholds. The verdict is
   * vocabulary, not a decision: equivalent claims keep both identities and
   * sources, complementary claims leave any ordering to the reader, and
   * conflicting claims are preserved with their conditions — nothing here
   * merges, retires, or rewrites either record.
   * @param idA - One record's id.
   * @param idB - The other record's id.
   * @returns both records, their similarity, and the verdict.
   */
  operatorCompare(idA: string, idB: string): ComparisonReport {
    if (idA === idB) {
      throw new PrismMemoryError('comparing a record with itself says nothing', 'PRISM_MEMORY_COMPARE_SAME')
    }
    const left = this.records.get(idA)
    if (left === undefined) throw new PrismMemoryError(`unknown memory id: ${idA}`, 'PRISM_MEMORY_NOT_FOUND')
    const right = this.records.get(idB)
    if (right === undefined) throw new PrismMemoryError(`unknown memory id: ${idB}`, 'PRISM_MEMORY_NOT_FOUND')
    const similarity = jaccard(tokenize(left.text), tokenize(right.text))
    const sharedTags = left.tags.filter(tag => right.tags.includes(tag))
    const equivalentFloor = this.config.dedupeJaccard.get()
    const conflictFloor = this.config.dreamConflictFloor.get()
    const verdict = similarity >= equivalentFloor
      ? 'equivalent'
      : sharedTags.length > 0 && similarity >= conflictFloor
        ? 'conflicting'
        : sharedTags.length > 0 ? 'complementary' : 'unrelated'
    return { left, right, similarity, sharedTags, verdict, relation: relationBetween(left, right) }
  }

  /**
   * Compare an existing mirror against what the current store would render,
   * without writing. Both files are compared byte for byte, which is exact: any
   * store change since the last export reads as stale.
   * @param options - Target directory; defaults to the configured export directory.
   * @returns each mirrored file's state.
   */
  async checkExport(options: { readonly dir?: string } = {}): Promise<ExportCheckResult> {
    const dir = options.dir ?? this.config.exportDir.get()
    if (dir === undefined || dir.trim() === '') {
      throw new PrismMemoryError(
        'no export directory: pass one to /memory export check, or set exportDir on the prism-memory row',
        'PRISM_MEMORY_NO_EXPORT_DIR',
      )
    }
    const rendered = renderExport(this.all(), {})
    const markdownPath = join(dir, EXPORT_MARKDOWN_FILE)
    const indexPath = join(dir, EXPORT_INDEX_FILE)
    const [markdown, index] = await Promise.all([
      mirroredFileState(markdownPath, rendered.markdown),
      mirroredFileState(indexPath, rendered.index),
    ])
    return { dir, markdown, index }
  }

  /** Resolve one id the caller may act on, returning the record or failing with the reason it cannot. */
  private require(id: string, agent: Agent | undefined): MemoryRecord {
    return this.requireIn(id, this.admission(agent))
  }

  /** One record one admission admits. */
  private requireIn(id: string, admission: MemoryAdmission): MemoryRecord {
    const record = this.records.get(id)
    if (record === undefined) {
      throw new PrismMemoryError(`unknown memory id: ${id}`, 'PRISM_MEMORY_NOT_FOUND')
    }
    if (!admission.isEligible(record)) {
      throw new PrismMemoryError(`memory ${id} is outside the caller's scope`, 'PRISM_MEMORY_OUT_OF_SCOPE')
    }
    return record
  }
}

/**
 * Reject a configuration whose bounds contradict each other or name something
 * that does not exist, at load rather than at the first write. Single-field
 * bounds are already schema constraints; what remains are the relations between
 * fields and the names that must resolve against a taxonomy.
 * @param config - the validated deployment configuration.
 */
function assertBounds(config: PrismMemoryConfig): void {
  const replace = config.dedupeReplaceJaccard.get()
  const report = config.dedupeJaccard.get()
  if (replace < report) {
    throw new Error(
      `prism-memory dedupeReplaceJaccard (${replace}) must be at least dedupeJaccard (${report})`,
    )
  }
  assertIdentityLayers(config.identityLayers.get())
  const cluster = config.dreamClusterFloor.get()
  if (cluster < 2) {
    throw new Error(`prism-memory dreamClusterFloor (${cluster}) must be at least 2`)
  }
  for (const id of config.importSources.get()) {
    if (!IMPORT_SOURCE_IDS.includes(id)) {
      throw new Error(
        `prism-memory importSources names an unknown source: ${id} (known: ${IMPORT_SOURCE_IDS.join(', ')})`,
      )
    }
  }
}

export default PrismMemoryService
