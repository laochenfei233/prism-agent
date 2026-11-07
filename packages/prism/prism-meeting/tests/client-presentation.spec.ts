/** Meeting-page folds and formatters. */

import { describe, expect, it } from 'vitest'
import type { MeetingView } from '../src/view.ts'
import {
  bytesText, compatibleLanguage, downloadProgress, durationText, filterMeetings, parseParticipants,
  rowMeta, selectedSpeechProvider, speechNotice, speechPhaseAction, statusLabel, timestampText,
  transcriptLines,
} from '../src/client/presentation.ts'
import { zh } from '../src/client/locales.ts'

/** One stored meeting with the fields a case is about. */
function meeting(overrides: Partial<MeetingView> = {}): MeetingView {
  return {
    id: 'm1',
    title: 'Weekly sync',
    participants: [],
    status: 'transcribed',
    summary: null,
    transcript: 'Notes.',
    segments: [],
    transcriptChars: 6,
    audioSeconds: 0,
    createdAt: '2026-09-26T02:30:00.000Z',
    updatedAt: '2026-09-26T02:30:00.000Z',
    ...overrides,
  }
}

/** Substitute `{name}` placeholders in one dictionary line. */
function translate(key: keyof typeof zh, params: Record<string, string> = {}): string {
  return Object.entries(params).reduce(
    (line, [name, value]) => line.replace(`{${name}}`, value),
    zh[key],
  )
}

describe('filterMeetings', () => {
  const rows = [
    meeting({ id: 'a', title: 'Weekly sync', participants: ['Ada'] }),
    meeting({ id: 'b', title: 'Retro', summary: 'We shipped the meeting page.' }),
  ]

  it('keeps every meeting for a blank query', () => {
    expect(filterMeetings(rows, '   ').map(row => row.id)).toEqual(['a', 'b'])
  })

  it('matches the title, a participant, and the summary', () => {
    expect(filterMeetings(rows, 'weekly').map(row => row.id)).toEqual(['a'])
    expect(filterMeetings(rows, 'ADA').map(row => row.id)).toEqual(['a'])
    expect(filterMeetings(rows, 'shipped').map(row => row.id)).toEqual(['b'])
  })

  it('returns nothing when no meeting matches', () => {
    expect(filterMeetings(rows, 'quarterly')).toEqual([])
  })
})

describe('timestampText', () => {
  it('formats a durable timestamp in local time', () => {
    const local = new Date(2026, 8, 26, 10, 30).toISOString()
    expect(timestampText(local)).toBe('2026-09-26 10:30')
  })

  it('returns a value that is not a date unchanged', () => {
    expect(timestampText('not-a-date')).toBe('not-a-date')
  })
})

describe('durationText', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(durationText(65)).toBe('1:05')
    expect(durationText(3661)).toBe('1:01:01')
  })

  it('reports an absent or invalid duration as null', () => {
    expect(durationText(0)).toBeNull()
    expect(durationText(-4)).toBeNull()
    expect(durationText(Number.NaN)).toBeNull()
  })
})

describe('parseParticipants', () => {
  it('splits half- and full-width commas and drops blank names', () => {
    expect(parseParticipants(' Ada , Lin ，, ')).toEqual(['Ada', 'Lin'])
  })
})

describe('rowMeta', () => {
  it('names the status, transcript length, audio, and participants', () => {
    expect(rowMeta(meeting(), translate)).toEqual([
      '已转录', '6 字', '无音频', '未记录参与者',
    ])
  })

  it('reports a summarized meeting with audio and named participants', () => {
    expect(rowMeta(
      meeting({ status: 'summarized', audioSeconds: 125, participants: ['Ada', 'Lin'] }),
      translate,
    )).toEqual(['已摘要', '6 字', '时长 2:05', 'Ada, Lin'])
  })

  it('reports a meeting whose microphone is still open', () => {
    expect(rowMeta(meeting({ status: 'recording', transcriptChars: 0 }), translate)).toEqual([
      '录音中', '0 字', '无音频', '未记录参与者',
    ])
  })
})

describe('statusLabel', () => {
  it('names each durable status', () => {
    expect(statusLabel('recording', translate)).toBe('录音中')
    expect(statusLabel('transcribed', translate)).toBe('已转录')
    expect(statusLabel('summarized', translate)).toBe('已摘要')
  })
})

describe('transcriptLines', () => {
  it('returns the plain transcript when the record holds no spans', () => {
    expect(transcriptLines('Notes.', [], translate)).toBe('Notes.')
  })

  it('names the speaker of each span and leaves an unnamed span alone', () => {
    expect(transcriptLines('甲\n乙\n丙', [
      { text: '甲', speaker: '1' },
      { text: '乙' },
      { text: '丙', speaker: '2' },
    ], translate)).toBe('说话人 1：甲\n乙\n说话人 2：丙')
  })
})

describe('speechNotice', () => {
  it('reports a deployment with no provider at all', () => {
    expect(speechNotice({ providers: [], selected: '' }, translate)).toBe(zh.speechMissing)
  })

  it('names the selected provider that still needs preparation', () => {
    expect(speechNotice({
      providers: [{ id: 'p', name: 'SenseVoice', phase: 'unprepared', languages: ['auto'] }],
      selected: 'p',
    }, translate)).toBe('语音识别提供者“SenseVoice”尚未就绪（unprepared）：先准备语音模型，再开始录音。')
  })

  it('reports a failed preparation with the provider message', () => {
    expect(speechNotice({
      providers: [{
        id: 'p', name: 'SenseVoice', phase: 'failed', languages: ['auto'],
        preparation: { phase: 'failed', message: '磁盘已满' },
      }],
      selected: 'p',
    }, translate)).toBe('语音模型准备失败：SenseVoice：磁盘已满。可以重试准备。')
  })

  it('reports a download with its resource and progress', () => {
    expect(speechNotice({
      providers: [{
        id: 'p', name: 'SenseVoice', phase: 'downloading', languages: ['auto'],
        preparation: { phase: 'downloading', resource: 'int8 模型', completedBytes: 1500, totalBytes: 3000 },
      }],
      selected: 'p',
    }, translate)).toBe('正在为“SenseVoice”下载 int8 模型（1.5 KB / 3.0 KB）…')
  })

  it('reports nothing when the selected provider is ready', () => {
    expect(speechNotice({
      providers: [{ id: 'p', name: 'SenseVoice', phase: 'ready', languages: ['auto'] }],
      selected: 'p',
    }, translate)).toBeNull()
  })

  it('reports nothing for a prepared provider resting in standby', () => {
    expect(speechNotice({
      providers: [{ id: 'p', name: 'SenseVoice', phase: 'standby' }],
      selected: 'p',
    }, translate)).toBeNull()
  })

  it('falls back to the first provider when the selection is absent', () => {
    expect(speechNotice({
      providers: [{ id: 'p', name: 'SenseVoice', phase: 'loading', languages: ['auto'] }],
      selected: 'gone',
    }, translate)).toContain('SenseVoice')
  })
})

describe('bytesText', () => {
  it('formats byte counts up the unit ladder', () => {
    expect(bytesText(0)).toBe('0 B')
    expect(bytesText(999)).toBe('999 B')
    expect(bytesText(1500)).toBe('1.5 KB')
    expect(bytesText(1_048_576)).toBe('1.0 MB')
    expect(bytesText(Number.NaN)).toBe('0 B')
  })
})

describe('downloadProgress', () => {
  it('shows done over total when the total is known and done alone otherwise', () => {
    expect(downloadProgress(1500, 3000)).toBe('1.5 KB / 3.0 KB')
    expect(downloadProgress(1500, undefined)).toBe('1.5 KB')
  })
})

describe('compatibleLanguage', () => {
  it('keeps the current language, falls back to auto, then to the first hint', () => {
    const provider = (languages: string[]) => ({ id: 'p', name: 'P', phase: 'ready', languages })
    expect(compatibleLanguage(provider(['auto', 'zh']), 'zh')).toBe('zh')
    expect(compatibleLanguage(provider(['auto', 'en']), 'zh')).toBe('auto')
    expect(compatibleLanguage(provider(['zh', 'en']), 'auto')).toBe('zh')
    expect(compatibleLanguage(provider([], ''), '')).toBe('')
  })
})

describe('speechPhaseAction', () => {
  it('offers prepare while idle and cancel while preparation runs', () => {
    const provider = (phase: string) => ({ id: 'p', name: 'P', phase, languages: ['auto'] })
    expect(speechPhaseAction(provider('ready'))).toBeNull()
    expect(speechPhaseAction(provider('standby'))).toBeNull()
    expect(speechPhaseAction(provider('unprepared'))).toBe('prepare')
    expect(speechPhaseAction(provider('failed'))).toBe('prepare')
    expect(speechPhaseAction(provider('cancelled'))).toBe('prepare')
    expect(speechPhaseAction(provider('downloading'))).toBe('cancel')
    expect(speechPhaseAction(provider('checking'))).toBe('cancel')
    expect(speechPhaseAction(provider('loading'))).toBe('cancel')
    expect(speechPhaseAction(provider('waking'))).toBe('cancel')
    expect(speechPhaseAction(provider('cancelling'))).toBe('cancel')
  })
})

describe('selectedSpeechProvider', () => {
  it('prefers the selection, falls back to the first provider, and reports none', () => {
    const providers = [
      { id: 'p', name: 'P', phase: 'ready', languages: ['auto'] },
      { id: 'q', name: 'Q', phase: 'ready', languages: ['auto'] },
    ]
    expect(selectedSpeechProvider({ providers, selected: 'q' })?.id).toBe('q')
    expect(selectedSpeechProvider({ providers, selected: 'gone' })?.id).toBe('p')
    expect(selectedSpeechProvider({ providers: [], selected: '' })).toBeNull()
  })
})
