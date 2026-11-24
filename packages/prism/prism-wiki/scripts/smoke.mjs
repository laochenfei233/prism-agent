/**
 * Artifact-plane smoke test for the built bundle.
 *
 * The Vitest suite drives `src/`, so this covers what only the emitted files can
 * show: that the class entry default-exports the service and nothing else, that
 * the three function entries have no default export, that the plugin names match
 * the ids the bundle patch inserts, that every harness seam stayed external (a
 * bundled copy would be a second instance of a Cordis service, which is a load
 * failure), and that the browser half carries the lazy module-loader envelope
 * the client module system expects.
 *
 * It deliberately does not execute the modules: they import the profile's seam
 * packages, which a checkout without a profile install cannot resolve. Behaviour
 * is the Vitest suite's job.
 *
 * Usage: node scripts/smoke.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const read = (relative) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

const index = read('lib/index.js')
const client = read('lib/client.js')
const functionEntries = ['lib/types/tools.js', 'lib/types/commands.js', 'lib/types/web.js']
const functionSources = functionEntries.map(entry => [entry, read(entry)])

// 1. The service entry is the single-form default export the Loader expects.
assert.match(index, /\bWikiVaultService as default\b/u, 'lib/index.js must default-export the service class')
assert.doesNotMatch(index, /export function apply/u, 'a class plugin must not also export apply()')
assert.doesNotMatch(index, /\bexport const name\b/u, 'a class plugin must not also export a plugin name')

// 2. The registrants are function plugins: named exports, no default.
for (const [entry, source] of functionSources) {
  assert.doesNotMatch(source, /export default/u, `${entry} must be a function plugin with no default export`)
  assert.match(source, /export (?:const|function) (?:name|apply|inject)/u, `${entry} must export its plugin declaration`)
}

// 3. The plugin names match the ids the bundle patch inserts.
const moduleText = [index, ...functionSources.map(([, source]) => source)].join('\n')
for (const name of ['prism-wiki-tools', 'prism-wiki-commands', 'prism-wiki-web']) {
  assert.match(moduleText, new RegExp(`name = ['"]${name}['"]`, 'u'), `the ${name} row name must match the patch`)
}

// 4. Every harness seam and schema library stayed an external import. A bundled
// copy would be a second instance of a Cordis service, a load failure.
const externals = new Set([...moduleText.matchAll(/from ['"]([^'"]+)['"]/gu)].map(match => match[1]))
for (const required of [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-tools',
  'zod',
]) {
  assert.ok(externals.has(required), `${required} must stay external in the emitted host bundle`)
}
assert.ok(
  ![...externals].some(specifier => specifier.startsWith('../src')),
  'no source path may leak into the artifact',
)

// 5. The browser half carries the lazy closure-factory envelope the client
// module system loads, and requests no workspace value beyond the baseline.
assert.match(client, /__ModuleLoader__\.load\(/u, 'lib/client.js must register through the module loader')
assert.match(client, /factory: \(require\) =>/u, 'lib/client.js must wrap its module in a factory')
assert.ok(
  ![...client.matchAll(/require\(['"](@deepseek-ai\/[^'"]+)['"]\)/gu)]
    .some(match => !/client-(?:store|ui-slots|ui-primitives|ui-dockkit)$/u.test(match[1])),
  'the browser half may only require baseline client externals',
)

// 6. The patch file inserts exactly the four rows the entries declare.
const patch = read('cordis.patch.yml')
for (const id of ['prism-wiki', 'tool-prism-wiki', 'command-prism-wiki', 'web-prism-wiki']) {
  assert.match(patch, new RegExp(`id: ${id}\\b`, 'u'), `cordis.patch.yml must insert the ${id} row`)
}
assert.match(patch, /name: '@prism\/prism-wiki'/u, 'the service row must name the package')
assert.doesNotMatch(patch, /(?<!!)!js\b/u, 'only !!js is legal under plugin config')

console.log('prism-wiki smoke: ok')
