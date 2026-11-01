// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
/** Line numbering for unified-diff hunks, shared by every comparison view in the product. */

/**
 * The part of a unified-diff hunk that row numbering reads: where each side
 * starts and its prefixed body. A served `WorkspaceDiffHunk` satisfies it
 * structurally, so this module depends on no diff producer.
 */
export interface DiffHunkLines {
  /** First line of the hunk on the old side, 1-based. */
  readonly oldStart: number
  /** First line of the hunk on the new side, 1-based. */
  readonly newStart: number
  /** Hunk body in order, each line prefixed with `+`, `-`, or a space. */
  readonly lines: readonly string[]
}

/** One drawn line of a hunk with its line numbers on each side. */
export interface DiffRow {
  kind: 'add' | 'del' | 'context'
  old: number | undefined
  new: number | undefined
  text: string
}

/**
 * Number a hunk's lines: context lines count on both sides, deletions on the
 * old side, additions on the new side.
 * @param hunk - a hunk whose lines carry their `+`, `-`, or space prefix.
 * @returns the rows in order.
 */
export function hunkRows(hunk: DiffHunkLines): DiffRow[] {
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  return hunk.lines.map((line) => {
    const text = line.slice(1)
    switch (line[0]) {
      case '+': return { kind: 'add', old: undefined, new: newNo++, text }
      case '-': return { kind: 'del', old: oldNo++, new: undefined, text }
      default: return { kind: 'context', old: oldNo++, new: newNo++, text }
    }
  })
}
