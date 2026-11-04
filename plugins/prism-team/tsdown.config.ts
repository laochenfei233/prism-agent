/**
 * Standalone build for the out-of-tree Host half the Loader imports.
 *
 * Every harness import in `src/` is `import type` except `defineTool` from
 * `@deepseek-ai/dsh-tools` and `CommandDefinitionId` from
 * `@deepseek-ai/dsh-commands/brand`. The harness packages stay external,
 * resolved from the profile that loads this bundle, exactly as the sibling
 * `plugins/prism-guardrails` does.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'prism-team',
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
