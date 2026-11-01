/** Status fixtures and a scripted fetch shared by the browser-side specs. */
import type { GitDiff, GitFileEntry, GitStatus } from '../src/contract.ts'

/** A repository status over the given entries. */
export function gitStatus(entries: GitFileEntry[], overrides: Partial<GitStatus> = {}): GitStatus {
  return { available: true, repo: true, root: '/repo', branch: 'main', entries, ...overrides }
}

/** The JSON answer for one route, as the Host would serve it. */
export function answer(value: unknown, status = 200): Response {
  return Response.json(value, { status })
}

/** A fetch that records its calls and answers from the script in order. */
export function scriptedFetch(...responses: Array<Response | Error>): {
  readonly calls: Array<{ url: string; init: RequestInit | undefined }>
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  let at = 0
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      const response = responses[at++] ?? answer({})
      if (response instanceof Error) throw response
      return response
    },
  }
}

/** A text comparison over one line change. */
export const TEXT_DIFF: GitDiff = {
  kind: 'text',
  path: 'a.txt',
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-one', '+two'] }],
}
