/**
 * Minimal protobuf wire codec for the Feishu/Lark long connection's
 * `pbbp2.Frame` message: varint and length-delimited fields only, exactly
 * the two wire types that message uses. Encoder and decoder are pure.
 *
 * @module @prism/prism-pocket/bots/shared
 */

/** One decoded header entry. */
export interface LarkHeader {
  readonly key: string
  readonly value: string
}

/** One decoded pbbp2.Frame. */
export interface LarkFrame {
  readonly seqId: number
  readonly logId: number
  readonly service: number
  readonly method: number
  readonly headers: readonly LarkHeader[]
  readonly payload: Uint8Array
}

/** Read one base-128 varint at `offset`; returns the value and the next offset. */
export function readVarint(buffer: Uint8Array, offset: number): { value: number; next: number } | undefined {
  let result = 0
  let shift = 0
  let at = offset
  while (at < buffer.byteLength) {
    const byte: number | undefined = buffer[at]
    at += 1
    if (byte === undefined) return undefined
    result += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value: result, next: at }
    shift += 7
    if (shift > 63) return undefined
  }
  return undefined
}

/** Write one base-128 varint into the array. */
export function writeVarint(sink: number[], value: number): void {
  let rest = value
  do {
    let byte = rest % 128
    rest = Math.floor(rest / 128)
    if (rest > 0) byte += 0x80
    sink.push(byte)
  } while (rest > 0)
}

/**
 * Decode one pbbp2.Frame buffer.
 * @param buffer - the WebSocket binary message.
 * @returns the frame, or undefined when the buffer is not a well-formed Frame.
 */
export function decodeLarkFrame(buffer: Uint8Array): LarkFrame | undefined {
  let at = 0
  const header: { seqId: number; logId: number; service: number; method: number } = { seqId: 0, logId: 0, service: 0, method: 0 }
  const headers: LarkHeader[] = []
  let payload: Uint8Array = new Uint8Array(0)
  while (at < buffer.byteLength) {
    const tag = readVarint(buffer, at)
    if (tag === undefined) return undefined
    at = tag.next
    const field = Math.floor(tag.value / 8)
    const wire = tag.value % 8
    if (wire === 0) {
      const value = readVarint(buffer, at)
      if (value === undefined) return undefined
      at = value.next
      if (field === 1) header.seqId = value.value
      else if (field === 2) header.logId = value.value
      else if (field === 3) header.service = value.value
      else if (field === 4) header.method = value.value
      continue
    }
    if (wire !== 2) return undefined
    const length = readVarint(buffer, at)
    if (length === undefined) return undefined
    at = length.next
    if (at + length.value > buffer.byteLength) return undefined
    const slice = buffer.subarray(at, at + length.value)
    at += length.value
    if (field === 5) {
      const entry = decodeLarkHeader(slice)
      if (entry === undefined) return undefined
      headers.push(entry)
      continue
    }
    if (field === 8) payload = slice
    // Fields 6 (payloadEncoding), 7 (payloadType), 9 (LogIDNew) are unused by the adapter.
  }
  return { ...header, headers, payload }
}

/** Decode one nested pbbp2.Header message. */
function decodeLarkHeader(buffer: Uint8Array): LarkHeader | undefined {
  let at = 0
  let key = ''
  let value = ''
  while (at < buffer.byteLength) {
    const tag = readVarint(buffer, at)
    if (tag === undefined) return undefined
    at = tag.next
    if (tag.value % 8 !== 2) return undefined
    const length = readVarint(buffer, at)
    if (length === undefined) return undefined
    at = length.next
    if (at + length.value > buffer.byteLength) return undefined
    const text = new TextDecoder().decode(buffer.subarray(at, at + length.value))
    at += length.value
    const field = Math.floor(tag.value / 8)
    if (field === 1) key = text
    else if (field === 2) value = text
  }
  return { key, value }
}

/**
 * Encode one pbbp2.Frame.
 * @param frame - the frame to encode; only the fields the protocol carries.
 * @returns the wire bytes.
 */
export function encodeLarkFrame(frame: {
  seqId?: number
  logId?: number
  service?: number
  method: number
  headers?: readonly LarkHeader[]
  payload?: Uint8Array
}): Uint8Array {
  const sink: number[] = []
  const varint = (field: number, value: number): void => {
    writeVarint(sink, field * 8)
    writeVarint(sink, value)
  }
  const bytes = (field: number, data: Uint8Array): void => {
    writeVarint(sink, field * 8 + 2)
    writeVarint(sink, data.byteLength)
    for (const byte of data) sink.push(byte)
  }
  if (frame.seqId !== undefined) varint(1, frame.seqId)
  if (frame.logId !== undefined) varint(2, frame.logId)
  if (frame.service !== undefined) varint(3, frame.service)
  varint(4, frame.method)
  for (const header of frame.headers ?? []) {
    const body: number[] = []
    const text = (field: number, value: string): void => {
      writeVarint(body, field * 8 + 2)
      writeVarint(body, value.length)
      for (const byte of Buffer.from(value, 'utf8')) body.push(byte)
    }
    text(1, header.key)
    text(2, header.value)
    bytes(5, Uint8Array.from(body))
  }
  if (frame.payload !== undefined) bytes(8, frame.payload)
  return Uint8Array.from(sink)
}
