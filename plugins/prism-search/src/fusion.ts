/**
 * Reciprocal rank fusion over the engines' own orderings. Every list
 * contributes `1 / (k + rank)` to each result it contains, so a page found by
 * several engines outranks one found by a single engine at any rank.
 *
 * @module @prism/prism-search/fusion
 */

import type { EngineHit } from './engines.ts'
import { normalizeUrl } from './urls.ts'

/** One engine's ordered answer. */
export interface EngineAnswer {
  /** Engine id that produced the list. */
  readonly engine: string
  /** Results in the engine's own rank order. */
  readonly hits: readonly EngineHit[]
}

/** One fused result: the hit plus its fusion score and provenance. */
export interface RankedHit extends EngineHit {
  /** Summed reciprocal-rank score; higher is better. */
  readonly score: number
  /** Engines that returned this URL, in discovery order. */
  readonly engines: readonly string[]
}

/** RRF rank constant; 60 is the value the reference implementation uses. */
export const RRF_K = 60

/** Mutable accumulator for one URL while lists are merged. */
interface Accumulator {
  readonly url: string
  title: string | undefined
  snippet: string | undefined
  publishedAt: string | undefined
  score: number
  readonly engines: string[]
  readonly order: number
}

/**
 * Fuse every engine answer into one ranked list.
 * @param answers - one answer per engine that returned results.
 * @param k - rank constant; larger values flatten the contribution of high ranks.
 * @returns results ordered by fused score, then by first appearance.
 */
export function fuse(answers: readonly EngineAnswer[], k: number = RRF_K): RankedHit[] {
  const merged = new Map<string, Accumulator>()
  answers.forEach((answer, listIndex) => {
    answer.hits.forEach((hit, rank) => {
      const key = normalizeUrl(hit.url)
      if (key.length === 0) return
      const contribution = 1 / (k + rank + 1)
      const existing = merged.get(key)
      if (existing === undefined) {
        merged.set(key, {
          url: hit.url,
          title: hit.title,
          snippet: hit.snippet,
          publishedAt: hit.publishedAt,
          score: contribution,
          engines: [answer.engine],
          order: listIndex * 1000 + rank,
        })
        return
      }
      existing.score += contribution
      if (!existing.engines.includes(answer.engine)) existing.engines.push(answer.engine)
      if ((existing.title ?? '').length === 0) existing.title = hit.title
      if ((hit.snippet ?? '').length > (existing.snippet ?? '').length) existing.snippet = hit.snippet
      if (existing.publishedAt === undefined) existing.publishedAt = hit.publishedAt
    })
  })
  return [...merged.values()]
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .map(entry => ({
      url: entry.url,
      ...entry.title === undefined ? {} : { title: entry.title },
      ...entry.snippet === undefined ? {} : { snippet: entry.snippet },
      ...entry.publishedAt === undefined ? {} : { publishedAt: entry.publishedAt },
      score: entry.score,
      engines: entry.engines,
    }))
}

/**
 * Merge results that became the same URL after page fetching.
 * @param hits - ranked results, possibly holding redirect aliases.
 * @returns one result per normalized URL, in input order.
 */
export function dedupeByUrl(hits: readonly RankedHit[]): RankedHit[] {
  const seen = new Map<string, RankedHit>()
  for (const hit of hits) {
    const key = normalizeUrl(hit.url)
    const existing = seen.get(key)
    if (existing === undefined) {
      seen.set(key, hit)
      continue
    }
    const engines = [...new Set([...existing.engines, ...hit.engines])]
    seen.set(key, {
      ...existing,
      ...existing.title === undefined && hit.title !== undefined ? { title: hit.title } : {},
      ...(hit.snippet ?? '').length > (existing.snippet ?? '').length ? { snippet: hit.snippet } : {},
      score: Math.max(existing.score, hit.score),
      engines,
    })
  }
  return [...seen.values()]
}
