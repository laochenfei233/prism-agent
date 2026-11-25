/** Pocket apply wiring: the anonymous ticket, the owner decision, and the collect. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../../src/index.ts'
import { generateVapidKeys } from '../../src/push/keys.ts'

// The plugin's only workspace value import; the checkout's source graph does
// not transform under this config, and bots are outside this spec's subject.
vi.mock('@deepseek-ai/dsh-llm', () => ({ createUserMessage: () => ({ role: 'user', content: [] }) }))

const SECRET = 's'.repeat(43)
const PHONE_URL = 'http://public.test:3080/'

interface Reply {
  status?: number
  body?: string
}

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
type FetchHandler = (request: Request) => Promise<Response>

/** Mount the plugin over fake carriers and drive both route registries. */
async function mount(): Promise<{
  callPage: (path: string, body?: string, headers?: Record<string, string>) => Promise<Reply>
  callApi: (path: string, init?: RequestInit) => Promise<{ status: number; body: unknown }>
  close: () => Promise<void>
}> {
  const home = await mkdtemp(join(tmpdir(), 'pocket-pairing-'))
  await mkdir(join(home, 'pocket'), { recursive: true })
  await writeFile(join(home, 'pocket', 'remote.json'), JSON.stringify({ version: 1, provider: 'tailscale' }))
  // Seeding the VAPID pair keeps activation read-only, so teardown cannot race a key write.
  await writeFile(join(home, 'pocket', 'keys.json'), JSON.stringify(await generateVapidKeys()))
  const pageRoutes = new Map<string, NodeHandler>()
  const apiRoutes = new Map<string, FetchHandler>()
  const ctx = new Context()
  ctx.provide('dshHomePath', () => home)
  ctx.provide('agents', {})
  ctx.provide('sessions', {})
  ctx.provide('sessionController', {})
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; fetch: FetchHandler }) => {
        apiRoutes.set(route.path, route.fetch)
        return () => { apiRoutes.delete(route.path) }
      },
    },
    isTrustedRequest: () => true,
  })
  ctx.provide('connection.tokenLogin', {
    authenticatedUrl: (base: string) => `${base}?token=launch`,
    mintOneTimeLoginUrl: (base: string) => `${base}?token=once`,
  })
  ctx.provide('webServer', {
    protocol: 'http:',
    host: '127.0.0.1',
    hosts: ['127.0.0.1'],
    register: (route: { path: string; handler: NodeHandler }) => {
      pageRoutes.set(route.path, route.handler)
      return () => { pageRoutes.delete(route.path) }
    },
    registerUpgrade: () => () => {},
  })
  ctx.provide('webStartup', {
    host: '127.0.0.1',
    port: 3080,
    publicUrl: PHONE_URL,
    trustedHosts: ['public.test'],
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()

  const callPage = async (path: string, body?: string, headers: Record<string, string> = {}): Promise<Reply> => {
    const handler = pageRoutes.get(path)
    if (handler === undefined) throw new Error(`no page route ${path}`)
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as IncomingMessage
    Object.assign(req, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json', ...headers },
      socket: { remoteAddress: '::ffff:192.168.1.7' },
    })
    const reply: Reply = {}
    const res = {
      writeHead(status: number) { reply.status = status },
      end(text?: string) { if (text !== undefined) reply.body = text },
    } as unknown as ServerResponse
    await handler(req, res)
    return reply
  }

  return {
    callPage,
    callApi: async (path, init) => {
      const handler = apiRoutes.get(path)
      if (handler === undefined) throw new Error(`no api route ${path}`)
      const response = await handler(new Request(`http://127.0.0.1:3080${path}`, init))
      return { status: response.status, body: await response.json() }
    },
    close: async () => {
      await fiber.dispose()
      // The VAPID key write starts lazily; retry while it lands.
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}

describe('pocket pairing flow', () => {
  it('pairs a phone through the owner decision and a single-use login URL', async () => {
    const pocket = await mount()
    try {
      const ticket = await pocket.callPage('/pocket-pair/request', JSON.stringify({ id: 'ticket-1', secret: SECRET }))
      expect(ticket.status).toBe(200)
      const { code } = JSON.parse(ticket.body ?? '{}') as { code: string }

      // The owner's status read shows the same code, the address, and the clean page.
      const status = await pocket.callApi('/api/pocket/remote')
      expect(status.body).toMatchObject({
        phone: { accessUrl: `${PHONE_URL}pocket-pair` },
        pairing: { requests: [{ id: 'ticket-1', code, sourceIp: '192.168.1.7' }] },
      })

      // The phone has nothing to enter yet, and the collect is its first poll.
      const allowed = await pocket.callApi('/api/pocket/pairing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'ticket-1', decision: 'allow' }),
      })
      expect(allowed.body).toEqual({ result: 'approved', requests: [] })

      const collected = await pocket.callPage('/pocket-pair/status', JSON.stringify({ id: 'ticket-1', secret: SECRET }))
      expect(JSON.parse(collected.body ?? '{}')).toEqual({ status: 'approved', url: `${PHONE_URL}?token=once` })

      // The decided request is gone from the owner's list.
      const after = await pocket.callApi('/api/pocket/remote')
      expect(after.body).toMatchObject({ pairing: { requests: [] } })
    } finally {
      await pocket.close()
    }
  })

  it('rejects a malformed decision and withdraws the routes with the plugin', async () => {
    const pocket = await mount()
    const invalid = await pocket.callApi('/api/pocket/pairing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ticket-1', decision: 'maybe' }),
    })
    expect(invalid.status).toBe(400)
    await pocket.callPage('/pocket-pair/request', JSON.stringify({ id: 'ticket-1', secret: SECRET }))
    await pocket.close()
    await expect(pocket.callPage('/pocket-pair/request', JSON.stringify({ id: 'ticket-1', secret: SECRET })))
      .rejects.toThrow(/no page route/u)
  })
})
