/**
 * Test configuration for the out-of-tree bundle.
 *
 * The repository runner collects `packages/*\/*\/tests`, which this directory
 * is not, so the bundle carries its own config. It reuses the checkout's
 * `tsconfig.base.json` paths facade and its decorator pre-transform, so the
 * specs compose the REAL services against `src/` exactly as a workspace package
 * would, instead of a hand-built stand-in.
 *
 * Run from this directory:
 *   node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts
 */
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from '../../vitest.shared.ts'

// The bundle sits outside the pnpm workspace, so it has no dependency tree of
// its own. `zod` is a real runtime import; resolve it through the checkout
// package that declares it, exactly as tsconfig.json does for the typecheck.
const checkoutRequire = createRequire(
  fileURLToPath(new URL('../../packages/storage/storage-domain/package.json', import.meta.url)),
)
const zodRoot = dirname(checkoutRequire.resolve('zod/package.json'))

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['../../tsconfig.base.json'] }), standardDecoratorPlugin()],
  resolve: { alias: { zod: zodRoot } },
  test: {
    name: 'prism-memory',
    include: ['tests/**/*.spec.ts'],
    // These suites drive real Cordis services in one process; forks keep Node's
    // CJS lexer away from worker threads, matching the repository runner.
    pool: 'forks',
    setupFiles: [
      '../../scripts/test-proxy-environment.ts',
      '../../scripts/test-invariants.ts',
    ],
  },
})
