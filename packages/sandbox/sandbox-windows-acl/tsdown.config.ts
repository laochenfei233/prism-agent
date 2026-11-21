import { defineConfig } from 'tsdown'

// The confinement runner and the grant runner build as their own entries
// (path-loaded by dsh-sandbox-local's win32 chain), inlining the sandbox
// primitives while koffi stays an external native require — the same shape as
// directory-picker-native's worker entry. Every entry shares code, so the
// shared chunk keeps the package's published `lib/types-*.js` name instead of
// a name derived from whichever module happened to land there.
export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    runner: 'lib/types/runner.js',
    'grant-runner': 'lib/types/grant-runner.js',
  },
  outputOptions: { chunkFileNames: 'types-[hash].js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
