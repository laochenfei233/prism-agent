/**
 * Durable record schema and domain declaration for the Prism memory store.
 *
 * The domain stays at version 1 across the governance layer. Every field that
 * layer added is optional, so a store written by an earlier build reopens under
 * the current schema: `per-record` layouts validate each stored document, and a
 * required new field would have made every pre-existing record invalid (or, with
 * a version bump and no migration, made the whole domain refuse to open). New
 * fields are therefore optional and normalized on read.
 *
 * @module @prism/prism-memory/domain
 */

import { z as zod } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { MEMORY_KINDS, MEMORY_ORIGINS, MEMORY_SCOPES, MEMORY_STATUSES } from './memory.ts'
import { MEMORY_LAYERS } from './layers.ts'

/** Attribution of one record: the session and message it was distilled from. */
export const memoryEvidenceSchema = zod.object({
  /** Session the claim came from, or `null` for an operator write. */
  sessionId: zod.string().nullable(),
  /** Message within that session, when the producer knew it. */
  messageId: zod.string().nullable(),
  /** Free-form note; `memory_forget` and `/memory reject` record their reason here. */
  note: zod.string().nullable(),
})

/** Every durable field of one memory record. */
export const memoryRecordSchema = zod.object({
  /** Opaque `mem_<uuid>` identity. */
  id: zod.string().min(1),
  /** Visibility class, resolved at write time from the calling session. */
  scope: zod.enum(MEMORY_SCOPES),
  /** Scope instance: `''`, a working directory, or a session id. */
  scopeKey: zod.string(),
  /** Claim class. */
  kind: zod.enum(MEMORY_KINDS),
  /** What the claim is about. Absent on a record written before the layer axis existed. */
  layer: zod.enum(MEMORY_LAYERS).optional(),
  /** One self-contained claim. */
  text: zod.string().min(1),
  /** Recall keywords. */
  tags: zod.array(zod.string()),
  /** Lifecycle state. */
  status: zod.enum(MEMORY_STATUSES),
  /** Producer's certainty, `0..1`. */
  confidence: zod.number(),
  /** Write time, epoch milliseconds. */
  createdAt: zod.number(),
  /** Last mutation time, epoch milliseconds. */
  updatedAt: zod.number(),
  /** Start of the fact's validity window, epoch milliseconds or `null`. */
  validAt: zod.number().nullable(),
  /** End of the fact's validity window, epoch milliseconds or `null`. */
  invalidAt: zod.number().nullable(),
  /** The record this one replaced, or `null`. */
  supersedes: zod.string().nullable(),
  /** The record that replaced this one, or `null`. */
  supersededBy: zod.string().nullable(),
  /** Where the claim came from. */
  evidence: memoryEvidenceSchema,
  /** Explicit opens, incremented by `memory_open`. */
  hits: zod.number(),

  // Governance fields. Optional so a store written before the governance layer
  // still opens; readers normalize an absent value to its documented default.
  /** Time-to-live deadline, epoch milliseconds or `null` for a claim that never expires. */
  expiresAt: zod.number().nullable().optional(),
  /** Who caused the write. */
  origin: zod.enum(MEMORY_ORIGINS).optional(),
  /** When an operator approved or rejected a pending record. */
  reviewedAt: zod.number().nullable().optional(),
  /** Operator's one-line reason for the review decision. */
  reviewNote: zod.string().nullable().optional(),
  /** The duplicate this record was folded into by `maintain`. */
  mergedInto: zod.string().nullable().optional(),
  /** When an operator rolled this record back to active. */
  restoredAt: zod.number().nullable().optional(),
  /**
   * When this claim becomes actionable, epoch milliseconds or `null`. Distinct
   * from `expiresAt`, which retires the record: a due date keeps the claim live
   * and surfaces it as a reminder once the date arrives.
   */
  dueAt: zod.number().nullable().optional(),
  /**
   * Times an identical claim arrived from a *different* conversation. The write
   * that first stored the claim does not count, so `1` means one independent
   * conversation agreed. Absent on a record written before this counter existed.
   */
  corroborations: zod.number().optional(),
  /** When a consolidation pass confirmed this record's corroboration. */
  corroboratedAt: zod.number().nullable().optional(),
})

/** One stored memory record as it exists on the medium. */
export type MemoryRecord = zod.infer<typeof memoryRecordSchema>

/**
 * The memory domain: one record per document, so a supersede, an approval, or a
 * merge rewrites exactly one stored document instead of the whole corpus.
 */
export const prismMemoryDomainSpec = defineDomain({
  name: 'prism_memory',
  version: 1,
  layout: 'per-record',
  tables: { records: domainTable<string, MemoryRecord>(memoryRecordSchema) },
})
