/** Event-stream decoding: block boundaries, line endings, and payload extraction. */
import { describe, expect, it } from 'vitest'
import { payloadOf, sseData } from '../src/sse.ts'

/** Build one response body delivering exactly these byte chunks, in order. */
function bodyOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** Read every payload one body carries. */
async function collect(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal = new AbortController().signal,
): Promise<string[]> {
  const payloads: string[] = []
  for await (const payload of sseData(body, signal)) payloads.push(payload)
  return payloads
}

describe('payloadOf', () => {
  it('joins the data lines of one block', () => {
    expect(payloadOf('data: one\ndata: two')).toBe('one\ntwo')
  })

  it('strips at most one leading space', () => {
    expect(payloadOf('data: padded')).toBe('padded')
    expect(payloadOf('data:  kept')).toBe(' kept')
    expect(payloadOf('data:tight')).toBe('tight')
  })

  it('reports a block that carries no data', () => {
    expect(payloadOf(': keep-alive')).toBeUndefined()
    expect(payloadOf('event: ping')).toBeUndefined()
  })
})

describe('sseData', () => {
  it('reads one payload per blank-line-separated block', async () => {
    expect(await collect(bodyOf(['data: one\n\ndata: two\n\n']))).toEqual(['one', 'two'])
  })

  it('reassembles a frame split across reads', async () => {
    expect(await collect(bodyOf(['data: he', 'llo\n', '\n']))).toEqual(['hello'])
  })

  it('accepts CRLF and bare CR line endings', async () => {
    expect(await collect(bodyOf(['data: a\r\n\r\ndata: b\r\r']))).toEqual(['a', 'b'])
  })

  it('flushes a final block the body ended without closing', async () => {
    expect(await collect(bodyOf(['data: tail']))).toEqual(['tail'])
  })

  it('skips a block that carries no data', async () => {
    expect(await collect(bodyOf([': ping\n\ndata: kept\n\n']))).toEqual(['kept'])
  })

  it('stops when the observer is cancelled', async () => {
    const caller = new AbortController()
    caller.abort(new Error('cancelled while reading'))
    await expect(collect(bodyOf(['data: one\n\n']), caller.signal)).rejects.toThrow('cancelled while reading')
  })
})
