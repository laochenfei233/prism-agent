/**
 * Build for the out-of-tree plugin the Loader imports.
 *
 * Two builds. The Node half carries the rows the bundle patch inserts: the
 * durable service (default-exported class), the model-facing tools, the operator
 * command, and the browser routes. The browser half reproduces the shell's
 * dynamic-bundle contract by hand, because `packages/client/tsdown.client.ts` is
 * a workspace preset: one CJS closure registered through
 * `window.__ModuleLoader__.load`, with every baseline module resolved through
 * the injected `require` instead of being inlined into a second copy.
 *
 * Harness seams and the schema libraries stay external, because the profile
 * already resolves them; only the plugin's own modules are bundled.
 */
import { defineConfig } from 'tsdown'

/** Package name; also the module-table row id the browser half registers under. */
const ID = '@prism/prism-memory'

/** Shell-seeded specifiers the browser half must not inline (see `packages/client/web/src/platform.ts`). */
const BASELINE = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-primitives',
]

export default defineConfig([
  {
    name: ID,
    entry: ['src/index.ts', 'src/tools.ts', 'src/commands.ts', 'src/web.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: true,
    fixedExtension: false,
    deps: { neverBundle: [/^@deepseek-ai\//u, 'zod'] },
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
