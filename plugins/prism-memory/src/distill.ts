/**
 * Zero-call distillation: turning a turn's own text into memory candidates
 * without asking a model to do it.
 *
 * The alternative — a turn-end extraction pass through an LLM — costs one extra
 * request per turn and makes the corpus nondeterministic for identical input.
 * This module instead recognizes the sentence forms a durable claim actually
 * takes, which is enough for the two highest-value classes: a constraint the
 * user stated, and a cause the turn established.
 *
 * Everything here is pure and deterministic. It classifies and extracts; it does
 * not decide confidence, status, scope, or tags — a caller owns those, and the
 * shipped default routes every candidate of this kind through the review inbox
 * so a wrong inference can never silently reach a model.
 *
 * @module @prism/prism-memory/distill
 */

import { jaccard, tokenize } from './memory.ts'
import type { MemoryKind } from './memory.ts'
import type { MemoryLayer } from './layers.ts'

/** One sentence form that carries a durable claim, and what it is. */
interface DistillRule {
  /** The layer a sentence matching this rule belongs to. */
  readonly layer: MemoryLayer
  /** The claim class a sentence matching this rule takes. */
  readonly kind: MemoryKind
  /** What the sentence says, in the terms a reader of this file needs. */
  readonly form: string
  /** Case-insensitive bilingual matcher for the sentence form. */
  readonly pattern: RegExp
}

/**
 * The recognized forms, most specific first. A sentence matches at most one:
 * "never run the build as root" is a constraint even though "the fix is" may
 * appear later in the same sentence.
 */
const DISTILL_RULES: readonly DistillRule[] = [
  {
    layer: 'lesson',
    kind: 'pitfall',
    form: 'a cause or a fix the turn established',
    pattern: /\b(?:the\s+(?:root\s+)?cause\s+(?:was|is)|the\s+fix\s+(?:was|is)|the\s+problem\s+was|the\s+mistake\s+was|it\s+turned\s+out|what\s+fixed\s+it)\b|(?:根因|原因|教训|问题)是|踩(?:过)?坑|坑(?:就)?在于|修复方式(?:是|为)|后来发现/iu,
  },
  {
    layer: 'rule',
    kind: 'decision',
    form: 'a constraint stated as an absolute',
    pattern: /\b(?:must\s+not|must|never|always|do\s+not|don't|required|forbidden|prohibited)\b|必须|禁止|不得|务必|严禁|一律|绝对不(?:要|能)|千万不要/iu,
  },
  {
    layer: 'user',
    kind: 'preference',
    form: 'a preference or habit of the person asking',
    pattern: /\b(?:i\s+prefer|we\s+prefer|prefer\s+to|i'd\s+rather|i\s+like\s+to|i\s+always|i\s+never|please\s+always|from\s+now\s+on)\b|我更(?:喜欢|倾向|愿意)|我希望|以后都|请始终|我不喜欢|习惯(?:用|于)|按我的习惯/iu,
  },
  {
    layer: 'project',
    kind: 'fact',
    form: 'a convention of this working directory',
    pattern: /\b(?:this\s+repo|this\s+repository|this\s+project|this\s+codebase|our\s+convention|in\s+this\s+workspace)\b|这个仓库|这个项目|本项目|本仓库|我们的约定|这个代码库/iu,
  },
]

/** Bounds on one extracted claim. */
export interface DistillOptions {
  /** Maximum candidates to return. */
  readonly limit?: number
  /** Shortest sentence accepted as a self-contained claim. */
  readonly minChars?: number
  /** Longest sentence accepted; longer text is a paragraph, not one claim. */
  readonly maxChars?: number
}

/** One extracted memory candidate, before a caller assigns confidence and status. */
export interface DistillCandidate {
  /** The claim, whitespace-collapsed and stripped of markdown markers. */
  readonly text: string
  /** What the claim is about. */
  readonly layer: MemoryLayer
  /** What sort of statement it is. */
  readonly kind: MemoryKind
  /** The recognized form, for an operator reading why this was captured. */
  readonly form: string
}

/** Split text into sentence-sized units, dropping list and quote markers. */
function splitClaims(text: string): string[] {
  const units: string[] = []
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, '').trim()
    if (line === '') continue
    for (const part of line.split(/(?<=[.!?。！？;；])\s*/u)) {
      const unit = part.trim()
      if (unit !== '') units.push(unit)
    }
  }
  return units
}

/** Strip markdown emphasis, code ticks, and link syntax from one sentence. */
function plain(sentence: string): string {
  return sentence
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?。！？;；:：,，]+$/u, '')
    .trim()
}

/**
 * Extract the durable claims a piece of turn text states outright.
 *
 * Only sentences that match a recognized form are returned, restricted to a
 * length band: below it a fragment is not self-contained, above it the sentence
 * is a paragraph whose one claim cannot be separated without a model. Questions
 * are rejected because they state nothing. Results keep document order and are
 * deduplicated by token overlap, so the same call on the same text returns the
 * same candidates.
 * @param text - the turn text to read; user input or an assistant's own account.
 * @param options - candidate cap and the accepted length band.
 * @returns the extractable claims, in document order.
 */
export function distillCandidates(text: string, options: DistillOptions = {}): DistillCandidate[] {
  const { limit = 3, minChars = 12, maxChars = 320 } = options
  const accepted: DistillCandidate[] = []
  const seen: { readonly text: string, readonly tokens: ReadonlySet<string> }[] = []
  for (const unit of splitClaims(text)) {
    if (unit.includes('?') || unit.includes('？')) continue
    const claim = plain(unit)
    if (claim.length < minChars || claim.length > maxChars) continue
    const rule = DISTILL_RULES.find(candidate => candidate.pattern.test(claim))
    if (rule === undefined) continue
    const tokens = tokenize(claim)
    if (tokens.size === 0) continue
    const duplicate = seen.find(entry => jaccard(entry.tokens, tokens) >= 0.9)
    if (duplicate !== undefined) continue
    seen.push({ text: claim, tokens })
    accepted.push({ text: claim, layer: rule.layer, kind: rule.kind, form: rule.form })
    if (accepted.length >= limit) break
  }
  return accepted
}
