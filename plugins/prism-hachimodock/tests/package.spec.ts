/**
 * Package-level invariants: an out-of-tree patch bundle the Loader can mount,
 * the client module registration, and the activation surface wiring.
 *
 * Port of upstream `test/package.test.js` adapted to the prism bundle shape.
 */

import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as plugin from '../src/index.ts'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

describe('package', () => {
  it('package manifest is the expected prism patch bundle', () => {
    expect(manifest.name).toBe('@prism/prism-hachimodock')
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.type).toBe('module')
    expect(manifest.main).toBe('lib/index.js')
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.dsh.compatibility.contracts).toContain('live-session-seq-turn-call-v1')
  })

  it('the plugin entry exports a Cordis plugin shape', () => {
    expect(typeof plugin.apply).toBe('function')
    expect(typeof plugin.name).toBe('string')
    expect(plugin.name.length).toBeGreaterThan(0)
    expect([...plugin.inject].sort()).toEqual(['agents', 'sessionController', 'sessions'])
    expect(plugin.AGENT_ID).toBe('prism-agent')
  })

  it('the plugin loads through the ESM import() path the Loader uses', async () => {
    const namespace = await import(pathToFileURL(join(packageRoot, 'src/index.ts')).href)
    const unwrapped = namespace.default ?? namespace
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.name).toBe('hachimodock-prism-bridge')
    expect([...unwrapped.inject].sort()).toEqual(['agents', 'sessionController', 'sessions'])
  })

  it('the bundle patch mounts the plugin row with the web startup injection', () => {
    const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/insert:/)
    expect(patch).toMatch(/name: '@prism\/prism-hachimodock'/)
    expect(patch).toMatch(/id: hachimodock-bridge/)
    expect(patch).toMatch(/inject: \[webStartup\]/)
    // The prism default binds a free port; no fixed port is pinned here.
    expect(patch).not.toMatch(/port: 17892/)
  })

  it('runtime modules import only Node built-ins, relative files, and declared deps', () => {
    const declared = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})])
    const allow = (specifier: string): boolean =>
      specifier.startsWith('node:') || specifier.startsWith('.') || declared.has(specifier)
    for (const file of ['index.ts', 'server.ts', 'bridge.ts', 'capability.ts', 'windows-acl.ts', 'activation.ts', 'client/index.ts']) {
      const source = readFileSync(join(packageRoot, 'src', file), 'utf8')
      const matches = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1] ?? '')
      for (const specifier of matches) {
        expect(allow(specifier), `${file} must not import ${specifier}`).toBe(true)
      }
    }
  })

  it('test files import only Node built-ins, relative files, and vitest', () => {
    const testDir = join(packageRoot, 'tests')
    for (const file of readdirSync(testDir).filter(name => name.endsWith('.ts'))) {
      const source = readFileSync(join(testDir, file), 'utf8')
      const matches = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1] ?? '')
      for (const specifier of matches) {
        expect(
          specifier.startsWith('node:') || specifier.startsWith('.') || specifier === 'vitest',
          `${file} must not import ${specifier}`,
        ).toBe(true)
      }
    }
  })

  it('the vendored Windows ACL script matches the upstream authority bytes', () => {
    const script = readFileSync(join(packageRoot, 'windows-acl.ps1'), 'utf8')
    expect(script).toContain('[IO.Directory]::CreateDirectory($target, $newAcl)')
    expect(script).toContain('[IO.FileMode]::CreateNew')
    expect(script).toContain('[IO.FileOptions]::None, $newAcl)')
    expect(script).toContain("if ($old.owner -ne $current.Value) { throw 'owner' }")
    expect(script).toContain('GetCurrent().User')
    expect(script).toContain('Get-Acl -LiteralPath')
    expect(script).toContain('SetAccessRuleProtection($true, $false)')
    expect(script.includes('ReadAllText')).toBe(false)
    expect(script.includes('Get-Content')).toBe(false)
  })
})

describe('apply wiring', () => {
  it('apply registers the bridge effect and the same-origin activation route', () => {
    const effects: Array<{ label: string; run: () => unknown }> = []
    const registered: Array<{ path: string; methods: readonly string[] }> = []
    const connection = {
      fetch: {
        register(route: { path: string; methods: readonly string[]; requestBody: string; fetch: (r: Request) => Promise<Response> }) {
          registered.push({ path: route.path, methods: route.methods })
          return async () => {}
        },
      },
    }
    const listeners: Array<[string, unknown]> = []
    const ctx = {
      sessions: { get: () => undefined, list: () => [] },
      agents: {},
      sessionController: {},
      get: () => undefined,
      on: (name: string, listener: unknown) => {
        listeners.push([name, listener])
        return () => {}
      },
      effect: (run: () => unknown, label: string) => {
        effects.push({ label, run })
        // Run only the registration effects; starting the HTTP bridge would
        // bind a port and write the real capability descriptor.
        if (label !== 'hachimodock: http bridge') {
          try {
            void run()
          } catch {
            /* registration failures surface through the assertions below */
          }
        }
      },
      logger: { info() {}, warn() {}, error() {} },
    }
    Reflect.set(ctx, 'connection', connection)
    plugin.apply(ctx as never, { descriptorPath: 'unused' })
    const labels = effects.map(e => e.label)
    expect(labels).toContain('hachimodock: http bridge')
    expect(labels).toContain('hachimodock: activation stream')
    expect(registered[0]?.path).toBe('/api/hachimodock/activation')
    expect(registered[0]?.methods).toEqual(['GET'])
    const eventNames = listeners.map(([name]) => name)
    for (const name of ['session/event', 'session/created', 'session/disposed', 'agent/status', 'approval/request']) {
      expect(eventNames).toContain(name)
    }
    void vi
  })
})
