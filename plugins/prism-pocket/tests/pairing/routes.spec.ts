/** Anonymous pairing routes: fence, body limits, and the ticket wire shapes. */
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { PairingRequests } from '../../src/pairing/requests.ts'
import {
  PAIRING_CANCEL_PATH,
  PAIRING_PAGE_PATH,
  PAIRING_REQUEST_PATH,
  PAIRING_STATUS_PATH,
  registerPairingRoutes,
} from '../../src/pairing/routes.ts'

const SECRET = 's'.repeat(43)
const LOGIN_URL = 'http://127.0.0.1:3080/?token=once'

interface Reply {
  status?: number
  headers?: Record<string, unknown> | undefined
  body?: string
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

/** Register the routes into a map and answer one call through them. */
function harness(options: { trusted?: boolean; issueUrl?: string | null } = {}): {
  requests: PairingRequests
  call: (path: string, init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    remoteAddress?: string | null
    destroyable?: boolean
  }) => Promise<Reply>
} {
  const routes = new Map<string, Handler>()
  const requests = new PairingRequests()
  registerPairingRoutes(route => { routes.set(route.path, route.handler) }, {
    requests,
    isTrusted: () => options.trusted ?? true,
    issueUrl: () => options.issueUrl === null ? undefined : (options.issueUrl ?? LOGIN_URL),
  })
  return {
    requests,
    call: async (path, init = {}) => {
      const handler = routes.get(path)
      if (handler === undefined) throw new Error(`no route ${path}`)
      const req = Readable.from(init.body === undefined ? [] : [Buffer.from(init.body)]) as IncomingMessage
      Object.assign(req, {
        method: init.method ?? 'POST',
        headers: init.headers ?? { 'content-type': 'application/json' },
        socket: {
          remoteAddress: init.remoteAddress === null
            ? undefined
            : (init.remoteAddress ?? '::ffff:192.168.1.7'),
        },
      })
      const state: Reply = {}
      const res = {
        writeHead(status: number, headers?: Record<string, unknown>) {
          state.status = status
          state.headers = headers
        },
        end(body?: string) {
          if (body !== undefined) state.body = body
        },
      } as unknown as ServerResponse
      await handler(req, res)
      return state
    },
  }
}

describe('pairing routes', () => {
  it('serves the access page without a session', async () => {
    const { call } = harness()
    const reply = await call(PAIRING_PAGE_PATH, { method: 'GET', headers: {} })
    expect(reply.status).toBe(200)
    expect(reply.headers?.['content-type']).toBe('text/html; charset=utf-8')
    expect(reply.headers?.['cache-control']).toBe('no-store')
    expect(reply.body).toContain('<!doctype html>')
    expect(await call(PAIRING_PAGE_PATH, { method: 'POST' })).toMatchObject({ status: 405 })
  })

  it('applies the fence before reading anything', async () => {
    const { call } = harness({ trusted: false })
    for (const path of [PAIRING_REQUEST_PATH, PAIRING_STATUS_PATH, PAIRING_CANCEL_PATH]) {
      const reply = await call(path, { body: JSON.stringify({ id: 'ticket-1', secret: SECRET }) })
      expect(reply).toMatchObject({ status: 403, body: '{"status":"unavailable"}' })
    }
  })

  it('refuses methods, media types, malformed bodies, and oversized bodies', async () => {
    const { call, requests } = harness()
    expect(await call(PAIRING_REQUEST_PATH, { method: 'GET' })).toMatchObject({ status: 405 })

    const wrongType = await call(PAIRING_REQUEST_PATH, { headers: { 'content-type': 'text/plain' } })
    expect(wrongType).toMatchObject({ status: 400 })

    expect(await call(PAIRING_REQUEST_PATH, { body: 'not json' })).toMatchObject({ status: 400 })
    expect(await call(PAIRING_REQUEST_PATH, { body: JSON.stringify({ id: 'ticket-1', secret: 'short' }) }))
      .toMatchObject({ status: 400 })
    expect(await call(PAIRING_REQUEST_PATH, { body: JSON.stringify({ id: 'ticket-1' }) }))
      .toMatchObject({ status: 400 })

    const oversized = await call(PAIRING_REQUEST_PATH, { body: 'x'.repeat(2048) })
    expect(oversized.status).toBe(413)
    expect(requests.list()).toEqual([])
  })

  it('issues a ticket, records the normalized source address, and rate-limits creation', async () => {
    const { call, requests } = harness()
    const reply = await call(PAIRING_REQUEST_PATH, {
      body: JSON.stringify({ id: 'ticket-1', secret: SECRET }),
    })
    expect(reply.status).toBe(200)
    const ticket = JSON.parse(reply.body ?? '{}') as { code?: string; expiresInMs?: number }
    expect(ticket.code).toMatch(/^[2-9A-HJ-NP-Z]{8}$/u)
    expect(ticket.expiresInMs).toBe(300_000)
    expect(requests.list()[0]?.sourceIp).toBe('192.168.1.7')

    expect(await call(PAIRING_REQUEST_PATH, { body: JSON.stringify({ id: 'ticket-2', secret: SECRET }) }))
      .toMatchObject({ status: 429 })
  })

  it('answers pending, approved, and cancelled states', async () => {
    vi.useFakeTimers()
    const { call, requests } = harness()
    const body = JSON.stringify({ id: 'ticket-1', secret: SECRET })
    await call(PAIRING_REQUEST_PATH, { body })

    expect(JSON.parse((await call(PAIRING_STATUS_PATH, { body })).body ?? '{}')).toEqual({ status: 'pending' })

    requests.decide('ticket-1', 'allow')
    vi.advanceTimersByTime(2_000)
    expect(JSON.parse((await call(PAIRING_STATUS_PATH, { body })).body ?? '{}'))
      .toEqual({ status: 'approved', url: LOGIN_URL })

    vi.advanceTimersByTime(1_000)
    await call(PAIRING_REQUEST_PATH, { body: JSON.stringify({ id: 'ticket-2', secret: SECRET }), remoteAddress: null })
    // A connection without a reported address renders as no source.
    expect(requests.list()[0]?.sourceIp).toBeNull()

    const cancelled = await call(PAIRING_CANCEL_PATH, { body: JSON.stringify({ id: 'ticket-2', secret: SECRET }) })
    expect(JSON.parse(cancelled.body ?? '{}')).toEqual({ status: 'cancelled' })
    vi.useRealTimers()
  })

  it('reports the collect as unavailable when the login URL cannot be minted', async () => {
    const { call, requests } = harness({ issueUrl: null })
    await call(PAIRING_REQUEST_PATH, { body: JSON.stringify({ id: 'ticket-1', secret: SECRET }) })
    requests.decide('ticket-1', 'allow')
    expect(JSON.parse((await call(PAIRING_STATUS_PATH, { body: JSON.stringify({ id: 'ticket-1', secret: SECRET }) })).body ?? '{}'))
      .toEqual({ status: 'unavailable' })
  })
})
