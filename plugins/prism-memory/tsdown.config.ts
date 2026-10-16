/**
 * Build for the out-of-tree Host plugin the Loader imports.
 *
 * Three entries, matching the three rows the bundle patch inserts: the durable
 * service (default-exported class), the model-facing tools, and the operator
 * command. Harness seams and the two schema libraries stay external, because
 * the profile already resolves them; only the plugin's own modules are bundled.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  name: 'prism-memory',
  entry: ['src/index.ts', 'src/tools.ts', 'src/commands.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  fixedExtension: false,
  deps: { neverBundle: [/^@deepseek-ai\//u, 'zod'] },
})
