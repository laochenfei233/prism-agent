/**
 * WeCom (企业微信) adapter: receive rides the encrypted callback route
 * (the receive id is the corp id), replies go through the app-message send
 * API. The signature check, envelope decrypt, and verification echo are pure
 * and tested; the adapter carries the access-token cache.
 *
 * @module @prism/prism-pocket/bots/adapters
 */

import type { BotAdapterFactory, WecomConfig } from '../types.ts'
import { chunkText } from '../shared/chunk.ts'
import { fetchBotJson, postBotJson } from '../shared/http.ts'
import { callbackSignature, decryptWechatMessage } from '../shared/sign.ts'
import { readXmlField } from '../shared/xml.ts'

/** Per-message character limit of the app text message. */
export const WECOM_MESSAGE_LIMIT = 2000

/** Base URL of the WeCom API. */
export const WECOM_API_BASE = 'https://qyapi.weixin.qq.com'

/**
 * Verify one callback request's signature (same scheme as the Official
 * Account).
 * @param token - the console-configured callback token.
 * @param msgSignature - the request's `msg_signature` query parameter.
 * @param timestamp - the request's `timestamp` query parameter.
 * @param nonce - the request's `nonce` query parameter.
 * @param encrypt - the encrypted body the signature covers.
 * @returns whether the signature matches.
 */
export function verifyWecomCallback(token: string, msgSignature: string, timestamp: string, nonce: string, encrypt: string): boolean {
  return callbackSignature(token, timestamp, nonce, encrypt) === msgSignature
}

/**
 * Build the encrypted URL-verification echo the platform expects.
 * @param config - the channel credentials.
 * @param echoStr - the request's `echostr` query parameter (base64 cipher).
 * @returns the decrypted echo string, or undefined when verification fails.
 */
export function resolveWecomVerifyEcho(config: WecomConfig, echoStr: string): string | undefined {
  return decryptWechatMessage(config.encodingAesKey, echoStr, config.corpId)
}

/** One decrypted callback message, narrowed to the fields the adapter reads. */
export interface WecomCallbackMessage {
  readonly from: string
  readonly content: string
}

/**
 * Decrypt and narrow one callback body.
 * @param config - the channel credentials.
 * @param encrypt - the `Encrypt` field of the callback body.
 * @returns the message view, or undefined when verification fails.
 */
export function readWecomCallback(config: WecomConfig, encrypt: string): WecomCallbackMessage | undefined {
  const plaintext = decryptWechatMessage(config.encodingAesKey, encrypt, config.corpId)
  if (plaintext === undefined) return undefined
  const from = readXmlField(plaintext, 'FromUserName')
  const msgType = readXmlField(plaintext, 'MsgType')
  const content = readXmlField(plaintext, 'Content')
  if (from === undefined || msgType === undefined || content === undefined) return undefined
  if (msgType !== 'text' || content.trim().length === 0) return undefined
  return { from, content: content.trim() }
}

/** The adapter: access-token cache plus the app-message send. */
export const createWecomAdapter: BotAdapterFactory = (config, hooks) => {
  const fields = config as WecomConfig
  let accessToken: { token: string; expiresAt: number } | undefined

  const token = async (): Promise<string> => {
    if (accessToken !== undefined && Date.now() < accessToken.expiresAt) return accessToken.token
    const url = `${WECOM_API_BASE}/cgi-bin/gettoken?corpid=${encodeURIComponent(fields.corpId)}&corpsecret=${encodeURIComponent(fields.corpSecret)}`
    const body = await fetchBotJson(url)
    const value = (body as { access_token?: unknown }).access_token
    if (typeof value !== 'string') throw new Error(`gettoken failed: ${JSON.stringify(body)}`)
    const expires = (body as { expires_in?: unknown }).expires_in
    accessToken = { token: value, expiresAt: Date.now() + (typeof expires === 'number' ? expires - 60 : 7200) * 1000 }
    return value
  }

  return {
    async start() {
      hooks.onStatus('starting')
      await token()
      hooks.onStatus('online')
    },
    async stop() {
      accessToken = undefined
    },
    async send(chatId, text) {
      const credential = await token()
      for (const piece of chunkText(text, WECOM_MESSAGE_LIMIT)) {
        await postBotJson(`${WECOM_API_BASE}/cgi-bin/message/send?access_token=${encodeURIComponent(credential)}`, {
          touser: chatId,
          msgtype: 'text',
          agentid: Number.parseInt(fields.agentId, 10),
          text: { content: piece },
        })
      }
    },
    async probe() {
      await token()
    },
  }
}
