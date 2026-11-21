/**
 * The phone-link QR, generated locally by `qrcode-generator` (inlined into
 * the client bundle). The encoded URL carries the login token by design —
 * the scan is the login — so it is never logged or sent anywhere.
 *
 * @module @prism/prism-pocket/client/qr
 */

import qrcode from 'qrcode-generator'

/**
 * Render one URL as a scalable QR SVG.
 * @param url - the URL to encode.
 * @returns the SVG markup; the caller owns insertion.
 */
export function phoneQrSvg(url: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(url)
  qr.make()
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
}
