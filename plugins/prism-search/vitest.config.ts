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
    name: 'prism-search',
    include: ['tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
