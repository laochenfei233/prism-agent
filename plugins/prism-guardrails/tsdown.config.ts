/**
 * Standalone build for the out-of-tree Host half the Loader imports.
 *
 * Every harness import in `src/` is `import type`, so the emitted module has no
 * imports at all: no bundle entry and no runtime resolution are needed.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'prism-guardrails',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  fixedExtension: false,
})
