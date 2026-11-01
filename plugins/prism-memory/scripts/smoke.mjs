/**
 * Artifact-plane smoke test for the built bundle.
 *
 * The Vitest suite drives `src/`, so this covers what only the emitted files
 * can show: that the three entries exist, that the service entry default-exports
 * the class and nothing else, that every harness seam stayed external (a bundled
 * copy would shadow the profile's own service instances), and that the plugin
 * names the patch rows resolve match the emitted declarations.
 *
 * It deliberately does not execute the modules: they import the profile's seam
 * packages, which a checkout without a profile install cannot resolve. Behavior
 * is the Vitest suite's job.
 *
 * Usage: node scripts/smoke.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

const entries = ['lib/index.js', 'lib/tools.js', 'lib/commands.js', 'lib/web.js']
const sources = entries.map((entry) => [entry, read(entry)])

// Every module of the build, including the shared chunk rolldown emits.
const chunkNames = [...new Set(sources.flatMap(([, source]) => (
  [...source.matchAll(/from "\.\/([^"]+)"/gu)].map(match => match[1])
)))]
const moduleText = [...sources.map(([, source]) => source), ...chunkNames.map(name => read(`lib/${name}`))].join('\n')

// 1. The service entry is the single-form default export the Loader expects.
const index = sources[0][1]
assert.match(index, /\bPrismMemoryService as default\b/u, 'lib/index.js must default-export the service class')
assert.doesNotMatch(index, /export function apply/u, 'a class plugin must not also export apply()')
assert.doesNotMatch(index, /\bexport const name\b/u, 'a class plugin must not also export a plugin name')

// 2. The three registrants are function plugins: named exports, no default.
for (const entry of ['lib/tools.js', 'lib/commands.js', 'lib/web.js']) {
  const source = sources.find(([name]) => name === entry)[1]
  assert.doesNotMatch(source, /export default/u, `${entry} must be a function plugin with no default export`)
}

// 3. The plugin names match the ids the bundle patch inserts.
assert.match(moduleText, /name = "prism-memory-tools"/u, 'the tools row name must match the patch')
assert.match(moduleText, /name = "prism-memory-commands"/u, 'the commands row name must match the patch')
assert.match(moduleText, /name = "prism-memory-web"/u, 'the web row name must match the patch')

// 4. Every harness seam and schema library stayed an external import. A bundled
// copy would be a second instance of a Cordis service, which is a load failure.
const externals = new Set(
  [...moduleText.matchAll(/from "([^"]+)"/gu)].map(match => match[1]),
)
for (const required of [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-storage-domain',
  'zod',
]) {
  assert.ok(externals.has(required), `${required} must stay external in the emitted modules`)
}
// The tool, session, agent, and command seams are imported only where they are
// used; assert they were never inlined as a relative path.
assert.ok(
  ![...externals].some(specifier => specifier.includes('dsh-tools/src')),
  'no seam may be inlined by path',
)
assert.ok(![...externals].some(specifier => specifier.startsWith('../src')), 'no source path may leak into the artifact')

// 5. The two patch files exist and insert the four rows.
const patch = read('cordis.patch.yml')
for (const id of ['prism-memory', 'tool-prism-memory', 'command-prism-memory', 'prism-memory-web']) {
  assert.match(patch, new RegExp(`id: ${id}\\b`, 'u'), `cordis.patch.yml must insert the ${id} row`)
}
assert.match(patch, /exportDir: !!js dshHomePath\('prism-memory'\)/u, 'the export directory must be deployment-owned')

// The session layer reconfigures one shipped row and inserts nothing: a row
// naming a package this bundle does not depend on fails to import on every boot
// of a Harness that does not ship it.
const sessionLayer = read('session-search.patch.yml')
assert.match(sessionLayer, /id: session-query-sqlite/u, 'the session layer must reconfigure the shipped index row')
assert.match(sessionLayer, /openAt: first-search/u, 'the session layer must defer the sqlite import')
assert.doesNotMatch(sessionLayer, /^\s*- insert:/mu, 'the session layer must not insert a row of its own')

// 6. The browser half is one module-loader closure under the package name, and
// its baseline modules stayed requests. An inlined React would be a second copy
// of the shell's own runtime inside this bundle.
const client = read('lib/client.js')
assert.match(client, /^window\.__ModuleLoader__\.load\(\{/u, 'lib/client.js must register itself with the module loader')
assert.match(client, /id: "@prism\/prism-memory"/u, 'the browser half must register under the name the registry resolves')
for (const required of ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']) {
  assert.ok(client.includes(`require("${required}")`), `${required} must stay a baseline request in lib/client.js`)
}
assert.doesNotMatch(client, /from "\.\/src/u, 'no source path may leak into the browser bundle')

// 7. The browser half actually loads and registers. The module-loader closure is
// executed against a stand-in table and a stand-in context, so a bundle that
// requests a module the shell does not seed, or registers into a slot the shell
// never declares, fails here instead of in a browser.
const factories = new Map()
globalThis.window = { __ModuleLoader__: { load: entry => factories.set(entry.id, entry.factory) } }
await import(new URL('../lib/client.js', import.meta.url).href)
const factory = factories.get('@prism/prism-memory')
assert.equal(typeof factory, 'function', 'the browser half must register one factory under the package name')
const baseline = { react: {}, 'react/jsx-runtime': {}, '@deepseek-ai/dsh-client-ui-primitives': {} }
const browser = factory((specifier) => {
  if (!(specifier in baseline)) throw new Error(`the browser half requested an unseeded module: ${specifier}`)
  return baseline[specifier]
})
assert.equal(typeof browser.apply, 'function', 'the browser half must export apply()')
assert.deepEqual(browser.inject, ['slots', 'locale'], 'the browser half declares its two services')
const injected = []
const registered = []
const dictionaries = new Map()
browser.apply({
  effect: (callback) => { callback() },
  locale: {
    register: (namespace, entries) => {
      dictionaries.set(namespace, entries)
      return () => {}
    },
    bind: () => key => key,
  },
  slots: {
    inject: (name, callback) => {
      injected.push(name)
      callback()
    },
    register: (options) => {
      registered.push(options.name)
      return () => {}
    },
  },
})
assert.deepEqual(injected, ['sidebar.panellist', 'main'], 'the browser half waits on both slot declarations')
assert.deepEqual(registered, ['sidebar.panellist', 'main'], 'the browser half registers both contributions')
assert.equal(browser.PANEL_ID, 'memory', 'the panel id is the one the sidebar selects')
const [namespace, dicts] = [...dictionaries.entries()][0]
assert.equal(namespace, 'prismMemory.panel', 'the page owns one locale namespace')
assert.deepEqual(
  Object.keys(dicts.zh).sort(),
  Object.keys(dicts.en).sort(),
  'both dictionaries must define the same keys',
)

console.log(`smoke: ok — ${entries.length} entries, ${externals.size} external specifiers, four rows, no unshipped insert`)
