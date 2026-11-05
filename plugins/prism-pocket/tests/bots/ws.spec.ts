/**
 * ReconnectingWs lifecycle: bounded reconnect backoff, the generation guard
 * that discards a superseded slow dial, heartbeat installation while open,
 * and stop semantics. A scripted fake socket stands in for the platform
 * WebSocket; reconnect delays are asserted on fake timers, never wall-clock.
 *
 * @module @prism/prism-pocket/tests/bots
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReconnectingWs, type ManagedWsHooks } from '../../src/bots/shared/ws.ts'

const CONNECTING = 0
const OPEN = 1
const CLOSED = 3

/** Every fake built so far, in dial order. */
const created: FakeSocket[] = []

/**
 * A scripted WebSocket over Node's real event dispatch: the test drives
 * open and close, the unit drives the rest. `closed` records whether
 * `close()` ran, whatever the socket's listener state.
 */
class FakeSocket extends EventTarget implements WebSocket {
  binaryType: BinaryType = 'blob'
  bufferedAmount = 0
  extensions = ''
  protocol = ''
  readyState: 0 | 1 | 2 | 3 = CONNECTING
  sent: string[] = []
  closed = false
  readonly url: string
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null
  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null
  readonly CONNECTING: 0 = 0
  readonly OPEN: 1 = 1
  readonly CLOSING: 2 = 2
  readonly CLOSED: 3 = 3

  constructor(url: string) {
    super()
    this.url = url
    created.push(this)
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.readyState = CLOSED
    this.dispatchEvent(new Event('close'))
  }

  /** Test driver: the platform accepted the connection. */
  open(): void {
    if (this.closed || this.readyState === OPEN) return
    this.readyState = OPEN
    this.dispatchEvent(new Event('open'))
  }
}

/** Recording hooks for one unit under test. */
function hooks(): ManagedWsHooks {
  return {
    onOpen: vi.fn(),
    onMessage: vi.fn(),
    onClosed: vi.fn(),
    onError: vi.fn(),
  }
}

/** Drain the microtasks a dial's continuation waits on. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** The most recently created fake, when the test cannot proceed without one. */
function lastSocket(): FakeSocket {
  const socket = created.at(-1)
  if (socket === undefined) throw new Error('expected a dialed socket in the test')
  return socket
}

beforeEach(() => {
  created.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ReconnectingWs', () => {
  it('escalates the reconnect delay exponentially and caps it at 60s', async () => {
    vi.useFakeTimers()
    const ws = new ReconnectingWs(() => new FakeSocket('ws://x'), hooks())
    ws.start()
    await flush()
    // A close without an open escalates the next delay: 1s, 2s, 4s, … capped at 60s.
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60_000, 60_000]) {
      lastSocket().close()
      const before = created.length
      vi.advanceTimersByTime(delay - 1)
      expect(created.length).toBe(before)
      vi.advanceTimersByTime(1)
      await flush()
      expect(created.length).toBe(before + 1)
    }
    ws.stop()
  })

  it('discards a superseded slow dial so the fresh generation owns the socket', async () => {
    const mints: Array<(socket: FakeSocket) => void> = []
    const wsHooks = hooks()
    const ws = new ReconnectingWs((): Promise<FakeSocket> => {
      return new Promise(resolve => { mints.push(resolve) })
    }, wsHooks)
    ws.start()
    await flush()
    expect(mints).toHaveLength(1)
    ws.stop() // supersedes the in-flight dial's generation
    ws.start() // restarts nothing while the stale dial is still connecting
    expect(mints).toHaveLength(1)
    const stale = new FakeSocket('ws://stale')
    mints[0]?.(stale)
    await flush()
    expect(stale.closed).toBe(true) // resolved late and discarded, never wired
    expect(wsHooks.onOpen).not.toHaveBeenCalled()
    expect(wsHooks.onError).not.toHaveBeenCalled()
    ws.start()
    await flush()
    expect(mints).toHaveLength(2)
    const fresh = new FakeSocket('ws://fresh')
    mints[1]?.(fresh)
    await flush()
    fresh.open()
    ws.send('ping')
    expect(wsHooks.onOpen).toHaveBeenCalledTimes(1)
    expect(fresh.sent).toEqual(['ping'])
    ws.stop()
  })

  it('arms the heartbeat while open and clears it on close', async () => {
    vi.useFakeTimers()
    const onHeartbeat = vi.fn()
    const wsHooks = hooks()
    const ws = new ReconnectingWs(() => new FakeSocket('ws://h'), wsHooks, 3000, onHeartbeat)
    ws.start()
    await flush()
    expect(onHeartbeat).not.toHaveBeenCalled()
    lastSocket().open()
    vi.advanceTimersByTime(3000)
    expect(onHeartbeat).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(6000)
    expect(onHeartbeat).toHaveBeenCalledTimes(3)
    lastSocket().close()
    vi.advanceTimersByTime(9000)
    expect(onHeartbeat).toHaveBeenCalledTimes(3)
    expect(wsHooks.onClosed).toHaveBeenCalledWith(true)
    ws.stop()
  })

  it('stop() closes the open socket and prevents any further reconnect', async () => {
    vi.useFakeTimers()
    const wsHooks = hooks()
    const ws = new ReconnectingWs(() => new FakeSocket('ws://s'), wsHooks)
    ws.start()
    await flush()
    lastSocket().open()
    ws.stop()
    expect(wsHooks.onClosed).toHaveBeenCalledWith(false)
    const count = created.length
    vi.advanceTimersByTime(600_000)
    expect(created.length).toBe(count)
    expect(wsHooks.onOpen).toHaveBeenCalledTimes(1)
  })

  it('stop() cancels a pending reconnect timer', async () => {
    vi.useFakeTimers()
    const wsHooks = hooks()
    const ws = new ReconnectingWs(() => new FakeSocket('ws://s'), wsHooks)
    ws.start()
    await flush()
    lastSocket().close() // schedules the 1s reconnect
    expect(wsHooks.onClosed).toHaveBeenCalledWith(true)
    ws.stop()
    vi.advanceTimersByTime(600_000)
    expect(created.length).toBe(1)
    expect(wsHooks.onOpen).not.toHaveBeenCalled()
  })
})
