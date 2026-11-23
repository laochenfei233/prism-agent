/** Stale tool-result selection and durable stub replacement for microcompact. */

import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionSeq, ToolResultMessage } from '@deepseek-ai/dsh-session'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { ClearedEntry, MicrocompactResult, ResolvedConfig } from './types.ts'

/**
 * Replacement text standing in for a cleared stale result.
 * @param toolName - model-facing name of the cleared tool.
 * @returns the replacement's single text-block content.
 */
export function stubText(toolName: string): string {
  return `[Earlier ${toolName} result cleared by microcompact to free context; re-run the tool if you still need it.]`
}

/** Fallback name for a result whose `tool/call` event is absent from the surface. */
const UNKNOWN_TOOL_NAME = 'unknown tool'

/**
 * Measure text content in Unicode code points; non-text blocks cost zero.
 * @param blocks - content to measure.
 * @returns total Unicode code points across text blocks.
 */
function textLength(blocks: readonly ContentBlock[]): number {
  let length = 0
  for (const block of blocks) {
    if (block.type === 'text') length += Array.from(block.text).length
  }
  return length
}

/**
 * Clear every stale tool result from one stable current-surface snapshot. Stale
 * means older than the most recent `keepRecentResults` results; the `tools`
 * filter, when configured, restricts which tool names may be cleared. Each
 * replacement preserves the complete event data except for `content`, cites the
 * shadowed node through `sourceEventSeqs`, and is immediately preceded by a
 * `compaction/prune` shadow-price event pricing the shadowed node through the
 * injected token meter — the shared protocol documented on the `compaction/prune`
 * event. Replacing a `tool/result` node with another `tool/result` node keeps
 * tool pairing intact by construction.
 * @param session - session whose current surface is rewritten.
 * @param meter - injected token meter for shadow pricing and savings estimates.
 * @param config - resolved guard configuration.
 * @returns the landed replacements and estimated tokens freed, or `null` when
 * nothing qualified; replacements committed earlier in the pass stay durable.
 */
export function microcompactSurface(
  session: Session,
  meter: TokenMeter,
  config: ResolvedConfig,
): MicrocompactResult | null {
  const toolNameByCallId = new Map<string, string>()
  const results: Array<{ seq: SessionSeq; event: SessionEvent<'tool/result'> }> = []
  for (const seq of [...session.surface.nodes]) {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const event = session.eventAt(seq)
    /* v8 ignore next 5 -- surface seqs are validated contiguous log references. */
    if (event?.type === 'assistant/message') {
      // Surface pairing carries tool names in assistant tool-call blocks; the
      // `tool/call` log events are not surface nodes.
      for (const block of event.data.message.content) {
        if (block.type === 'tool-call') toolNameByCallId.set(block.id, block.name)
      }
    }
    /* v8 ignore next 2 -- surface seqs are validated contiguous log references. */
    if (event?.type === 'tool/result') {
      results.push({ seq, event })
    }
  }

  const staleCount = results.length - config.keepRecentResults
  if (staleCount <= 0) return null

  const cleared: ClearedEntry[] = []
  let estimatedTokensFreed = 0
  for (const { seq, event } of results.slice(0, staleCount)) {
    const original = session.deriveEventMessage(event) as ToolResultMessage
    const toolName = toolNameByCallId.get(event.data.message.source.callId) ?? UNKNOWN_TOOL_NAME
    if (config.tools !== undefined && !config.tools.includes(toolName)) continue
    const content: ContentBlock[] = [{ type: 'text', text: stubText(toolName) }]
    const stubMessage = freezeMessage<ToolResultMessage>({ ...original, content })
    if (textLength(original.content) <= textLength(stubMessage.content)) continue
    // Shadow-price protocol: the metering event and its replacement are appended
    // synchronously adjacent, so pure consumers subtract the shadowed node's
    // heuristic price without retaining per-node state.
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: meter.estimateMessage(original),
    })
    const replacement = session.append('tool/result', {
      ...event.data,
      message: stubMessage,
    }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
    cleared.push({
      originalSeq: seq,
      replacementSeq: replacement.seq,
      callId: event.data.message.source.callId,
      toolName,
    })
    estimatedTokensFreed += meter.estimateMessage(original) - meter.estimateMessage(stubMessage)
  }
  if (cleared.length === 0) return null
  return { cleared, estimatedTokensFreed }
}
