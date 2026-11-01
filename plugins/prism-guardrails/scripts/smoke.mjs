/**
 * Artifact-plane smoke test for the built bundle.
 *
 * The Vitest suite drives `src/`, so this covers what only the emitted files can
 * show: that the harness packages stayed external, that every Loader-facing
 * entry kept its export shape, and that the two rows the bundle patch inserts
 * resolve to code the Loader can mount. A wrong export name would otherwise
 * fail only at profile boot.
 *
 * It deliberately does not execute the modules: they import the profile's
 * harness packages, which a checkout without a profile install cannot resolve.
 * Rail, mode, and command registration are asserted by the Vitest suite against
 * `src/`.
 *
 * Usage: node scripts/smoke.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')
const importsOf = source => [...source.matchAll(/(?:^|\n)\s*import\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/gu)]
  .map(match => match[1])

const entries = {
  host: { file: 'lib/index.js', name: 'prism-guardrails', inject: '["tools"]' },
  mode: { file: 'lib/ponytail.js', name: 'prism-guardrails-ponytail', inject: '["systemPrompt", "commands"]' },
}

for (const [label, entry] of Object.entries(entries)) {
  const source = read(entry.file)

  // The harness stays external so the profile that loads this bundle resolves
  // it, exactly as the sibling prism-memory plugin does: a bundled copy would
  // shadow the profile's own service instances. Relative imports are the
  // rolldown shared chunks this bundle emits for its own modules.
  for (const specifier of importsOf(source)) {
    assert.ok(
      specifier.startsWith('node:') || specifier.startsWith('@deepseek-ai/') || specifier.startsWith('./'),
      `${label} must import only Node builtins, external harness packages, and its own chunks, saw ${specifier}`,
    )
  }
  assert.doesNotMatch(source, /\brequire\(/u, `${label} must not require anything at runtime`)

  // The Loader reads `name`, `inject`, and `apply`; a function plugin that also
  // default-exported a service would have its namespace discarded.
  assert.match(source, /export \{[^}]*\bapply\b[^}]*\}/u, `${label} must export apply()`)
  assert.match(source, /export \{[^}]*\binject\b[^}]*\}/u, `${label} must export its injection list`)
  assert.match(source, /export \{[^}]*\bname\b[^}]*\}/u, `${label} must export its Cordis plugin name`)
  assert.doesNotMatch(source, /export default/u, `${label} must not default-export a service`)
  assert.match(source, new RegExp(`const name = "${entry.name}"`, 'u'), `${label} name must match its patch row id`)
  assert.ok(source.includes(`const inject = ${entry.inject}`), `${label} must inject the services it registers on`)
}

assert.match(read('cordis.patch.yml'), /id: prism-guardrails-ponytail/u, 'the patch must insert the mode row')
assert.match(read('cordis.patch.yml'), /name: 'prism-guardrails\/ponytail'/u, 'the mode row must resolve the ./ponytail export')

console.log('smoke: ok — two entries, external harness imports only, patch rows resolve')
