/**
 * Ordering by a model the user selected in Models. One auxiliary call asks for
 * a JSON permutation of the candidates; any failure keeps the fused order,
 * because ordering is an improvement and never a reason to fail a search.
 *
 * @module @prism/prism-search/rerank
 */

import type { RankedHit } from './fusion.ts'
import { withTimeout } from './http.ts'

/** One one-shot model request; the subset of the harness request this plugin sends. */
export interface LlmStreamRequest {
  /** Registered provider route. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
  /** Single user message carrying the ranking prompt. */
  readonly messages: readonly {
    readonly role: 'user'
    readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  }[]
  /** Output-token cap. */
  readonly maxTokens: number
  /** Deterministic sampling. */
  readonly temperature: number
  /** Cancellation, already combining the caller and this call's deadline. */
  readonly signal?: AbortSignal
}

/** Streaming model call the Host's LLM service provides. */
export type LlmStream = (request: LlmStreamRequest) => AsyncIterable<unknown>

/** One rerank request. */
export interface RerankRequest {
  /** The user's query. */
  readonly query: string
  /** Candidates in fused order. */
  readonly hits: readonly RankedHit[]
  /** Provider route of the selected model. */
  readonly provider: string
  /** Model id of the selected model. */
  readonly model: string
  /** Deadline for the whole auxiliary call. */
  readonly timeoutMs: number
  /** The surrounding search's cancellation. */
  readonly signal?: AbortSignal
}

/** The ordering call the provider invokes once per search. */
export type Reranker = (request: RerankRequest) => Promise<readonly number[] | undefined>

/** Collaborators for {@link rerankOrder}. */
export interface RerankDeps {
  /** The Host's streaming model call. */
  readonly stream: LlmStream
}

/** Maximum prompt characters spent on one candidate's excerpt. */
const PROMPT_SNIPPET_CHARS = 240

/** Maximum answer characters read before parsing stops. */
const MAX_ANSWER_CHARS = 4000

/**
 * Build the fixed ranking prompt.
 * @param query - the user's query.
 * @param hits - candidates in fused order.
 * @returns the exact user-message text sent to the model.
 */
export function buildRerankPrompt(query: string, hits: readonly RankedHit[]): string {
  const lines = hits.map((hit, index) => {
    const title = (hit.title ?? hit.url).slice(0, 200)
    const snippet = (hit.snippet ?? '').slice(0, PROMPT_SNIPPET_CHARS)
    return `${index + 1}. ${title} — ${hit.url}${snippet.length === 0 ? '' : `\n   ${snippet}`}`
  })
  return [
    'Rank these web search results for the query by how well each answers it.',
    '',
    `Query: ${query.slice(0, 300)}`,
    '',
    'Results:',
    ...lines,
    '',
    `Reply with JSON only, no prose: {"order": [...]} where order lists the ${hits.length} result numbers from most to least relevant, each number exactly once.`,
  ].join('\n')
}

/**
 * Read a model answer into a zero-based permutation.
 * @param answer - the model's raw text.
 * @param count - number of candidates.
 * @returns the permutation, or undefined when the answer carries no usable order.
 */
export function parseOrderAnswer(answer: string, count: number): readonly number[] | undefined {
  const parsed = firstJsonValue(answer)
  const candidate = Array.isArray(parsed) ? parsed : objectOf(parsed)?.['order']
  if (!Array.isArray(candidate)) return undefined
  const numbers = candidate
    .filter((value): value is number => typeof value === 'number' && Number.isInteger(value))
  if (numbers.length === 0) return undefined
  const zeroBased = numbers.some(value => value === 0)
  const seen = new Set<number>()
  const order: number[] = []
  for (const value of numbers) {
    const index = zeroBased ? value : value - 1
    if (index < 0 || index >= count || seen.has(index)) continue
    seen.add(index)
    order.push(index)
  }
  if (order.length === 0) return undefined
  for (let index = 0; index < count; index += 1) {
    if (!seen.has(index)) order.push(index)
  }
  return order
}

/**
 * Ask the selected model for a ranking and return its permutation.
 * @param request - query, candidates, model route, deadline, and cancellation.
 * @param deps - the Host's streaming model call.
 * @returns the permutation, or undefined when the model or its answer is unusable.
 */
export async function rerankOrder(request: RerankRequest, deps: RerankDeps): Promise<readonly number[] | undefined> {
  if (request.hits.length < 2) return undefined
  const signal = withTimeout(request.signal, request.timeoutMs)
  try {
    const prompt = buildRerankPrompt(request.query, request.hits)
    let answer = ''
    for await (const chunk of deps.stream({
      provider: request.provider,
      model: request.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      maxTokens: 400,
      temperature: 0,
      signal,
    })) {
      const record = objectOf(chunk)
      if (record === undefined) continue
      if (record['type'] === 'text-delta' && typeof record['text'] === 'string') {
        answer += record['text']
        if (answer.length > MAX_ANSWER_CHARS) break
      }
      if (record['type'] === 'finish') {
        const reason = objectOf(record['reason'])
        if (reason?.['kind'] === 'error') return undefined
      }
    }
    return parseOrderAnswer(answer, request.hits.length)
  } catch {
    // Ordering is an optimization; an unusable model answer keeps the fused order.
    return undefined
  }
}

/** The first JSON object or array in a model answer, tolerating prose around it. */
function firstJsonValue(answer: string): unknown {
  const trimmed = answer.trim()
  const direct = tryParse(trimmed)
  if (direct !== undefined) return direct
  const objectMatch = /\{[\s\S]*\}/.exec(trimmed)
  if (objectMatch !== null) {
    const parsed = tryParse(objectMatch[0])
    if (parsed !== undefined) return parsed
  }
  const arrayMatch = /\[[\s\S]*\]/.exec(trimmed)
  return arrayMatch === null ? undefined : tryParse(arrayMatch[0])
}

/** Parse JSON, yielding undefined for anything that is not JSON. */
function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // A model answer that is not JSON carries no order.
    return undefined
  }
}

/** Narrow a value to a plain object. */
function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
