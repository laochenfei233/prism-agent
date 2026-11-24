/**
 * The page's channel roster: nine cards in page order, of which the three
 * connector-backed ones carry no credential field and no callback.
 *
 * Spec: docs/compose/specs/pocket-connector-channels.md S2.1/S2.3.
 */
import { describe, expect, it } from 'vitest'
import { CHANNEL_META } from '../../src/client/channel-meta.ts'

describe('CHANNEL_META', () => {
  it('keeps the nine channels in page order', () => {
    expect(CHANNEL_META.map(meta => meta.id)).toEqual([
      'telegram', 'discord', 'slack', 'feishu', 'dingtalk', 'qq', 'wecom', 'wechat', 'whatsapp',
    ])
  })

  it('marks exactly the three upstream connector channels', () => {
    expect(CHANNEL_META.filter(meta => meta.connector === true).map(meta => meta.id))
      .toEqual(['feishu', 'dingtalk', 'wecom'])
  })

  it('leaves the connector cards without credentials or a callback', () => {
    for (const meta of CHANNEL_META.filter(entry => entry.connector === true)) {
      expect(meta.fields).toEqual([])
      expect(meta.callback).toBeUndefined()
      expect(meta.consoleUrl).toBeUndefined()
    }
  })
})
