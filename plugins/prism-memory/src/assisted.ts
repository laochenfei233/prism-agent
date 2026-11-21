/**
 * Model-assisted distillation: the one producer that may ask a model to read.
 *
 * The form-recognizing reader in `distill.ts` costs nothing per turn and is
 * deterministic, but it only sees the sentence forms a durable claim takes. This
 * module is the optional complement: it hands a bounded dialogue to the
 * deployment's own model and reads back candidate claims, for the windows a
 * deployment explicitly turns on. Both the per-turn window and `/memory
 * bootstrap` call through here, so the prompt, the output protocol, and the
 * target resolution are stated once.
 *
 * Everything here is protocol: it renders, parses, and dispatches. It assigns
 * no confidence, status, scope, or tags — a caller owns those, and the shipped
 * callers route every candidate through the review inbox.
 *
 * @module @prism/prism-memory/assisted
 */

import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { MEMORY_KINDS } from './memory.ts'
import type { MemoryKind } from './memory.ts'
import { MEMORY_LAYERS } from './layers.ts'
import type { MemoryLayer } from './layers.ts'

/** One numbered message handed to the assisting model. */
export interface AssistedMessage {
  /** Who said it, as the protocol names roles to the model. */
  readonly role: 'user' | 'assistant'
  /** The message's model-visible text. */
  readonly text: string
  /** The message id, which a cited candidate resolves its evidence through. */
  readonly id: string
}

/** One candidate the assisting model proposed, before a caller admits it. */
export interface AssistedCandidate {
  /** The claim, in the model's own words. */
  readonly text: string
  /** The claim class the model assigned. */
  readonly kind: MemoryKind
  /** What the model says the claim is about, when it named a layer. */
  readonly layer?: MemoryLayer
  /** The 1-based number of the message the claim is grounded in, when given. */
  readonly sourceMessage?: number
}

/** One resolved provider route for an auxiliary call. */
export interface AssistedTarget {
  /** Registered provider route key. */
  readonly provider: string
  /** Model id within that provider. */
  readonly model: string
}

/**
 * The identity-free instruction for every assisted call. It states the four
 * claim classes the distill path also recognizes, demands one JSON array, and
 * forbids everything else — the model is a proposer, not an archivist.
 */
const ASSISTED_SYSTEM = [
  'You read a conversation and propose durable memory claims worth keeping for later sessions.',
  'Propose only: a constraint that must hold (decision), a preference or habit of the person (preference),',
  'a cause the conversation established (pitfall), a convention of the workspace or an established fact (fact),',
  'or a way of doing things this workspace follows (procedure).',
  'Do not propose one-off events, plans, questions, or anything already obvious from the code.',
  'Answer with a JSON array only, at most the requested number of items, each item:',
  '{"text": one self-contained sentence, "kind": decision|preference|pitfall|fact|procedure,',
  ' "layer": soul|user|project|fact|lesson|topic|rule (optional), "sourceMessage": <1-based message number> (optional)}.',
  'An empty array is a valid answer. No prose outside the array.',
].join(' ')

/**
 * Render the one user message an assisted call sends: the numbered dialogue,
 * oldest first, with the claim cap stated.
 * @param messages - the dialogue, oldest first.
 * @param maxClaims - the candidate cap named to the model.
 * @returns the user-message text.
 */
export function renderAssistedPrompt(messages: readonly AssistedMessage[], maxClaims: number): string {
  const dialogue = messages
    .map((message, index) => `${index + 1}. [${message.role}] ${message.text}`)
    .join('\n')
  return `Conversation:\n${dialogue}\n\nPropose at most ${maxClaims} durable memory claim(s) as the JSON array.`
}

/**
 * Every balanced bracketed region in a model reply, in order. A reply may
 * bracket incidental prose before the array it was asked for, so the caller
 * tries each region and keeps the first one that parses as JSON.
 * @param raw - the model's full text output.
 * @returns the balanced regions, or none.
 */
function jsonArraySlices(raw: string): string[] {
  const slices: string[] = []
  let start = raw.indexOf('[')
  if (start < 0) return slices
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '[') depth += 1
    else if (character === ']' && --depth === 0) {
      slices.push(raw.slice(start, index + 1))
      start = raw.indexOf('[', index + 1)
      if (start < 0) break
    }
  }
  return slices
}

/**
 * Parse one model reply into candidates.
 *
 * Each bracketed region is tried in order; the first one that parses as a JSON
 * array is the answer. A reply with no array, unparsable JSON, or items that
 * name no readable claim contributes nothing; the model hallucinating a schema
 * is an empty result, not a failure — the window simply produced no candidates.
 * @param raw - the model's full text output.
 * @param maxClaims - the cap the prompt named; extra items are dropped.
 * @returns the readable candidates, in model order.
 */
export function parseAssistedOutput(raw: string, maxClaims: number): AssistedCandidate[] {
  for (const slice of jsonArraySlices(raw)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(slice)
    } catch {
      continue
    }
    if (!Array.isArray(parsed)) continue
    const candidates: AssistedCandidate[] = []
    for (const item of parsed) {
      if (candidates.length >= maxClaims) break
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const text = typeof record.text === 'string' ? record.text.replace(/\s+/g, ' ').trim() : ''
      if (text === '') continue
      const kind = record.kind
      if (typeof kind !== 'string' || !MEMORY_KINDS.includes(kind as MemoryKind)) continue
      const layer = record.layer
      const candidate: AssistedCandidate = {
        text,
        kind: kind as MemoryKind,
        ...(typeof layer === 'string' && MEMORY_LAYERS.includes(layer as MemoryLayer)
          ? { layer: layer as MemoryLayer }
          : {}),
        ...(Number.isInteger(record.sourceMessage) && (record.sourceMessage as number) >= 1
          ? { sourceMessage: record.sourceMessage as number }
          : {}),
      }
      candidates.push(candidate)
    }
    return candidates
  }
  return []
}

/**
 * Dispatch one assisted call and return the model's full text output.
 *
 * The request carries no tool schemas and no session identity: it is a one-shot
 * call whose content is the rendered prompt, and the caller owns its inputs
 * until the stream settles.
 * @param llm - the LLM runtime to dispatch through.
 * @param target - the provider route to call.
 * @param prompt - the rendered user message.
 * @param maxTokens - the token cap the deployment allows one assisted call.
 * @param signal - optional cancellation forwarded to the adapter.
 * @returns the model's text output.
 */
export async function runAssistedCall(
  llm: LlmRuntime,
  target: AssistedTarget,
  prompt: string,
  maxTokens: number,
  signal?: AbortSignal,
): Promise<string> {
  const assembler = new BlockAssembler()
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    system: ASSISTED_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens,
    ...signal === undefined ? {} : { signal },
  }
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
  }
  if (finish.kind === 'max-tokens') {
    throw new LlmError('assisted distillation truncated at the token cap', 'MAX_TOKENS')
  }
  return assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}
