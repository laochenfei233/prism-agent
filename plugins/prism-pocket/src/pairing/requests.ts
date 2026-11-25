/**
 * In-memory pairing requests: an anonymous applicant keeps a private ticket
 * while the owner compares its display code and decides. Nothing is persisted,
 * so a restart drops every pending request and no secret outlives the process.
 *
 * @module @prism/prism-pocket/pairing/requests
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Display-code alphabet without look-alike characters (no 0/O, no 1/I). */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'

/** Applicant identity generated in the browser and repeated across retries. */
export interface PairingCredential {
  readonly id: string
  readonly secret: string
}

/** Fixed limits; the pairing posture is a security invariant, not deployment configuration. */
export const PAIRING_LIMITS = {
  /** Lifetime of one request, including retries of an approved delivery. */
  requestTtlMs: 300_000,
  /** Maximum retained requests; terminal ones stay until they expire. */
  maxRequests: 16,
  /** Minimum interval between anonymous creations across this process. */
  requestIntervalMs: 1_000,
  /** Minimum applicant polling interval. */
  pollIntervalMs: 2_000,
} as const

/** One pending row the owner's settings page renders. */
export interface PairingRow {
  readonly id: string
  readonly code: string
  /** IP observed on the creating connection; forwarded headers are not unwrapped. */
  readonly sourceIp: string | null
  readonly expiresInMs: number
}

/** What the applicant learns when its ticket is accepted. */
export interface PairingTicket {
  readonly code: string
  readonly expiresInMs: number
}

/** The owner's decision after comparing the two displayed codes. */
export type PairingDecision = 'allow' | 'deny'

/** First committed decision, or a request no longer available for approval. */
export type PairingDecisionResult = 'approved' | 'denied' | 'unavailable'

/** Applicant polling answer; the login URL appears once the owner allows the request. */
export type PairingStatus =
  | { readonly status: 'pending' | 'denied' | 'cancelled' | 'expired' | 'slow-down' | 'unavailable' }
  | { readonly status: 'approved'; readonly url: string }

type Outcome =
  | { readonly status: 'pending' | 'denied' | 'cancelled' }
  | { readonly status: 'approved' }
  | { readonly status: 'completed'; readonly url: string }

interface PairingRecord {
  readonly id: string
  readonly code: string
  readonly secret: string
  readonly sourceIp: string | null
  readonly expiresAt: number
  nextPollAt: number
  outcome: Outcome
}

/** Owns one plugin activation's private tickets and decisions. */
export class PairingRequests {
  private readonly records = new Map<string, PairingRecord>()
  private nextCreationAt = 0

  /**
   * Allocate one ticket. Repeating an identity returns the retained ticket
   * without renewing it, and can never change an existing decision.
   * @param sourceIp - normalized IP of the creating connection, or null.
   * @param credential - caller-generated identity and secret.
   * @returns the display code, or undefined on a credential conflict, a
   * creation rate limit, or a full pool.
   */
  create(sourceIp: string | null, credential: PairingCredential): PairingTicket | undefined {
    this.prune()
    const existing = this.records.get(credential.id)
    if (existing !== undefined) {
      if (!matches(credential.secret, existing.secret)) return undefined
      return { code: existing.code, expiresInMs: existing.expiresAt - Date.now() }
    }
    const now = Date.now()
    if (now < this.nextCreationAt || this.records.size >= PAIRING_LIMITS.maxRequests) return undefined
    const record: PairingRecord = {
      ...credential,
      code: this.freshCode(),
      sourceIp,
      expiresAt: now + PAIRING_LIMITS.requestTtlMs,
      // The applicant may read its own state immediately; the interval bounds repeats.
      nextPollAt: now,
      outcome: { status: 'pending' },
    }
    this.records.set(record.id, record)
    this.nextCreationAt = now + PAIRING_LIMITS.requestIntervalMs
    return { code: record.code, expiresInMs: PAIRING_LIMITS.requestTtlMs }
  }

  /** Pending, unexpired rows without their private secrets. */
  list(): PairingRow[] {
    this.prune()
    return Array.from(this.records.values())
      .filter(record => record.outcome.status === 'pending')
      .map(record => ({
        id: record.id,
        code: record.code,
        sourceIp: record.sourceIp,
        expiresInMs: record.expiresAt - Date.now(),
      }))
  }

  /**
   * Keep the first decision when owner devices race or retry after a lost response.
   * @param id - request selected after comparing the displayed code.
   * @param decision - allow or deny access as the owner.
   * @returns the committed decision, or unavailable for an expired, cancelled,
   * or collected request.
   */
  decide(id: string, decision: PairingDecision): PairingDecisionResult {
    this.prune()
    const record = this.records.get(id)
    if (record === undefined) return 'unavailable'
    if (record.outcome.status === 'pending') {
      record.outcome = { status: decision === 'allow' ? 'approved' : 'denied' }
    }
    return record.outcome.status === 'approved' || record.outcome.status === 'denied'
      ? record.outcome.status
      : 'unavailable'
  }

  /**
   * Read or cancel one ticket; only approval yields a login URL, once per ticket.
   * A lost delivery can be retried with the same secret until the request expires,
   * receiving the same URL without extending it.
   * @param id - applicant's request identity.
   * @param secret - private ticket credential, never the display code.
   * @param cancel - withdraw the request before its approval is collected.
   * @param issueUrl - mints the single-use login URL after approval.
   * @returns request state and, only after approval, its URL.
   */
  poll(id: string, secret: string, cancel: boolean, issueUrl: () => string | undefined): PairingStatus {
    this.prune()
    const record = this.records.get(id)
    if (record === undefined || !matches(secret, record.secret)) return { status: 'expired' }
    if (cancel && record.outcome.status !== 'completed' && record.outcome.status !== 'denied') {
      record.outcome = { status: 'cancelled' }
    }
    if (!cancel && Date.now() < record.nextPollAt) return { status: 'slow-down' }
    record.nextPollAt = Date.now() + PAIRING_LIMITS.pollIntervalMs
    if (record.outcome.status === 'approved') {
      const url = issueUrl()
      // A failed mint leaves the approval intact: the applicant retries with the same ticket.
      if (url === undefined) return { status: 'unavailable' }
      record.outcome = { status: 'completed', url }
    }
    const outcome = record.outcome
    return outcome.status === 'completed' ? { status: 'approved', url: outcome.url } : outcome
  }

  /** Drop every ticket and decision when the plugin unloads. */
  clear(): void {
    this.records.clear()
  }

  /** A display code no retained request currently shows. */
  private freshCode(): string {
    for (;;) {
      const code = Array.from(randomBytes(8), byte => CODE_ALPHABET[byte & 31]).join('')
      if (!Array.from(this.records.values()).some(record => record.code === code)) return code
    }
  }

  private prune(): void {
    const now = Date.now()
    for (const [id, record] of this.records) if (record.expiresAt <= now) this.records.delete(id)
  }
}

/** Constant-time secret comparison; the display code never authorizes anything. */
function matches(actual: string, expected: string): boolean {
  const bytes = Buffer.from(actual, 'utf8')
  const target = Buffer.from(expected, 'utf8')
  return bytes.length === target.length && timingSafeEqual(bytes, target)
}
