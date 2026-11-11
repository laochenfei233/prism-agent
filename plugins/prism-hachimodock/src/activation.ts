/**
 * Conversation-switch fan-out. The bridge's `POST /sessions/activate` (bus
 * token, loopback) validates a live session and hands it here; subscribers
 * are prism web clients reading the same-origin authenticated route
 * `GET /api/hachimodock/activation`. Activations are UI commands: live
 * events only, never replayed, and no window focus change.
 *
 * @module @prism/prism-hachimodock/activation
 */

import type { LoggerLike } from './types.ts'

/** Same-origin route path for the activation stream. */
export const ACTIVATION_PATH = '/api/hachimodock/activation'

/** Maximum concurrent web subscribers; extra clients are refused. */
const MAX_CLIENTS = 8
/** Comment interval keeping idle activation streams alive. */
const KEEPALIVE_MS = 15_000

/** One live activation event pushed to subscribers. */
export interface ActivationEvent {
  readonly type: 'session-activated'
  readonly sessionId: string
  readonly at: number
}

interface ActivationClient {
  writable: boolean
  send: (text: string) => boolean
  close: () => void
  stopKeepAlive: () => void
}

/**
 * Fan one activation out to every connected web client. A slow client whose
 * stream write fails is dropped, never retried.
 */
export class ActivationHub {
  private readonly clients = new Set<ActivationClient>()

  constructor(
    private readonly logger: LoggerLike | null = null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Subscribe one web client. The response is an SSE stream over the
   * authenticated same-origin channel; abort ends the subscription.
   */
  subscribe(request: Request): Response {
    if (this.clients.size >= MAX_CLIENTS) {
      return new Response(JSON.stringify({ ok: false, error: 'subscriber-capacity' }), {
        status: 503,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    const encoder = new TextEncoder()
    let client: ActivationClient | undefined
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (text: string): boolean => {
          try {
            controller.enqueue(encoder.encode(text))
            return true
          } catch {
            return false
          }
        }
        const close = (): void => {
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        }
        let keepAlive: ReturnType<typeof setInterval> | undefined
        const stopKeepAlive = (): void => {
          if (keepAlive !== undefined) {
            clearInterval(keepAlive)
            keepAlive = undefined
          }
        }
        client = { writable: true, send, close, stopKeepAlive }
        this.clients.add(client)
        send(': connected\n\n')
        keepAlive = setInterval(() => {
          if (client?.writable !== true || !send(': keep-alive\n\n')) this.drop(client)
        }, KEEPALIVE_MS)
      },
      cancel: () => {
        this.drop(client)
      },
    })
    request.signal.addEventListener('abort', () => {
      this.drop(client)
    })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
      },
    })
  }

  /**
   * Broadcast one validated conversation switch. Live events only: a client
   * that connects later never learns about past activations.
   */
  activate(sessionId: string): void {
    const event: ActivationEvent = { type: 'session-activated', sessionId, at: this.now() }
    const frame = `event: session-activated\ndata: ${JSON.stringify(event)}\n\n`
    for (const client of [...this.clients]) {
      try {
        if (!client.send(frame)) this.drop(client)
      } catch (error) {
        this.logger?.warn?.(error)
        this.drop(client)
      }
    }
  }

  /** End every subscription; used on plugin dispose. */
  close(): void {
    for (const client of [...this.clients]) {
      this.drop(client)
      client.close()
    }
    this.clients.clear()
  }

  private drop(client: ActivationClient | undefined): void {
    if (client === undefined) return
    client.stopKeepAlive()
    client.writable = false
    this.clients.delete(client)
  }
}
