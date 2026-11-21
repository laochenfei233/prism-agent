/**
 * Test configuration for the out-of-tree plugin.
 *
 * The repository runner collects `packages/*\/*\/tests`, which this directory is
 * not, so the plugin carries its own config. It reuses the checkout's
 * `tsconfig.base.json` paths facade and its decorator pre-transform, so the
 * specs exercise the real selection and sweep against the checkout's source.
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
    name: 'prism-session-autoarchive',
    include: ['tests/**/*.spec.ts'],
    // The specs import the archive-set service's source, which roots a Cordis
    // context; forks keep Node's CJS lexer away from worker threads.
    pool: 'forks',
  },
})
