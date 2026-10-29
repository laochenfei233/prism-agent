/**
 * Push subscription persistence.
 *
 * One JSON array beside the VAPID keys, rewritten atomically on every change.
 * Endpoints answering 404/410 are removed by the sender through {@link remove}.
 *
 * @module @prism/prism-pocket/push
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PocketPushSubscriptionRecord } from '../types.ts'

/** Read a subscriptions file without trusting it; corrupt or missing yields empty. */
function readRecords(file: string): PocketPushSubscriptionRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRecord)
  } catch {
    return []
  }
}

/** Structural validation for one persisted subscription. */
function isRecord(value: unknown): value is PocketPushSubscriptionRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  return typeof candidate.endpoint === 'string' && candidate.endpoint.length > 0
    && typeof candidate.keys === 'object' && candidate.keys !== null
    && typeof candidate.keys.p256dh === 'string' && typeof candidate.keys.auth === 'string'
}

/** The subscription store: small, file-backed, synchronous. */
export class SubscriptionStore {
  private records: PocketPushSubscriptionRecord[]

  /**
   * @param file - absolute path of the subscriptions JSON file; created on first persist.
   */
  constructor(private readonly file: string) {
    this.records = readRecords(file)
  }

  /** Every stored subscription. */
  all(): readonly PocketPushSubscriptionRecord[] {
    return this.records
  }

  /** Stored count, for the status route. */
  get size(): number {
    return this.records.length
  }

  /**
   * Add or replace a subscription keyed by endpoint.
   * @param record - the subscription from the subscribe route.
   * @returns whether the store changed.
   */
  add(record: PocketPushSubscriptionRecord): boolean {
    const existing = this.records.findIndex(item => item.endpoint === record.endpoint)
    if (existing >= 0) {
      this.records[existing] = record
    } else {
      this.records.push(record)
    }
    this.persist()
    return true
  }

  /**
   * Drop a subscription, typically after a 404/410 from its endpoint.
   * @param endpoint - the push service endpoint URL.
   */
  remove(endpoint: string): void {
    const before = this.records.length
    this.records = this.records.filter(item => item.endpoint !== endpoint)
    if (this.records.length !== before) this.persist()
  }

  /** Rewrite the file atomically with owner-only permissions. */
  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(this.records, undefined, 2), { mode: 0o600, encoding: 'utf8' })
    renameSync(temp, this.file)
  }
}
