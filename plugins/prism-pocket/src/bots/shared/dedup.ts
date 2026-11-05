/**
 * Inbound callback replay dedup: platforms redeliver callbacks (WeChat's own
 * freshness window is 300s, so the TTL here covers redelivery with headroom),
 * and one replayed message must not double-fire binding, asks, or delivery.
 * A bounded in-memory map keyed by `(channel, messageId)`; state lives per
 * process, matching where the inbound pipeline runs.
 *
 * @module @prism/prism-pocket/bots/shared
 */

/** How long one message id stays remembered. */
export const DEDUP_TTL_MS = 10 * 60 * 1000

/** Maximum remembered message ids; the map prunes on every insertion. */
export const DEDUP_CAPACITY = 2048

/**
 * The replay filter: `first(key)` reports whether the key is new inside the
 * TTL window. Empty message ids skip dedup entirely at the call site —
 * a platform without message ids must never be dropped as a replay.
 */
export class InboundDedup {
  /** key → first-arrival time; Map iteration order doubles as the age order. */
  private readonly seen = new Map<string, number>()

  /**
   * Record one message id and report whether it was already seen inside the window.
   * @param key - the dedup key, `${channel}:${messageId}`.
   * @param now - wall-clock ms; injectable for tests.
   * @returns whether the key is new and should process; `false` marks a replay.
   */
  first(key: string, now: number = Date.now()): boolean {
    this.pruneExpired(now)
    const seenAt = this.seen.get(key)
    const replay = seenAt !== undefined && now - seenAt < DEDUP_TTL_MS
    if (seenAt === undefined) this.seen.set(key, now)
    else if (!replay) {
      // Expired: re-arm with the fresh arrival time, moving the key back in age order.
      this.seen.delete(key)
      this.seen.set(key, now)
    }
    while (this.seen.size > DEDUP_CAPACITY) {
      const oldest = this.seen.keys().next()
      if (oldest.done === true) break
      this.seen.delete(oldest.value)
    }
    return !replay
  }

  /** Drop entries past the TTL; called on every insertion so the map stays bounded. */
  private pruneExpired(now: number): void {
    for (const [key, seenAt] of this.seen) {
      if (now - seenAt >= DEDUP_TTL_MS) this.seen.delete(key)
    }
  }
}
