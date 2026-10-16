/**
 * Shared types of the Prism memory plugin: the session-projection state and the
 * projections the model tools and the operator command both render.
 *
 * @module @prism/prism-memory/types
 */

import type { SessionProjectionStateMap } from '@deepseek-ai/dsh-session-projection'

/** Recalled memory ids tracked for one session, folded from its own injected messages. */
export interface PrismMemoryInjectedState {
  /** Ids already delivered in a `<prism-memory>` recall frame, oldest first. */
  injected: string[]
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    prismMemory: PrismMemoryInjectedState
  }
}

/** The state this plugin's session projection carries, as the registry stores and checkpoints it. */
export type PrismMemoryProjectionState = SessionProjectionStateMap['prismMemory']

/** The detached model-facing projection of one stored memory. */
export interface MemoryView {
  /** Opaque `mem_<uuid>` identity. */
  id: string
  /** Claim class. */
  kind: string
  /** What the claim is about. */
  layer: string
  /** Visibility class. */
  scope: string
  /** Lifecycle state. */
  status: string
  /** The claim itself. */
  text: string
  /** Recall keywords. */
  tags: string[]
  /** Producer's certainty, `0..1`. */
  confidence: number
  /** ISO-8601 write time. */
  createdAt: string | null
  /** ISO-8601 start of the validity window. */
  validAt: string | null
  /** ISO-8601 end of the validity window. */
  invalidAt: string | null
  /** ISO-8601 time-to-live deadline. */
  expiresAt: string | null
  /** ISO-8601 instant this claim becomes actionable, or `null`. */
  dueAt: string | null
  /** The record that replaced this one, or `null`. */
  supersededBy: string | null
  /** Explicit opens so far. */
  hits: number
}

/** Where one claim came from, for a reference back into the originating conversation. */
export interface MemoryProvenance {
  /** Session the claim was distilled from, or `null` for an operator write. */
  sessionId: string | null
  /** Message within that session, when known. */
  messageId: string | null
  /** Free-form note recorded by a supersede, forget, review, or merge. */
  note: string | null
}

/** One entry of a supersede chain, as the audit read returns it. */
export interface MemoryChainEntry {
  /** The record at this position. */
  id: string
  /** Its lifecycle state. */
  status: string
  /** ISO-8601 write time. */
  createdAt: string | null
  /** ISO-8601 invalidation time, or `null` while it stands. */
  invalidAt: string | null
}
