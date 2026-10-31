/**
 * Test configuration for the out-of-tree bundle.
 *
 * The repository runner collects test directories under packages/, which this
 * directory is not, so the bundle carries its own config. Run from this
 * directory:
 *   node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'prism-local-models',
    include: ['tests/**/*.spec.ts'],
    // The registry and download suites drive node:fs and local HTTP servers;
    // forks keep Node's CJS lexer away from worker threads.
    pool: 'forks',
  },
})
