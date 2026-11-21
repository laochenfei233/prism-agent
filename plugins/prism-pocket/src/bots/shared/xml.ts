/**
 * The flat WeChat-family XML envelope: a reader for the platform's callback
 * bodies and a builder for the encrypted passive reply. The envelope is flat
 * (one tag per field, CDATA or plain text), so a scoped reader is exact here.
 *
 * @module @prism/prism-pocket/bots/shared
 */

/** Escape one value for a CDATA section. */
function cdata(value: string): string {
  return `<![CDATA[${value.replace(/\]\]>/gu, ']]&gt;')}]]>`
}

/**
 * Read one field from a flat XML envelope.
 * @param xml - the callback body.
 * @param tag - the element name.
 * @returns the field value, or undefined when absent.
 */
export function readXmlField(xml: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))</${tag}>`, 'u')
  const match = pattern.exec(xml)
  if (match === null) return undefined
  const value = match[1] ?? match[2] ?? ''
  return value.trim().length > 0 ? value : undefined
}

/**
 * Build the encrypted passive reply envelope.
 * @param encryptB64 - the base64 cipher of the reply message.
 * @param signature - the MsgSignature over (token, timestamp, nonce, cipher).
 * @param timestamp - seconds since epoch, as a string.
 * @param nonce - the random nonce.
 * @returns the XML body.
 */
export function buildEncryptedReply(encryptB64: string, signature: string, timestamp: string, nonce: string): string {
  return [
    '<xml>',
    `<Encrypt>${cdata(encryptB64)}</Encrypt>`,
    `<MsgSignature>${cdata(signature)}</MsgSignature>`,
    `<TimeStamp>${timestamp}</TimeStamp>`,
    `<Nonce>${cdata(nonce)}</Nonce>`,
    '</xml>',
  ].join('')
}

/** Build one plain-text callback message body (the XML the platform would have sent). */
export function buildTextMessage(from: string, to: string, content: string): string {
  return [
    '<xml>',
    `<ToUserName>${cdata(to)}</ToUserName>`,
    `<FromUserName>${cdata(from)}</FromUserName>`,
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>`,
    '<MsgType><![CDATA[text]]></MsgType>',
    `<Content>${cdata(content)}</Content>`,
    '</xml>',
  ].join('')
}
