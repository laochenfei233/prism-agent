/**
 * Keyless scripted model for the capability end-to-end run.
 *
 * The script is a JSON array in `PRISM_GUARDRAILS_SCRIPT`; the last entry
 * repeats once the script is exhausted, so a scenario that must be cut short by
 * a rail keeps producing the call the rail is meant to stop.
 */

import type { Context } from '@deepseek-ai/cordis'
// The Loader imports this fixture under plain Node, where no workspace path
// mapping applies, so its runtime dependency is the checkout's built package.
import {
  ToolCallId,
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '../../../../packages/llm/llm/lib/index.js'

/** One scripted model step: request a tool call, or answer with text. */
type Step = { readonly tool: string; readonly arguments: Record<string, unknown> } | { readonly text: string }

/** Read and validate the scripted steps. */
function scriptedSteps(): Step[] {
  const raw = process.env['PRISM_GUARDRAILS_SCRIPT']
  if (raw === undefined) throw new Error('capability-mock: PRISM_GUARDRAILS_SCRIPT is not set')
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('capability-mock: PRISM_GUARDRAILS_SCRIPT must be a non-empty array')
  }
  return parsed as Step[]
}

/** Emit one tool call. */
function* toolCallChunks(callId: string, step: { tool: string; arguments: Record<string, unknown> }): Generator<StreamChunk> {
  const args = JSON.stringify(step.arguments)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: ToolCallId(callId), name: step.tool, argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(callId), name: step.tool, arguments: args } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/** Emit one final answer. */
function* textChunks(text: string): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Scripted adapter: one step per model request, with the last step sticky. */
class CapabilityMockAdapter extends LlmAdapter {
  private step = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const steps = scriptedSteps()
    const index = Math.min(this.step, steps.length - 1)
    this.step += 1
    // A distinct id per call: a repeated id would look like one call to the loop.
    const current = steps[index] as Step
    yield* 'text' in current ? textChunks(current.text) : toolCallChunks(`cap-${this.step}`, current)
  }
}

export const name = 'capability-mock-llm'
export const inject = ['llm']

/** Register the keyless `capability-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['capability-mock'], new CapabilityMockAdapter())
}
