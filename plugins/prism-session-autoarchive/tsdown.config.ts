/**
 * Standalone build for the out-of-tree plugin: the Node half the Loader
 * imports, plus the browser half served at `/plugins/<pkg>/client.js`.
 *
 * The Node half keeps the harness packages external, resolved from the profile
 * that loads this bundle exactly as the sibling `plugins/prism-guardrails`
 * does, so a deployment installs nothing of its own alongside it.
 *
 * The browser half reproduces the shell's dynamic-bundle contract by hand
 * because `packages/client/tsdown.client.ts` is a workspace preset: one CJS
 * closure registered through `window.__ModuleLoader__.load`, with every
 * baseline module resolved through the injected `require` instead of being
 * inlined into a second copy.
 * @module prism-session-autoarchive/build
 */
import { defineConfig } from 'tsdown'

/** Package name; also the module-table row id the browser half registers under. */
const ID = 'prism-session-autoarchive'

/** Shell-seeded specifiers the browser half must not inline. */
const BASELINE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

export default defineConfig([
  {
    name: ID,
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: true,
    fixedExtension: false,
    deps: { neverBundle: [/^@deepseek-ai\//u] },
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    fixedExtension: false,
    deps: { neverBundle: BASELINE },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
