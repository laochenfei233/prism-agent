/**
 * The bots list/action route: no secret value — including the callback-signing
 * tokens — ever appears in a list response, and the pairing code rotates
 * through the channel-less action.
 *
 * @module @prism/prism-pocket/tests/bots
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BotStore } from '../../src/bots/store.ts'
import { BotSupervisor } from '../../src/bots/supervisor.ts'
import { listView, readBotAction, runBotAction, type BotRouteDeps } from '../../src/bots/routes.ts'
import { readBotConfig } from '../../src/bots/validate.ts'

const DIRECTORIES: string[] = []

afterEach(() => {
  for (const directory of DIRECTORIES.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** Route dependencies over a real temp store; no channel ever starts. */
function routeDeps(): BotRouteDeps {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-routes-'))
  DIRECTORIES.push(directory)
  const store = new BotStore(join(directory, 'bots.json'))
  const supervisor = new BotSupervisor({ onInbound: () => undefined, onStatus: () => undefined })
  return { store, supervisor, deliverInbound: async () => undefined, warn: () => undefined }
}

/** Read the pairing code out of an action response without trusting it. */
function pairingCodeOf(value: unknown): string {
  const code = typeof value === 'object' && value !== null ? (value as { pairingCode?: unknown }).pairingCode : undefined
  return typeof code === 'string' ? code : ''
}

describe('listView', () => {
  it('masks every secret, including the callback-signing tokens', () => {
    const deps = routeDeps()
    deps.store.setConfig(readBotConfig('wechat', {
      appId: 'plain-app-id', appSecret: 'wechat-app-secret', token: 'wechat-callback-token', encodingAesKey: 'k'.repeat(43),
    }))
    const view = listView(deps).bots.find(bot => bot.channel === 'wechat')
    expect(view?.values).toEqual({ appId: 'plain-app-id' })
    expect(view?.fields).toEqual([
      { name: 'appId', set: true },
      { name: 'appSecret', set: true },
      { name: 'token', set: true },
      { name: 'encodingAesKey', set: true },
    ])
    const body = JSON.stringify(listView(deps))
    expect(body).not.toContain('wechat-callback-token')
    expect(body).not.toContain('wechat-app-secret')
    expect(body).toContain('plain-app-id')
  })

  it('masks the wecom token and the whatsapp verify token too', () => {
    const deps = routeDeps()
    deps.store.setConfig(readBotConfig('wecom', {
      corpId: 'corp', agentId: '1', corpSecret: 'wecom-corp-secret', token: 'wecom-callback-token', encodingAesKey: 'k'.repeat(43),
    }))
    deps.store.setConfig(readBotConfig('whatsapp', {
      accessToken: 'whatsapp-access-token', phoneNumberId: '1', verifyToken: 'whatsapp-verify-token', appSecret: 'whatsapp-app-secret',
    }))
    const body = JSON.stringify(listView(deps))
    for (const secret of ['wecom-callback-token', 'wecom-corp-secret', 'whatsapp-access-token', 'whatsapp-verify-token', 'whatsapp-app-secret']) {
      expect(body).not.toContain(secret)
    }
    expect(listView(deps).bots.find(bot => bot.channel === 'wecom')?.values).toEqual({ corpId: 'corp', agentId: '1' })
    expect(listView(deps).bots.find(bot => bot.channel === 'whatsapp')?.values).toEqual({ phoneNumberId: '1' })
  })

  it('exposes the active pairing code for the page to display', () => {
    const deps = routeDeps()
    const code = listView(deps).pairingCode
    expect(code).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/u)
    expect(deps.store.pairingCode()).toBe(code)
  })
})

describe('rotatePairing action', () => {
  it('is channel-less and rotates the code the list route exposes', async () => {
    const deps = routeDeps()
    const before = listView(deps).pairingCode
    const response = await runBotAction(readBotAction({ action: 'rotatePairing' }), deps)
    const next = pairingCodeOf(response)
    expect(next).not.toBe(before)
    expect(deps.store.pairingCode()).toBe(next)
  })

  it('still rejects unknown channels, unknown actions, and non-object bodies', () => {
    expect(() => readBotAction({ channel: 'nope', action: 'start' })).toThrow(/unknown channel/)
    expect(() => readBotAction({ channel: 'telegram', action: 'boom' })).toThrow(/unknown action/)
    expect(() => readBotAction('x')).toThrow(/JSON body/)
  })
})
