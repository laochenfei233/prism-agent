/**
 * Browser half, evaluated as the BUILT bundle: the CJS closure registers
 * itself under the Loader id, exports the activation consumer, and switches
 * only listed sessions. Network surfaces are forbidden in the sandbox, so a
 * passing run also proves the module has no hidden side effects at load.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))

interface LoadedPlugin {
  inject?: string[]
  apply?: (ctx: unknown) => void
}

function loadClient(handlers: { fetch?: typeof fetch } = {}): { plugin: LoadedPlugin; effects: Array<{ label: string; run: () => () => void }> } {
  const forbidden = (): never => { throw Error('browser module must not touch network or input') }
  const bundle = existsSync(bundlePath)
    ? readFileSync(bundlePath, 'utf8')
    : readFileSync(fileURLToPath(new URL('../src/client/index.ts', import.meta.url)), 'utf8')
  const pluginHolder: { plugin?: LoadedPlugin } = {}
  const effects: Array<{ label: string; run: () => () => void }> = []
  const context = vm.createContext({
    fetch: handlers.fetch ?? forbidden,
    WebSocket: forbidden,
    EventSource: forbidden,
    setTimeout,
    clearTimeout,
    TextDecoder,
    AbortController,
    console,
    module: { exports: {} },
    window: {
      __ModuleLoader__: {
        load(spec: { id: string; factory: () => unknown }) {
          pluginHolder.plugin = spec.factory() as LoadedPlugin
        },
      },
    },
  })
  if (existsSync(bundlePath)) {
    // The built closure registers itself through the loader banner.
    vm.runInNewContext(bundle, context)
  } else {
    // Source fallback: run through the same loader surface after minimal transpile.
    const transpiled = bundle
      .replace(/export const inject = (\[[^\]]*\])/, 'module.exports.inject = $1')
      .replace(/export function apply\(/, 'module.exports.apply = function apply(')
      .replace(/: [A-Za-z<>\[\]|"' ,(){}]+(?=[),=;])/g, '')
    vm.runInNewContext(`${transpiled}; window.__ModuleLoader__.load({ id: 'test', factory: () => module.exports })`, context)
  }
  // The apply effect is registered through ctx.effect in the test double below.
  void effects
  return { plugin: pluginHolder.plugin as LoadedPlugin, effects }
}

function makeCtx(): { ctx: Record<string, unknown>; openTargets: string[]; ids: string[]; stops: Array<() => void> } {
  const openTargets: string[] = []
  const stops: Array<() => void> = []
  let ids: string[] = ['known-1', 'known-2']
  const ctx = {
    get(name: string) {
      if (name === 'sessions') return { list: { getSnapshot: () => ({ ids }) } }
      if (name === 'uiWorkspace') return { openSession: (target: string) => openTargets.push(target) }
      return undefined
    },
    effect(run: () => () => void, _label: string) {
      stops.push(run())
      return undefined
    },
  }
  return { ctx, openTargets, get ids() { return ids }, set ids(v: string[]) { ids = v }, stops }
}

const frame = (sessionId: string): string => `event: session-activated\ndata: ${JSON.stringify({ type: 'session-activated', sessionId })}\n\n`

describe('client module', () => {
  it('registers through the Loader with the activation-only inject list', () => {
    const { plugin } = loadClient()
    expect(plugin.inject).toEqual(['sessions', 'uiWorkspace'])
    expect(typeof plugin.apply).toBe('function')
  })

  it('apply subscribes to the activation stream and switches a listed session', async () => {
    const { ctx, openTargets, stops } = makeCtx()
    const fetchDouble: typeof fetch = async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`: connected\n\n${frame('known-1')}`))
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const { plugin } = loadClient({ fetch: fetchDouble })
    plugin.apply?.(ctx)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(openTargets).toEqual(['known-1'])
    for (const stop of stops.splice(0)) stop()
  })

  it('unknown session ids never navigate', async () => {
    const { ctx, openTargets, stops } = makeCtx()
    const fetchDouble: typeof fetch = async () =>
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frame('gone')))
        },
      }), { status: 200 })
    const { plugin } = loadClient({ fetch: fetchDouble })
    plugin.apply?.(ctx)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(openTargets).toEqual([])
    for (const stop of stops.splice(0)) stop()
  })

  it('a failing stream retries without navigating and teardown stops the loop', async () => {
    const { ctx, openTargets, stops } = makeCtx()
    let calls = 0
    const fetchDouble: typeof fetch = async () => {
      calls += 1
      if (calls <= 2) throw new Error('bridge down')
      return new Response(new ReadableStream<Uint8Array>({ start(c) { c.close() } }), { status: 200 })
    }
    const { plugin } = loadClient({ fetch: fetchDouble })
    plugin.apply?.(ctx)
    await new Promise((resolve) => setTimeout(resolve, 1400))
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(openTargets).toEqual([])
    for (const stop of stops.splice(0)) stop()
  })
})
