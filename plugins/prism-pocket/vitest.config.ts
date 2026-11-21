/**
 * Test configuration for the out-of-tree bundle.
 *
 * The repository runner collects `packages/*\/*\/tests`, which this directory
 * is not, so the bundle carries its own config. It reuses the checkout's
 * `tsconfig.base.json` paths facade so specs can import workspace helpers
 * (the brand constructors) from source, exactly as a workspace package would.
 *
 * Run from this directory:
 *   node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts
 */
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['../../tsconfig.base.json'] })],
  test: {
    name: 'prism-pocket',
    include: ['tests/**/*.spec.ts'],
    // The push suites drive node:crypto and the filesystem; forks keep Node's
    // CJS lexer away from worker threads, matching the repository runner.
    pool: 'forks',
  },
})
