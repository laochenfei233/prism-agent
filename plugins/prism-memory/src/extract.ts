/**
 * Model-read extraction: one auxiliary request that reads the closing turn for
 * durable claims the form matcher cannot see.
 *
 * The regex distiller recognizes sentence forms; this channel reads meaning, so
 * a claim phrased outside every known form is still captured. It costs one extra
 * model call per turn and its output is not deterministic — the write path's
 * identical-claim checks keep the corpus itself stable across replays. The
 * instruction and the parser are pure and deterministic; only the call is not.
 *
 * Failure policy — deliberately the opposite of the deterministic passes': an
 * extraction failure is an external-service condition, so the caller contains it
 * and the turn it rides on never fails. A broken store is loud; an unreachable
 * provider is an ordinary skip.
 *
 * @module @prism/prism-memory/extract
 */

import { BlockAssembler, LlmError } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import { z as zod } from 'zod'
import { MEMORY_KINDS } from './memory.ts'
import type { MemoryKind } from './memory.ts'
import { MEMORY_LAYERS } from './layers.ts'
import type { MemoryLayer } from './layers.ts'

/**
 * The extraction directive, sent as the one user message with the turn appended.
 * It states the worth-keeping classes, the element form, and the source axis the
 * trust tiers read.
 */
const EXTRACTION_INSTRUCTION = [
  'You are a memory extractor. Read the turn below and return the statements worth keeping as long-term memory:',
  'a constraint the person stated, a preference or habit of the person, a cause or fix the discussion established,',
  'a convention of the workspace, or a hard rule. Skip anything that only matters inside this conversation.',
  'Answer with a JSON array only — no prose, no code fence. Each element takes this form:',
  '{"text": "<one self-contained claim>", "layer": "soul|user|project|fact|lesson|topic|rule", "kind": "fact|decision|pitfall|preference|procedure", "source": "user|inferred"}',
  '"source" is "user" when the claim restates the words of the person — a preference they expressed or a constraint they',
  'imposed — and "inferred" when it is a conclusion the discussion reached. Return [] when nothing is worth keeping.',
].join('\n')

/** The text of the turn that is closing, split by who said it. */
export interface TurnText {
  /** The message of the person. */
  readonly user: string
  /** The account the assistant gave. */
  readonly assistant: string
}

/** One claim the extractor returned, validated and narrowed. */
export interface ExtractedClaim {
  /** One self-contained claim. */
  readonly text: string
  /** What the claim is about. */
  readonly layer: MemoryLayer
  /** What sort of statement it is. */
  readonly kind: MemoryKind
  /** Whose words the claim restates: the person, or a conclusion of the discussion. */
  readonly source: 'user' | 'inferred'
}

/** Everything one extraction call needs. */
export interface ExtractionCall {
  /** Registered provider route. */
  readonly provider: string
  /** Registered model. */
  readonly model: string
  /** Output token cap. */
  readonly maxTokens: number
  /** The calling session, for routing; absent when the caller has none. */
  readonly sessionId: GenerateOptions['sessionId']
}

/** Element schema of the extractor's answer; anything else is dropped. */
const extractedClaimSchema = zod.object({
  text: zod.string().min(1),
  layer: zod.enum(MEMORY_LAYERS),
  kind: zod.enum(MEMORY_KINDS),
  source: zod.enum(['user', 'inferred']),
})

/**
 * Bound one side's text to the input budget. The tail carries the conclusion a
 * turn reached, so overbudget text is clipped from the head, not the tail.
 * @param text - one side of the turn.
 * @param maxChars - the input budget for the side.
 * @returns the text, head-clipped when over budget.
 */
function clipped(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `…${text.slice(-maxChars)}`
}

/**
 * Build the one-shot extraction request: the directive, then the turn.
 * @param turn - the closing turn's two sides.
 * @param maxInputChars - the input budget for each side.
 * @returns the request messages.
 */
export function buildExtractionMessages(turn: TurnText, maxInputChars: number): RequestMessage[] {
  return [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: [
            EXTRACTION_INSTRUCTION,
            `--- the turn (the person) ---`,
            clipped(turn.user, maxInputChars),
            `--- the turn (the assistant account) ---`,
            clipped(turn.assistant, maxInputChars),
          ].join('\n\n'),
        },
      ],
    },
  ]
}

/**
 * Parse the extractor's answer.
 *
 * The answer is read as the first `[` through the last `]` of whatever the model
 * returned, so a stray sentence or a code fence around the array is tolerated;
 * each element is validated on its own and an invalid one is dropped rather
 * than failing the batch.
 * @param text - the model's answer text.
 * @param maxClaims - candidates the caller will accept.
 * @returns the valid claims, in answer order.
 */
export function parseExtraction(text: string, maxClaims: number): ExtractedClaim[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    // JSON.parse SyntaxError: the model answered something that reads as no
    // JSON array even after the fence tolerance, an ordinary outcome here.
    return []
  }
  if (!Array.isArray(parsed)) return []
  const accepted: ExtractedClaim[] = []
  for (const entry of parsed) {
    if (accepted.length >= maxClaims) break
    const claim = extractedClaimSchema.safeParse(entry)
    if (!claim.success) continue
    accepted.push(claim.data)
  }
  return accepted
}

/**
 * Run one extraction call and parse its answer.
 * @param llm - the LLM runtime to route through, captured by the caller at load.
 * @param call - provider, model, and bounds for the call.
 * @param turn - the closing turn's two sides.
 * @param limits - per-side input budget and the claim cap.
 * @returns the valid claims; an empty array when the model kept nothing.
 */
export async function extractClaims(
  llm: Context['llm'],
  call: ExtractionCall,
  turn: TurnText,
  limits: { readonly maxInputChars: number, readonly maxClaims: number },
): Promise<ExtractedClaim[]> {
  const assembler = new BlockAssembler()
  const options: GenerateOptions = {
    provider: call.provider,
    model: call.model,
    messages: buildExtractionMessages(turn, limits.maxInputChars),
    maxTokens: call.maxTokens,
    purpose: 'memory-distill',
    ...call.sessionId === undefined ? {} : { sessionId: call.sessionId },
  }
  for await (const chunk of llm.stream(options)) assembler.push(chunk)
  if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
    throw new LlmError(assembler.finish.failure.message, assembler.finish.failure.code, assembler.finish.failure)
  }
  const text = assembler.blocks()
    .map(block => block.type === 'text' ? block.text : '')
    .join('')
  return parseExtraction(text, limits.maxClaims)
}
