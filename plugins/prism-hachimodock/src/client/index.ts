/**
 * Browser half of the HachimoDock bridge: subscribe to the same-origin
 * activation stream and switch the conversation the device picked. No UI, no
 * pairing controls, no credentials beyond the authenticated channel; an
 * unknown or stale session id is ignored.
 */

/** Same-origin activation stream served by the host half. */
const ACTIVATION_PATH = '/api/hachimodock/activation'

/** Client services this half needs. */
export const inject = ['sessions', 'uiWorkspace']

/** Structural duck types; the browser half ships without type dependencies. */
interface SessionsService {
  list?: { getSnapshot?: () => { ids?: readonly string[] } | undefined } | undefined
}

interface WorkspaceService {
  openSession?: (target: string) => void
}

interface ClientContext {
  effect?: (factory: () => (() => void) | void, label: string) => unknown
  get?: (name: string) => unknown
}

/** One `session-activated` SSE payload. */
interface ActivationPayload {
  type?: string
  sessionId?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Parse one bounded SSE buffer and return completed frames. */
function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = []
  let at = buffer.indexOf('\n\n')
  while (at >= 0) {
    frames.push(buffer.slice(0, at))
    buffer = buffer.slice(at + 2)
    at = buffer.indexOf('\n\n')
  }
  return { frames, rest: buffer }
}

/**
 * Register the activation consumer.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  let stopped = false
  let controller: AbortController | undefined

  const sessions = (): SessionsService | undefined => ctx.get?.('sessions') as SessionsService | undefined
  const workspace = (): WorkspaceService | undefined => ctx.get?.('uiWorkspace') as WorkspaceService | undefined

  const known = (sessionId: string): boolean => {
    try {
      const snapshot = sessions()?.list?.getSnapshot?.()
      return Array.isArray(snapshot?.ids) && (snapshot as { ids: readonly string[] }).ids.includes(sessionId)
    } catch {
      return false
    }
  }

  const activate = (payload: ActivationPayload): void => {
    // Only a listed live session id switches the view; anything else is
    // stale device state and is dropped without navigating.
    if (payload?.type !== 'session-activated' || typeof payload.sessionId !== 'string') return
    if (!known(payload.sessionId)) return
    try {
      workspace()?.openSession?.(payload.sessionId)
    } catch {
      /* an unavailable navigation target must not break the stream */
    }
  }

  const consume = async (signal: AbortSignal): Promise<void> => {
    const response = await fetch(ACTIVATION_PATH, {
      headers: { accept: 'text/event-stream' },
      cache: 'no-store',
      signal,
    })
    if (!response.ok || !response.body) throw new Error('activation stream unavailable')
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffer = ''
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read()
        if (done) throw new Error('activation stream disconnected')
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
        if (buffer.length > 65536) throw new Error('activation frame too large')
        const { frames, rest } = splitFrames(buffer)
        buffer = rest
        for (const frame of frames) {
          let data = ''
          for (const line of frame.split('\n')) {
            if (line.startsWith('data:')) data += line.slice(5).trimStart()
          }
          if (!data) continue
          try {
            activate(JSON.parse(data) as ActivationPayload)
          } catch {
            /* a malformed frame is dropped, never fatal */
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
  }

  ctx.effect?.(() => {
    const run = async (): Promise<void> => {
      let attempt = 0
      while (!stopped) {
        controller = new AbortController()
        try {
          await consume(controller.signal)
          attempt = 0
        } catch {
          /* fall through to the bounded backoff */
        }
        if (stopped) return
        await sleep(Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)))
        attempt += 1
      }
    }
    void run()
    return () => {
      stopped = true
      controller?.abort()
    }
  }, 'hachimodock: activation client')
}
