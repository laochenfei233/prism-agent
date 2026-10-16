/** Wire rules the recognizer relies on: URL joining, response decoding, and diagnostics. */
import { describe, expect, it } from 'vitest'
import { AUTO_LANGUAGE, decodeJson, failureDetail, OPENAI_DEFAULT_BASE_URL, transcriptEvent, transcriptText, transcriptionUrl } from '../src/protocol.ts'

describe('transcriptionUrl', () => {
  it('appends the transcription path to the configured root', () => {
    expect(transcriptionUrl(OPENAI_DEFAULT_BASE_URL)).toBe('https://api.openai.com/v1/audio/transcriptions')
  })

  it.each([['https://gateway.example/v1/'], ['https://gateway.example/v1///']])(
    'drops trailing slashes from %s',
    (baseUrl) => {
      expect(transcriptionUrl(baseUrl)).toBe('https://gateway.example/v1/audio/transcriptions')
    },
  )
})

describe('transcriptText', () => {
  it('reads the text field', () => {
    expect(transcriptText({ text: 'hello' })).toBe('hello')
    expect(transcriptText({ text: '' })).toBe('')
  })

  it.each([[null], ['hello'], [{ text: 42 }], [{}]])('rejects the payload %s', (payload) => {
    expect(() => transcriptText(payload)).toThrow('The transcription response carried no text field')
  })
})

describe('decodeJson', () => {
  it('decodes a JSON body', () => {
    expect(decodeJson('{"text":"hi"}')).toEqual({ text: 'hi' })
  })

  it('names the syntax failure as its cause', () => {
    expect(() => decodeJson('<html>')).toThrow('The transcription response was not JSON')
    try {
      decodeJson('<html>')
      expect.unreachable('decodeJson accepted a non-JSON body')
    } catch (error) {
      expect((error as Error).cause).toBeInstanceOf(SyntaxError)
    }
  })
})

describe('failureDetail', () => {
  it('omits an empty body', () => {
    expect(failureDetail('')).toBe('')
    expect(failureDetail('  \n ')).toBe('')
  })

  it('collapses whitespace into one line', () => {
    expect(failureDetail('  rate\n limit  ')).toBe(': rate limit')
  })

  it('bounds a long body and marks the truncation', () => {
    const detail = failureDetail('x'.repeat(600))
    expect(detail).toBe(`: ${'x'.repeat(500)}…`)
  })

  it('keeps a body of exactly the bound intact', () => {
    expect(failureDetail('y'.repeat(500))).toBe(`: ${'y'.repeat(500)}`)
  })
})

describe('AUTO_LANGUAGE', () => {
  it('is the seam sentinel the request omits', () => {
    expect(AUTO_LANGUAGE).toBe('auto')
  })
})

describe('transcriptEvent', () => {
  it('decodes every event this provider consumes', () => {
    expect(transcriptEvent('{"type":"transcript.text.delta","delta":"hi"}'))
      .toEqual({ type: 'transcript.text.delta', delta: 'hi' })
    expect(transcriptEvent('{"type":"transcript.text.done","text":"hi"}'))
      .toEqual({ type: 'transcript.text.done', text: 'hi' })
    expect(transcriptEvent('{"type":"transcript.text.segment","id":"s","text":"t","speaker":"A","start":0,"end":1}'))
      .toEqual({ type: 'transcript.text.segment', id: 's', text: 't', speaker: 'A', start: 0, end: 1 })
  })

  it('ignores the end-of-stream sentinel and every event it does not know', () => {
    expect(transcriptEvent('[DONE]')).toBeUndefined()
    expect(transcriptEvent('{"type":"transcript.heartbeat"}')).toBeUndefined()
    expect(transcriptEvent('42')).toBeUndefined()
    expect(transcriptEvent('null')).toBeUndefined()
  })

  it.each([
    ['{"type":"transcript.text.delta"}'],
    ['{"type":"transcript.text.done"}'],
    ['{"type":"transcript.text.segment","text":"t","speaker":"A","start":0,"end":1}'],
    ['{"type":"transcript.text.segment","id":"s","speaker":"A","start":0,"end":1}'],
    ['{"type":"transcript.text.segment","id":"s","text":"t","start":0,"end":1}'],
    ['{"type":"transcript.text.segment","id":"s","text":"t","speaker":"A","end":1}'],
    ['{"type":"transcript.text.segment","id":"s","text":"t","speaker":"A","start":0}'],
  ])('rejects the incomplete event %s', (payload) => {
    expect(() => transcriptEvent(payload)).toThrow('A transcription event carried no')
  })

  it('rejects a payload that is not JSON', () => {
    expect(() => transcriptEvent('<html>')).toThrow('The transcription response was not JSON')
  })
})
