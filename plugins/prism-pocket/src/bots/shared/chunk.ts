/**
 * Reply chunking: split one reply into platform-sized pieces, preferring
 * paragraph boundaries, so no channel receives an oversized message.
 *
 * @module @prism/prism-pocket/bots/shared
 */

/**
 * Split one reply into chunks no longer than the limit.
 * @param text - the reply text.
 * @param limit - the channel's per-message character limit (>= 1).
 * @returns one or more chunks; never an empty array for an empty reply.
 */
export function chunkText(text: string, limit: number): readonly string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    const slice = rest.slice(0, limit)
    // Prefer the last paragraph break; fall back to the last space; else hard-split.
    const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '))
    const cut = breakAt > limit / 2 ? breakAt + 1 : limit
    chunks.push(rest.slice(0, cut).replace(/\n+$/u, ''))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}
