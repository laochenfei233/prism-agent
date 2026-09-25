/** Protocol frame construction, service-frame decoding, and URL authorization. */
import { describe, expect, it } from 'vitest'
import {
  authorizedUrl,
  DASHSCOPE_SAMPLE_RATE,
  finishTaskFrame,
  parseRecognitionEvent,
  RecognitionProtocolError,
  runTaskFrame,
} from '../src/protocol.ts'

describe('DashScope recognition frames', () => {
  it('builds the duplex run-task frame with PCM defaults and parameter overrides', () => {
    const frame = JSON.parse(runTaskFrame('task-1', 'fun-asr-realtime', {
      sample_rate: 8000,
      speaker_diarization_enabled: true,
    })) as Record<string, unknown>
    expect(frame).toEqual({
      header: { action: 'run-task', task_id: 'task-1', streaming: 'duplex' },
      payload: {
        task_group: 'audio', task: 'asr', function: 'recognition', model: 'fun-asr-realtime',
        parameters: { format: 'pcm', sample_rate: 8000, speaker_diarization_enabled: true }, input: {},
      },
    })
    expect(DASHSCOPE_SAMPLE_RATE).toBe(16_000)
  })

  it('builds the finish-task frame with the same task id', () => {
    expect(JSON.parse(finishTaskFrame('task-1'))).toEqual({
      header: { action: 'finish-task', task_id: 'task-1' }, payload: { input: {} },
    })
  })

  it('authorizes WebSocket URLs and upgrades HTTP endpoints without exposing the key in the path', () => {
    expect(authorizedUrl('wss://dashscope.example/inference', 'secret')).toBe('wss://dashscope.example/inference?authorization=Bearer+secret')
    expect(authorizedUrl('http://dashscope.example/inference', 'secret').startsWith('ws://')).toBe(true)
    expect(authorizedUrl('https://dashscope.example/inference', 'secret').startsWith('wss://')).toBe(true)
  })
})

describe('DashScope service frame parsing', () => {
  it('decodes lifecycle events and failure messages in precedence order', () => {
    expect(parseRecognitionEvent('{"header":{"event":"task-started"}}')).toEqual({ kind: 'started' })
    expect(parseRecognitionEvent('{"header":{"event":"task-finished"}}')).toEqual({ kind: 'finished' })
    expect(parseRecognitionEvent('{"header":{"event":"task-failed","error_message":"quota"}}')).toEqual({
      kind: 'failed', message: 'quota',
    })
    expect(parseRecognitionEvent('{"header":{"event":"failed"},"payload":{"message":"transport"}}')).toEqual({
      kind: 'failed', message: 'transport',
    })
    expect(parseRecognitionEvent('{"header":{"event":"error"}}')).toEqual({ kind: 'failed', message: 'error' })
  })

  it('decodes nested, flattened, and speaker-labelled sentences', () => {
    expect(parseRecognitionEvent(JSON.stringify({
      header: { event: 'result-generated' },
      payload: { output: { sentence: { text: 'meeting started', sentence_end: true, speaker_id: 'spk-1' } } },
    }))).toEqual({
      kind: 'sentence', sentence: { text: 'meeting started', final: true, speaker: 'spk-1' },
    })
    expect(parseRecognitionEvent(JSON.stringify({
      header: { event: 'result-generated' }, payload: { output: { text: 'hello', sentence_end: false } },
    }))).toEqual({ kind: 'sentence', sentence: { text: 'hello', final: false } })
  })

  it('ignores empty results and unrecognized events but rejects unusable frames', () => {
    expect(parseRecognitionEvent('{"header":{"event":"result-generated"},"payload":{"output":{"text":""}}}')).toEqual({
      kind: 'ignored', event: 'result-generated',
    })
    expect(parseRecognitionEvent('{"header":{"event":"custom-notice"}}')).toEqual({ kind: 'ignored', event: 'custom-notice' })
    expect(() => parseRecognitionEvent('{')).toThrow(RecognitionProtocolError)
    expect(() => parseRecognitionEvent('{"payload":{}}')).toThrow(RecognitionProtocolError)
    expect(new RecognitionProtocolError('bad frame').name).toBe('RecognitionProtocolError')
  })
})
