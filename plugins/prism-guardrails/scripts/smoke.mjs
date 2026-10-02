/**
 * Artifact-plane smoke test for the built bundle.
 *
 * The Vitest suite drives `src/`, so this covers the two facts only the emitted
 * file can show: that `lib/index.js` loads as a dependency-free ESM module, and
 * that `apply()` registers exactly the surfaces the four rails need. A wrong
 * export name would otherwise fail only at profile boot.
 *
 * Usage: node scripts/smoke.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const libUrl = new URL('../lib/index.js', import.meta.url)
const source = readFileSync(libUrl, 'utf8')

// Every harness import in src/ is `import type`, so the artifact must carry no
// import at all — that is what lets a deployment install nothing.
assert.doesNotMatch(source, /^\s*import[\s{'"]/mu, 'the bundle must not import anything at runtime')
assert.doesNotMatch(source, /\brequire\(/u, 'the bundle must not require anything at runtime')

const bundle = await import(libUrl.href)
assert.equal(bundle.name, 'prism-guardrails', 'the Cordis plugin name must match the patch row id')
assert.deepEqual(bundle.inject, ['tools'], 'the bundle must declare the tool registry it registers on')
assert.equal(typeof bundle.apply, 'function', 'the bundle must export a function plugin apply()')
assert.equal(bundle.default, undefined, 'a function plugin must not also default-export a service')

/** A recording stand-in for the four extension points the bundle registers on. */
function recordingContext() {
  const guards = []
  const listeners = []
  return {
    guards,
    listeners,
    ctx: {
      tools: { guard: (guard) => { guards.push(guard); return () => {} } },
      on: (event, listener) => { listeners.push([event, listener]); return () => {} },
      get: () => undefined,
      logger: { warn: () => {} },
    },
  }
}

const { guards, listeners, ctx } = recordingContext()
bundle.apply(ctx, {
  planDeniedTools: ['write'],
  repeatAskAfter: 2,
  maxStepsPerTurn: 3,
  skillInvocationGuidance: true,
})

assert.equal(guards.length, 1, 'the plan-mode rail must register exactly one monotonic guard')
assert.deepEqual(
  listeners.map(([event]) => event),
  ['tools/pre-execute', 'tools/post-execute', 'agent/pre-step', 'agent/pre-step', 'tools/pre-execute'],
  'the rails must register on the documented extension points, in this order',
)

// The guard reads the optional plan-mode service per call, so a deployment that
// mounts the service later is still covered.
const planDenial = guards[0]({ name: 'write', arguments: {}, agent: {} })
assert.equal(planDenial, undefined, 'a guard must not deny without a plan-mode service')
assert.equal(guards[0]({ name: 'read', arguments: {}, agent: {} }), undefined, 'an unnamed tool is never denied')

// A misconfiguration must fail the load, not disable a rail quietly.
assert.throws(() => bundle.apply(recordingContext().ctx, { maxStepsPerTurn: 0 }), /integer >= 1/u)
assert.throws(() => bundle.apply(recordingContext().ctx, { planDeniedTools: [] }), /must not be empty/u)
assert.throws(() => bundle.apply(recordingContext().ctx, { repeats: 2 }), /unknown config key/u)

// The skill rail is a pure text improvement, so it defaults on: an unconfigured
// bundle registers exactly that one listener and nothing else.
const defaults = recordingContext()
bundle.apply(defaults.ctx, {})
assert.equal(defaults.guards.length, 0, 'an unconfigured bundle must register no guard')
assert.deepEqual(
  defaults.listeners.map(([event]) => event),
  ['tools/pre-execute'],
  'only the default-on skill rail registers without configuration',
)

// Switching the last rail off leaves the bundle contributing nothing.
const off = recordingContext()
bundle.apply(off.ctx, { skillInvocationGuidance: false })
assert.equal(off.guards.length, 0, 'guidance-off must register no guard')
assert.deepEqual(off.listeners.map(([event]) => event), [], 'guidance-off must register no listener')

console.log('smoke: ok — dependency-free ESM artifact, four rails on the documented extension points, fail-loud config')
