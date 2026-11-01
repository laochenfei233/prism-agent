/**
 * Standalone build for the out-of-tree Host half the Loader imports.
 *
 * Every harness import in `src/` is `import type` except `createUserMessage`
 * from `@deepseek-ai/dsh-llm` and the filesystem skill provider's `apply`.
 * The harness packages stay external, resolved from the profile that loads
 * this bundle, exactly as the sibling `plugins/prism-memory` does — so the
 * artifact carries those imports and a deployment installs nothing of its own.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'prism-guardrails',
  entry: ['src/index.ts', 'src/ponytail.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  fixedExtension: false,
  deps: { neverBundle: [/^@deepseek-ai\//u] },
})
