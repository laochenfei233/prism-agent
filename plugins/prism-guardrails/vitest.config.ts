/**
 * Test configuration for the out-of-tree bundle.
 *
 * The repository runner collects `packages/*\/*\/tests`, which this directory is
 * not, so the bundle carries its own config. It reuses the checkout's
 * `tsconfig.base.json` paths facade and its decorator pre-transform, so the
 * specs compose the REAL services against `src/` exactly as a workspace package
 * would, instead of a hand-built stand-in.
 *
 * Run from this directory:
 *   node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts
 */
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from '../../vitest.shared.ts'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['../../tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    name: 'prism-guardrails',
    include: ['tests/**/*.spec.ts'],
    // These suites drive real Cordis services in one process; forks keep Node's
    // CJS lexer away from worker threads, matching the repository runner.
    pool: 'forks',
    setupFiles: ['../../scripts/test-proxy-environment.ts'],
  },
})
