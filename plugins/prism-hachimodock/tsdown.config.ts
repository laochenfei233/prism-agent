/**
 * Standalone build for an out-of-tree plugin bundle: the Node half the Loader
 * imports, plus the browser half served at `/plugins/<pkg>/client.js`.
 *
 * The browser half reproduces the shell's dynamic-bundle contract by hand
 * (one CJS closure registered through `window.__ModuleLoader__.load`); it
 * carries no runtime imports, so the module table stays untouched.
 */
import { defineConfig } from 'tsdown'

/** Package name; also the module-table id the browser half registers under. */
const ID = '@prism/prism-hachimodock'

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
    deps: { neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery'] },
  },
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    fixedExtension: false,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
