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
 *
 * The scan is linear on purpose: callback bodies arrive unauthenticated before
 * the signature check, and the previous lazy-quantifier regex spent quadratic
 * time on a body full of unclosed openers, stalling the shared event loop.
 * The semantics are the old regex's: the first opener that has a closer after
 * it wins, the content runs to the first closer after that opener, and a
 * CDATA opener is only taken when `]]>` is immediately followed by the closer.
 * @param xml - the callback body.
 * @param tag - the element name.
 * @returns the field value, or undefined when absent.
 */
export function readXmlField(xml: string, tag: string): string | undefined {
  const opener = `<${tag}>`
  const closer = `</${tag}>`
  const openerStart = xml.indexOf(opener)
  if (openerStart === -1) return undefined
  const valueStart = openerStart + opener.length
  const cdataStart = valueStart + '<![CDATA['.length
  if (xml.startsWith('<![CDATA[', valueStart)) {
    const cdataEnd = xml.indexOf(']]>', cdataStart)
    if (cdataEnd !== -1 && xml.startsWith(closer, cdataEnd + ']]>'.length)) {
      const value = xml.slice(cdataStart, cdataEnd)
      return value.trim().length > 0 ? value : undefined
    }
  }
  const end = xml.indexOf(closer, valueStart)
  if (end === -1) return undefined
  const value = xml.slice(valueStart, end)
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
