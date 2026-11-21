/**
 * Composition of the one dynamic contribution this plugin makes: a single
 * user-role message appended at the request tail.
 *
 * Everything the plugin wants to say to the model in a given step is assembled
 * here into one frame, rather than one message per feature. The distinction
 * matters for the cache: a step that appends one message leaves every earlier
 * byte untouched and turns that message into reusable prefix on the next turn,
 * while two messages would double the tail cost for no extra information.
 *
 * The frame is a fixed pair of delimiters plus labeled sections. A section that
 * has nothing to contribute is omitted entirely rather than rendered empty, so a
 * turn with only a greeting does not carry memory headings.
 *
 * @module @prism/prism-memory/recall
 */

import type { MemoryRecord } from './domain.ts'
import { layerOf } from './layers.ts'
import type { MemoryHit } from './memory.ts'

/** Opening delimiter of the injected frame. */
export const FRAME_OPEN = '<prism-memory>'

/** Closing delimiter of the injected frame. */
export const FRAME_CLOSE = '</prism-memory>'

/** The fixed guidance that follows the frame, identical on every injected turn. */
export const FRAME_GUIDANCE = [
  'Treat memory as background: verify before relying on it, and call memory_search or',
  'memory_open when the exact record matters.',
].join('\n')

/** Which part of a day the local clock currently reads, as the greeting names it. */
export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night'

/**
 * Classify a local hour into the part of day a greeting names.
 * @param hour - hour of the day in local time, `0..23`.
 * @returns the day part.
 */
export function dayPartOf(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  if (hour >= 18 && hour < 23) return 'evening'
  return 'night'
}

/** The greeting line per day part. */
const GREETING: Readonly<Record<DayPart, string>> = {
  morning: 'Good morning.',
  afternoon: 'Good afternoon.',
  evening: 'Good evening.',
  night: 'Working late.',
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/**
 * The orientation line: the local date, its weekday, and the part of day.
 *
 * The minute is deliberately absent. A block that changes every minute would
 * make an otherwise identical turn render different bytes, and a stable date is
 * what a model actually needs to reason about "tomorrow" or "last week".
 * @param now - current time in epoch milliseconds.
 * @returns the orientation line.
 */
export function renderOrientation(now: number): string {
  const date = new Date(now)
  const weekday = WEEKDAYS[date.getDay()] ?? 'Sunday'
  const day = date.toISOString().slice(0, 10)
  const part = dayPartOf(date.getHours())
  return `${GREETING[part]} Today is ${weekday}, ${day} (${part}, local time).`
}

/** Render memory records as labeled bullet lines, at a per-line character cap. */
function bullets(records: readonly MemoryRecord[], lineChars: number): string[] {
  return records.map(record => {
    const date = new Date(record.createdAt).toISOString().slice(0, 10)
    const text = record.text.length <= lineChars ? record.text : `${record.text.slice(0, lineChars - 1)}…`
    return `- [${record.id}] (${layerOf(record)}, ${record.kind}, ${date}) ${text}`
  })
}

/** The parts one step's injected frame may carry. */
export interface TailParts {
  /** The orientation line, when the deployment enables it. */
  readonly orientation?: string | undefined
  /** Standing memory: records on an identity layer, recalled without a keyword match. */
  readonly identity?: readonly MemoryRecord[] | undefined
  /** Records whose recorded due date has arrived. */
  readonly due?: readonly MemoryRecord[] | undefined
  /** Keyword-matched records for this step. */
  readonly recall?: readonly MemoryHit[] | undefined
}

/**
 * Assemble the injected frame, or an empty string when no part contributes.
 *
 * The character budget applies to the finished frame, so a deployment that caps
 * the block bounds the whole thing rather than each section independently.
 * @param parts - the sections to render; empty sections are omitted.
 * @param options - character cap on the finished frame and cap on one memory line.
 * @returns the block text, or an empty string when every section is empty.
 */
export function renderTail(
  parts: TailParts,
  options: { readonly maxChars?: number, readonly lineChars?: number } = {},
): string {
  const { maxChars = 900, lineChars = 220 } = options
  const sections: string[] = []
  if (parts.orientation !== undefined && parts.orientation !== '') sections.push(parts.orientation)
  const identity = parts.identity ?? []
  if (identity.length > 0) sections.push(['Standing memory:', ...bullets(identity, lineChars)].join('\n'))
  const due = parts.due ?? []
  if (due.length > 0) sections.push(['Due now (a date recorded earlier has arrived):', ...bullets(due, lineChars)].join('\n'))
  const recall = (parts.recall ?? []).map(hit => hit.record)
  if (recall.length > 0) sections.push(['Possibly relevant memory:', ...bullets(recall, lineChars)].join('\n'))
  if (sections.length === 0) return ''
  const body = sections.join('\n')
  // Bound the finished frame, not the body: the delimiters and the guidance are
  // part of what the model receives, so a budget that ignored them would let the
  // block exceed the configured cap by their length.
  const overhead = [FRAME_OPEN, '', FRAME_CLOSE, FRAME_GUIDANCE].join('\n').length
  const budget = maxChars - overhead
  // A cap that cannot hold the delimiters plus one character has no room to say
  // anything, and emitting a frame anyway would exceed it.
  if (budget <= 1) return ''
  const bounded = body.length <= budget ? body : `${body.slice(0, budget - 1)}…`
  return [FRAME_OPEN, bounded, FRAME_CLOSE, FRAME_GUIDANCE].join('\n')
}
