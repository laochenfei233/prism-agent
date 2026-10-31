/**
 * Test configuration for the out-of-tree bundle.
 *
 * The repository runner collects `packages/*\/*\/tests`, which this directory
 * is not, so the bundle carries its own config. The suites are pure browser
 * logic (carrier detection, view derivation, copy parity) with no Host
 * services, so no checkout paths facade is needed.
 *
 * Run from this directory:
 *   node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'prism-about',
    include: ['tests/**/*.spec.ts'],
    // One process per suite keeps the carrier stubs in about-bridge specs
    // isolated from the globalThis mutations other files could observe.
    pool: 'forks',
  },
})
