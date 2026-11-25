/**
 * Nearest-name suggestions for an unknown tool call.
 *
 * Pure string work, deliberately ignorant of the tool pipeline: the caller
 * supplies the candidate names (the calling agent's visible tools), and these
 * functions only rank them and render the model-facing hint.
 *
 * @module prism-guardrails/tool-hints
 */

/** At most this many names are suggested for one miss. */
const MAX_SUGGESTIONS = 3

/**
 * The edit-distance budget for one missed name: two edits, or a third of the
 * name's length when that is larger, so longer names may miss by
 * proportionally more characters.
 *
 * @param requested - the tool name the call asked for.
 * @returns the largest distance that still counts as a suggestion.
 */
function budgetFor(requested: string): number {
  return Math.max(2, Math.floor(requested.length / 3))
}

/**
 * The candidate names nearest to a missed name, closest first, at most three.
 *
 * Distance is Levenshtein over case-folded names. A case-insensitive substring
 * overlap in either direction earns one character of credit, because the
 * common miss is a casing slip or a stray fragment rather than a transposition.
 *
 * @param requested - the tool name the call asked for.
 * @param candidates - the caller's visible tool names.
 * @returns the ranked names; empty when no candidate is near enough.
 */
export function suggestToolNames(requested: string, candidates: readonly string[]): string[] {
  const budget = budgetFor(requested)
  const wanted = requested.toLowerCase()
  const ranked: { name: string; distance: number }[] = []
  for (const candidate of candidates) {
    const name = candidate.toLowerCase()
    let distance = levenshtein(wanted, name)
    if (name.includes(wanted) || wanted.includes(name)) distance -= 1
    if (distance <= budget) ranked.push({ name: candidate, distance })
  }
  return ranked
    .sort((left, right) => left.distance - right.distance)
    .slice(0, MAX_SUGGESTIONS)
    .map(entry => entry.name)
}

/**
 * The hint appended to an unknown-tool failure.
 *
 * @param suggestions - the ranked names from {@link suggestToolNames}.
 * @returns `did you mean "y"?` for one candidate, `similar tools: "a", "b"`
 *   for several, or `''` when nothing is near and the message stays as it was.
 */
export function toolNameHint(suggestions: readonly string[]): string {
  const quoted = suggestions.map(name => `"${name}"`)
  if (quoted.length === 0) return ''
  if (quoted.length === 1) return `did you mean ${quoted[0] ?? ''}?`
  return `similar tools: ${quoted.join(', ')}`
}

/**
 * Levenshtein edit distance — insert, delete, substitute — over the folded
 * names, one dynamic-programming row at a time.
 *
 * @param left - one folded name.
 * @param right - the other folded name.
 * @returns the minimum number of single-character edits between the two.
 */
function levenshtein(left: string, right: string): number {
  let previousRow: number[] = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const currentRow: number[] = [i]
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (previousRow[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1)
      const insertion = (currentRow[j - 1] ?? i) + 1
      const deletion = (previousRow[j] ?? 0) + 1
      currentRow[j] = Math.min(substitution, insertion, deletion)
    }
    previousRow = currentRow
  }
  return previousRow[right.length] ?? left.length
}
