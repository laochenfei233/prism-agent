/** DashScope frame building, decoding, and authorization against the documented duplex protocol. */
import { describe, expect, it } from 'vitest'
import {
  authorizedUrl,
  DASHSCOPE_DEFAULT_MODEL,
  DASHSCOPE_DEFAULT_URL,
  finishTaskFrame,
  parseRecognitionEvent,
  RecognitionProtocolError,
  runTaskFrame,
} from '../src/protocol.ts'

/** Control frame decoded from the JSON this module builds. */
interface ControlFrame {
  readonly header: Record<string, unknown>
  readonly payload: {
    readonly task?: string
    readonly model?: string
    readonly parameters?: Record<string, unknown>
  }
}

describe('runTaskFrame', () => {
  it('declares PCM16 16 kHz recognition with the configured speaker policy', () => {
    const frame = JSON.parse(runTaskFrame('task-1', 'fun-asr-realtime', { speaker_diarization_enabled: true })) as ControlFrame
    expect(frame).toEqual({
      header: { action: 'run-task', task_id: 'task-1', streaming: 'duplex' },
      payload: {
        task_group: 'audio',
        task: 'asr',
        function: 'recognition',
        model: 'fun-asr-realtime',
        parameters: { format: 'pcm', sample_rate: 16000, speaker_diarization_enabled: true },
        input: {},
      },
    })
  })

  it('lets deployment parameters override the PCM defaults', () => {
    const frame = JSON.parse(runTaskFrame('task-2', DASHSCOPE_DEFAULT_MODEL, { format: 'opus', sample_rate: 8000 })) as ControlFrame
    expect(frame.payload.parameters).toEqual({ format: 'opus', sample_rate: 8000 })
  })
})

describe('finishTaskFrame', () => {
  it('repeats the task id the run frame opened', () => {
    expect(JSON.parse(finishTaskFrame('task-3')) as ControlFrame).toEqual({
      header: { action: 'finish-task', task_id: 'task-3' },
      payload: { input: {} },
    })
  })
})

describe('authorizedUrl', () => {
  it('carries the bearer token as a query parameter', () => {
    const url = new URL(authorizedUrl(DASHSCOPE_DEFAULT_URL, 'sk-abc'))
    expect(url.protocol).toBe('wss:')
    expect(url.origin).toBe('wss://dashscope.aliyuncs.com')
    expect(url.pathname).toBe('/api-ws/v1/inference')
    expect(url.searchParams.get('authorization')).toBe('Bearer sk-abc')
  })

  it('upgrades an HTTP endpoint to a WebSocket scheme', () => {
    expect(authorizedUrl('http://localhost:9000/asr', 'k')).toBe('ws://localhost:9000/asr?authorization=Bearer+k')
  })
})

describe('parseRecognitionEvent', () => {
  it('reads task lifecycle events', () => {
    expect(parseRecognitionEvent('{"header":{"event":"task-started"}}')).toEqual({ kind: 'started' })
    expect(parseRecognitionEvent('{"header":{"event":"task-finished"}}')).toEqual({ kind: 'finished' })
  })

  it('reads a nested sentence result', () => {
    const frame = JSON.stringify({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { text: '会议开始。', sentence_end: true, speaker_id: '2' } } },
    })
    expect(parseRecognitionEvent(frame)).toEqual({
      kind: 'sentence',
      sentence: { text: '会议开始。', final: true, speaker: '2' },
    })
  })

  it('reads a flattened sentence result without a speaker', () => {
    const frame = JSON.stringify({
      header: { event: 'result-generated' },
      payload: { output: { text: '待定', sentence_end: false } },
    })
    expect(parseRecognitionEvent(frame)).toEqual({ kind: 'sentence', sentence: { text: '待定', final: false } })
  })

  it('ignores a result frame that carries no text', () => {
    const frame = JSON.stringify({ header: { event: 'result-generated' }, payload: { output: {} } })
    expect(parseRecognitionEvent(frame)).toEqual({ kind: 'ignored', event: 'result-generated' })
  })

  it('reports the service failure message, falling back to the event name', () => {
    expect(parseRecognitionEvent('{"header":{"event":"task-failed","error_message":"quota exceeded"}}'))
      .toEqual({ kind: 'failed', message: 'quota exceeded' })
    expect(parseRecognitionEvent('{"header":{"event":"error"}}')).toEqual({ kind: 'failed', message: 'error' })
  })

  it('retains an unrecognized event name', () => {
    expect(parseRecognitionEvent('{"header":{"event":"heartbeat"}}')).toEqual({ kind: 'ignored', event: 'heartbeat' })
  })

  it('rejects a frame that is not a JSON object carrying an event', () => {
    expect(() => parseRecognitionEvent('not json')).toThrow(RecognitionProtocolError)
    expect(() => parseRecognitionEvent('{}')).toThrow(RecognitionProtocolError)
    expect(() => parseRecognitionEvent('"started"')).toThrow(RecognitionProtocolError)
  })
})
