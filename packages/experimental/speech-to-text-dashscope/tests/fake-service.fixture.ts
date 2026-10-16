/**
 * A stand-in DashScope duplex endpoint for provider tests: it answers `run-task`,
 * records uploaded audio, and replays a scripted result sequence.
 * @module
 */

import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'

/** Control frames this endpoint expects to receive. */
export interface ReceivedFrame {
  readonly header?: {
    readonly action?: string
    readonly task_id?: string
    readonly streaming?: string
  }
  readonly payload?: {
    readonly model?: string
    readonly parameters?: Record<string, unknown>
    readonly task?: string
  }
}

/** One scripted `result-generated` sentence. */
export interface ScriptedSentence {
  readonly text: string
  readonly final: boolean
  /** Service-assigned speaker; omitted leaves the sentence unattributed. */
  readonly speaker?: string
}

/** Per-connection service behavior. */
export interface ServiceScript {
  /** Results sent after `finish-task`, in order. */
  readonly sentences?: readonly ScriptedSentence[]
  /** Results sent as soon as the task starts, so a live session receives them mid-stream. */
  readonly liveSentences?: readonly ScriptedSentence[]
  /** An unrecognized event name sent after `task-started`, which a consumer must ignore. */
  readonly liveNoise?: boolean
  /** Start-phase fault the service raises instead of accepting the task. */
  readonly startFault?: 'malformed' | 'finished' | 'graceful'
  /** When set, the service fails the task with this message instead of producing results. */
  readonly failWith?: string
  /** When false, the service accepts `finish-task` but never reports completion. */
  readonly finish?: boolean
  /** When true, the service records frames and answers none of them. */
  readonly stall?: boolean
}

/** A local duplex endpoint that speaks the frames this provider sends. */
export class FakeDashScopeService {
  /** JSON control frames received across all connections, in arrival order. */
  readonly requests: ReceivedFrame[] = []
  /** Binary PCM frames received across all connections, in arrival order. */
  readonly audio: Buffer[] = []
  /** Authorization query values received, one per connection. */
  readonly authorizations: (string | null)[] = []

  private readonly server: WebSocketServer
  private readonly sockets = new Set<WebSocket>()
  private closed = false

  private constructor(server: WebSocketServer, private readonly script: ServiceScript) {
    this.server = server
    server.on('connection', (socket, request) => {
      this.sockets.add(socket)
      const url = new URL(request.url ?? '/', 'ws://localhost')
      this.authorizations.push(url.searchParams.get('authorization'))
      socket.on('message', (data: Buffer, isBinary: boolean) => { this.receive(socket, data, isBinary) })
      socket.on('close', () => { this.sockets.delete(socket) })
    })
  }

  /**
   * Start a service on an ephemeral loopback port.
   * @param script - behavior applied to every connection.
   * @returns the started service.
   */
  static async start(script: ServiceScript = {}): Promise<FakeDashScopeService> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => { server.once('listening', () => { resolve() }) })
    return new FakeDashScopeService(server, script)
  }

  /** Endpoint URL clients connect to. */
  get url(): string {
    const address = this.server.address() as AddressInfo
    return `ws://127.0.0.1:${address.port}/api-ws/v1/inference`
  }

  /** Every audio byte the service received, concatenated. */
  get uploaded(): Buffer {
    return Buffer.concat(this.audio)
  }

  /** Stop the service and drop its connections. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const socket of this.sockets) socket.terminate()
    this.sockets.clear()
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
  }

  /** Route one inbound frame; binary frames are audio, text frames are control. */
  private receive(socket: WebSocket, data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      this.audio.push(Buffer.from(data))
      return
    }
    const frame = JSON.parse(data.toString('utf8')) as ReceivedFrame
    this.requests.push(frame)
    if (this.script.stall === true) return
    const taskId = frame.header?.task_id ?? ''
    if (frame.header?.action === 'run-task') {
      if (this.script.failWith !== undefined) {
        socket.send(JSON.stringify({ header: { event: 'task-failed', task_id: taskId, error_message: this.script.failWith } }))
        return
      }
      if (this.script.startFault === 'malformed') {
        socket.send('{"header":{}}')
        return
      }
      if (this.script.startFault === 'finished') {
        socket.send(JSON.stringify({ header: { event: 'task-finished', task_id: taskId } }))
        return
      }
      socket.send(JSON.stringify({ header: { event: 'task-started', task_id: taskId } }))
      if (this.script.startFault === 'graceful') {
        socket.close()
        return
      }
      if (this.script.liveNoise === true) {
        socket.send(JSON.stringify({ header: { event: 'heartbeat', task_id: taskId } }))
      }
      for (const sentence of this.script.liveSentences ?? []) this.sendSentence(socket, taskId, sentence)
      return
    }
    if (frame.header?.action === 'finish-task') {
      for (const sentence of this.script.sentences ?? []) this.sendSentence(socket, taskId, sentence)
      if (this.script.finish !== false) {
        socket.send(JSON.stringify({ header: { event: 'task-finished', task_id: taskId } }))
      }
    }
  }

  /**
   * Send one scripted `result-generated` frame.
   * @param socket - the connection to answer.
   * @param taskId - correlation id the frame repeats.
   * @param sentence - the sentence to report.
   */
  private sendSentence(socket: WebSocket, taskId: string, sentence: ScriptedSentence): void {
    socket.send(JSON.stringify({
      header: { event: 'result-generated', task_id: taskId },
      payload: {
        output: {
          sentence: {
            text: sentence.text,
            sentence_end: sentence.final,
            ...sentence.speaker === undefined ? {} : { speaker_id: sentence.speaker },
          },
        },
      },
    }))
  }
}

/**
 * Build a canonical 16 kHz mono PCM16 WAV recording of silence.
 * @param seconds - recording duration in seconds.
 * @returns complete WAV bytes, including the 44-byte header.
 */
export function waveRecording(seconds: number): Uint8Array {
  const samples = 16000 * seconds
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(36 + samples * 2, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24)
  bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(samples * 2, 40)
  return new Uint8Array(bytes)
}
