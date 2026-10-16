/**
 * Artifact-plane smoke test for the built bundle.
 *
 * The Vitest suite drives `src/`, so this covers what only the emitted file can
 * show: that the harness packages stayed external, that nothing else is
 * imported, and that the Loader-facing export shape survived the build. A wrong
 * export name would otherwise fail only at profile boot.
 *
 * It deliberately does not execute the module: it imports the profile's harness
 * package, which a checkout without a profile install cannot resolve. Rail
 * registration is asserted by the Vitest suite, against `src/`.
 *
 * Usage: node scripts/smoke.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

// The harness stays external so the profile that loads this bundle resolves it,
// exactly as the sibling prism-memory plugin does: a bundled copy would shadow
// the profile's own service instances.
const imports = [...source.matchAll(/(?:^|\n)\s*import\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/gu)]
  .map(match => match[1])
assert.deepEqual(
  imports,
  ['@deepseek-ai/dsh-llm'],
  'the only runtime import must be the harness package the verification gate steers with',
)
assert.doesNotMatch(source, /\brequire\(/u, 'the bundle must not require anything at runtime')

// The Loader reads `name`, `inject`, and `apply`; a function plugin that also
// default-exported a service would have its namespace discarded.
assert.match(source, /export \{[^}]*\bapply\b[^}]*\}/u, 'the bundle must export the function plugin apply()')
assert.match(source, /export \{[^}]*\binject\b[^}]*\}/u, 'the bundle must export its injection list')
assert.match(source, /export \{[^}]*\bname\b[^}]*\}/u, 'the bundle must export its Cordis plugin name')
assert.doesNotMatch(source, /export default/u, 'a function plugin must not also default-export a service')
assert.match(source, /const name = "prism-guardrails"/u, 'the plugin name must match the patch row id')
assert.match(source, /const inject = \["tools"\]/u, 'the bundle must inject the tool registry it registers on')

console.log('smoke: ok — external harness import only, Loader-facing exports intact')
