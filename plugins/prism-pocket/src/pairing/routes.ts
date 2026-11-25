/**
 * Anonymous pairing routes. They register on the webserver, outside the
 * authenticated `/api` prefix, because the requesting phone has no session yet;
 * every handler applies the Host/Origin fence itself before reading a body.
 *
 * @module @prism/prism-pocket/pairing/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { PAIRING_PAGE_HTML } from './page.ts'
import type { PairingCredential, PairingRequests } from './requests.ts'

/** The page a phone opens after scanning the code. */
export const PAIRING_PAGE_PATH = '/pocket-pair'

/** Anonymous ticket creation. */
export const PAIRING_REQUEST_PATH = '/pocket-pair/request'

/** Anonymous status poll, which yields the login URL once approved. */
export const PAIRING_STATUS_PATH = '/pocket-pair/status'

/** Anonymous withdrawal before approval. */
export const PAIRING_CANCEL_PATH = '/pocket-pair/cancel'

/** Every anonymous request body is one small JSON object. */
const MAX_BODY_BYTES = 1024

/** Structural view of the webserver registration this module needs. */
export type PairingRouteRegister = (route: {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}) => void

/** Everything the anonymous handlers read from the plugin. */
export interface PairingRouteDeps {
  readonly requests: PairingRequests
  /** The Host/Origin fence, so a rebound page cannot forge requests. */
  readonly isTrusted: (request: { readonly headers: IncomingMessage['headers'] }) => boolean
  /** Mints the single-use login URL for one approved request. */
  readonly issueUrl: () => string | undefined
}

/**
 * Register the page and the three JSON routes.
 * @param register - webserver registration, already owned by a plugin effect.
 * @param deps - the ticket pool, the fence, and the login-URL minter.
 */
export function registerPairingRoutes(
  register: PairingRouteRegister,
  deps: PairingRouteDeps,
): void {
  register({
    kind: 'exact',
    path: PAIRING_PAGE_PATH,
    handler: (req, res) => pageHandler(req, res),
  })
  for (const [path, intent] of [
    [PAIRING_REQUEST_PATH, 'create'],
    [PAIRING_STATUS_PATH, 'poll'],
    [PAIRING_CANCEL_PATH, 'cancel'],
  ] as const) {
    register({
      kind: 'exact',
      path,
      handler: (req, res) => operationHandler(req, res, deps, intent),
    })
  }
}

/** Answer the page; any method but GET/HEAD would be a client error. */
function pageHandler(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(req.method === 'HEAD' ? undefined : PAIRING_PAGE_HTML)
}

/** Answer one anonymous JSON operation after the fence and the body checks. */
async function operationHandler(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PairingRouteDeps,
  intent: 'create' | 'poll' | 'cancel',
): Promise<void> {
  if (!deps.isTrusted({ headers: req.headers })) {
    send(res, 403, { status: 'unavailable' })
    return
  }
  if (req.method !== 'POST') {
    send(res, 405, { status: 'unavailable' }, { allow: 'POST' })
    return
  }
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    send(res, 400, { status: 'unavailable' })
    return
  }
  const body = await readBody(req)
  if (body === undefined) {
    send(res, 413, { status: 'unavailable' }, { connection: 'close' })
    req.destroy()
    return
  }
  const credential = readCredential(body)
  if (credential === undefined) {
    send(res, 400, { status: 'unavailable' })
    return
  }
  if (intent === 'create') {
    const ticket = deps.requests.create(sourceIpOf(req), credential)
    if (ticket === undefined) {
      send(res, 429, { status: 'unavailable' })
      return
    }
    send(res, 200, ticket)
    return
  }
  send(res, 200, deps.requests.poll(credential.id, credential.secret, intent === 'cancel', deps.issueUrl))
}

/** Read the body up to the cap; undefined when the request exceeds it. */
async function readBody(req: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += bytes.byteLength
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Parse the one accepted credential body; anything else is invalid. */
function readCredential(body: string): PairingCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { id, secret } = parsed as { id?: unknown; secret?: unknown }
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/u.test(id)) return undefined
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(secret)) return undefined
  return { id, secret }
}

/** The creating connection's address, normalized to the IPv4 spelling a reader recognizes. */
function sourceIpOf(req: IncomingMessage): string | null {
  const address = req.socket.remoteAddress
  if (address === undefined) return null
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
}

/** Write one JSON answer with the fixed anonymous-response headers. */
function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(JSON.stringify(body))
}
