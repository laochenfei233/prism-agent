/** Configuration and result types for the microcompact pass. */

import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Raw plugin configuration for the microcompact guard. */
export interface PrismMicrocompactConfig {
  /** Arm microcompact at this fraction of the routed context window (default `0.7`). */
  thresholdRatio?: number
  /**
   * Capacity withheld after the output reservation before microcompact arms
   * (default `131072`). Keeping this below `dsh-compaction-basic`'s `headroomTokens`
   * is what lets the cheaper pass arm before summarization does.
   */
  headroomTokens?: number
  /** Most recent tool results always retained (default `4`). */
  keepRecentResults?: number
  /** Tool names eligible for stale clearing; omission clears every tool's stale results. */
  tools?: string[]
}

/** Validated, detached, deeply immutable guard configuration. */
export interface ResolvedConfig {
  readonly thresholdRatio: number
  readonly headroomTokens: number
  readonly keepRecentResults: number
  readonly tools: readonly string[] | undefined
}

/** One stale tool result replaced by a stub. */
export interface ClearedEntry {
  /** Full-fidelity tool-result event shadowed by the replacement. */
  readonly originalSeq: SessionSeq
  /** Newly appended stub tool-result event. */
  readonly replacementSeq: SessionSeq
  /** Tool call shared by the original and replacement. */
  readonly callId: ToolCallId
  /** Model-facing name of the cleared tool. */
  readonly toolName: string
}

/** Aggregate outcome of one microcompact pass. */
export interface MicrocompactResult {
  /** Replacements in snapshotted surface order. */
  readonly cleared: readonly ClearedEntry[]
  /** Estimated meter tokens freed by the pass. */
  readonly estimatedTokensFreed: number
}

/** Detached pressure tracking snapshot for one routed conversation. */
export interface PressureSnapshot {
  /** Current estimated conversation tokens. */
  readonly totalTokens: number
  /** Routed model's context window. */
  readonly contextWindow: number
  /** Token count at which microcompact arms. */
  readonly thresholdTokens: number
  /** Whether the current measurement is at or above the arming threshold. */
  readonly willMicrocompact: boolean
}
