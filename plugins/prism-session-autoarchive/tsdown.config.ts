/**
 * Standalone build for the out-of-tree plugin the Loader imports.
 *
 * The harness packages stay external, resolved from the profile that loads this
 * bundle exactly as the sibling `plugins/prism-guardrails` does, so a deployment
 * installs nothing of its own alongside it.
 * @module prism-session-autoarchive/build
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'prism-session-autoarchive',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  fixedExtension: false,
  deps: { neverBundle: [/^@deepseek-ai\//u] },
})
