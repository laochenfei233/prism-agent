/**
 * Standalone build for an out-of-tree plugin bundle: the Node half the Loader
 * imports, plus the browser half served at `/plugins/<pkg>/client.js`.
 *
 * The browser half reproduces the shell's dynamic-bundle contract by hand
 * because `packages/client/tsdown.client.ts` is a workspace preset: one CJS
 * closure registered through `window.__ModuleLoader__.load`, with every
 * baseline module resolved through the injected `require` instead of being
 * inlined into a second copy. The `load` id is the package name.
 */
import { defineConfig } from 'tsdown'

/** Package name; also the module-table id the browser half registers under. */
const ID = '@prism/prism-pocket'

/** Shell-seeded specifiers the browser half must not inline (see `packages/client/web/src/platform.ts`). */
const BASELINE = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
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
    deps: { neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm'] },
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
