/** Minutes structures, transcript documents, and bounded previews. */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MINUTES_TEMPLATE,
  MINUTES_TEMPLATES,
  MINUTES_TEMPLATE_IDS,
} from '../src/templates.ts'
import { formatDuration, previewTranscript, renderTranscriptDocument } from '../src/transcript.ts'

describe('templates', () => {
  it('offers the four structures the tool schema enumerates', () => {
    expect(MINUTES_TEMPLATE_IDS).toEqual(['default', 'detailed', 'action-focused', 'decision'])
    expect(DEFAULT_MINUTES_TEMPLATE).toBe('default')
    expect(Object.keys(MINUTES_TEMPLATES).sort()).toEqual([...MINUTES_TEMPLATE_IDS].sort())
  })

  it('gives every structure a title and at least one section', () => {
    for (const id of MINUTES_TEMPLATE_IDS) {
      const template = MINUTES_TEMPLATES[id]
      expect(template.startsWith('# ')).toBe(true)
      expect(template).toContain('\n## ')
    }
  })
})

describe('formatDuration', () => {
  it.each([
    { seconds: 0, expected: '0:00' },
    { seconds: 45, expected: '0:45' },
    { seconds: 90, expected: '1:30' },
    { seconds: 3599, expected: '59:59' },
    { seconds: 3600, expected: '1:00:00' },
    { seconds: 3723, expected: '1:02:03' },
  ])('renders $seconds seconds as $expected', ({ seconds, expected }) => {
    expect(formatDuration(seconds)).toBe(expected)
  })
})

describe('renderTranscriptDocument', () => {
  it('records the meeting facts above the transcript', () => {
    const document = renderTranscriptDocument({
      title: 'Weekly sync',
      participants: ['Ada', 'Grace'],
      transcribedAt: new Date('2026-09-24T02:30:00.000Z'),
      audioSeconds: 3723,
      recordingPath: '/recordings/weekly.wav',
      text: '第一句\n第二句',
    })
    expect(document).toBe([
      '# Transcript: Weekly sync',
      '',
      '- Recorded: 2026-09-24T02:30:00.000Z',
      '- Duration: 1:02:03',
      '- Participants: Ada, Grace',
      '- Recording: /recordings/weekly.wav',
      '',
      '---',
      '',
      '第一句',
      '第二句',
      '',
    ].join('\n'))
  })

  it('omits the participants line when none were named', () => {
    const document = renderTranscriptDocument({
      title: 'Standup',
      participants: [],
      transcribedAt: new Date('2026-09-24T02:30:00.000Z'),
      audioSeconds: 60,
      recordingPath: 'standup.wav',
      text: '',
    })
    expect(document).not.toContain('Participants')
    expect(document).toContain('# Transcript: Standup')
  })
})

describe('previewTranscript', () => {
  it('returns the whole text when it fits', () => {
    expect(previewTranscript('abc', 3)).toEqual({ preview: 'abc', truncated: false })
  })

  it('returns the bounded prefix and reports the omission', () => {
    expect(previewTranscript('abcdef', 3)).toEqual({ preview: 'abc', truncated: true })
  })
})
