/** Fail when built `lib/` output reachable from a package's published entrypoints escapes its `files` globs. */

import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

interface PackageManifest {
  name?: string
  files?: string[]
  main?: string
  bin?: string | Record<string, string>
  exports?: unknown
}

/** One built file npm would not pack although a published entry reaches it. */
export interface PublishedClosureViolation {
  /** Workspace package name from its manifest. */
  packageName: string
  /** Package-relative path with forward slashes. */
  file: string
}

export interface PublishedClosureResult {
  /** Publishable packages whose built `lib/` closure was checked against the `files` globs. */
  checkedPackages: number
  /** Reached built files outside the globs, sorted by package then file. */
  violations: PublishedClosureViolation[]
}

/**
 * File extensions a built module can load at runtime beside its JavaScript.
 * Source maps and `.tsbuildinfo` are absent on purpose: they are never loaded.
 */
const LOADABLE = /\.(?:[cm]?js|json|node|wasm|css)$/u
/** Relative string literals, covering static imports, dynamic imports, and `new URL(..., import.meta.url)` references. */
const RELATIVE_LITERAL = /(['"`])(\.{1,2}\/[^'"`]+)\1/u

/**
 * Check the runtime closure of each `packages` workspace package that declares
 * `files` and has built output: start at every entry `exports`/`main`/`bin`
 * publishes under `lib/`, follow relative file references in the built text
 * (imported chunks, workers, `new URL` payloads), and require every reached
 * file to match the `files` globs — npm's pack selection, where a directory
 * entry includes its whole subtree and a `!`-prefixed entry excludes. A
 * package without `files` (private) or without a built `lib/` is skipped, so
 * the check consumes only built output and never invents one. Unreached
 * declaration-emit residue and maps stay outside the check: the bundler owns
 * the runtime and the globs keep them unpublished by convention.
 * @param repoRoot - repository root containing `packages/`.
 * @returns the checked package count and the reached files outside the globs.
 */
export function verifyPublishedClosure(repoRoot: string): PublishedClosureResult {
  const manifests = globSync('packages/*/*/package.json', { cwd: repoRoot }).sort()
  const violations: PublishedClosureViolation[] = []
  let checkedPackages = 0
  for (const manifestPath of manifests) {
    const packageDir = resolve(repoRoot, manifestPath, '..')
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PackageManifest
    if (manifest.files === undefined) continue
    const libDir = join(packageDir, 'lib')
    if (!existsSync(libDir)) continue
    checkedPackages += 1
    const included = expandGlobs(manifest.files.filter(pattern => !pattern.startsWith('!')), packageDir)
    const excluded = expandGlobs(manifest.files.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1)), packageDir)
    for (const file of publishedClosure(packageDir, publishedEntries(manifest, packageDir))) {
      if (!included.has(file) || excluded.has(file)) {
        violations.push({ packageName: manifest.name ?? manifestPath, file })
      }
    }
  }
  violations.sort((a, b) => a.packageName.localeCompare(b.packageName) || a.file.localeCompare(b.file))
  return { checkedPackages, violations }
}

/**
 * Collect the entry files the manifest publishes: every relative target in
 * `exports`, plus `main` and each `bin`, resolved to an existing file under
 * the package's `lib/`.
 * @param manifest - parsed package manifest.
 * @param packageDir - package root the targets resolve against.
 * @returns entry file paths inside `lib/`.
 */
function publishedEntries(manifest: PackageManifest, packageDir: string): string[] {
  const targets: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') targets.push(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(visit)
  }
  visit(manifest.exports)
  if (typeof manifest.main === 'string') targets.push(manifest.main)
  if (typeof manifest.bin === 'string') targets.push(manifest.bin)
  else if (typeof manifest.bin === 'object' && manifest.bin !== null) Object.values(manifest.bin).forEach(visit)
  const libDir = join(packageDir, 'lib')
  return targets
    .map(target => resolve(packageDir, target))
    .filter(target => target.startsWith(libDir) && isFile(target))
}

/**
 * Follow relative loadable references from the entries through the built text.
 * @param packageDir - package root bounding the closure to `lib/`.
 * @param entries - entry file paths inside `lib/`.
 * @returns reached lib-relative paths with forward slashes, entries included.
 */
function publishedClosure(packageDir: string, entries: string[]): Set<string> {
  const libDir = join(packageDir, 'lib')
  const reached = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined) break
    reached.add(relative(packageDir, file).replaceAll('\\', '/'))
    const text = readBuiltText(file)
    if (text === undefined) continue
    for (const match of text.matchAll(new RegExp(RELATIVE_LITERAL.source, 'gu'))) {
      const specifier = match[2]
      if (specifier === undefined || !LOADABLE.test(specifier)) continue
      const target = resolveReference(dirname(file), specifier)
      if (target !== undefined && target.startsWith(libDir) && !reached.has(relative(packageDir, target).replaceAll('\\', '/'))) {
        queue.push(target)
      }
    }
  }
  return reached
}

/**
 * Read a built file as text, skipping unloadable binary payloads.
 * @param file - absolute file path inside a package's `lib/`.
 * @returns the file text, or undefined when the file is not text.
 */
function readBuiltText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error instanceof Error && error.message.includes('Invalid UTF-8')) return undefined
    throw error
  }
}

/**
 * Resolve one relative specifier to an existing built file, including the
 * declaration twin a `.d.ts` import reads and the directory index a bare
 * directory specifier loads.
 * @param fromDir - directory of the importing file.
 * @param specifier - relative specifier with forward or platform separators.
 * @returns the referenced file path, or undefined when nothing exists.
 */
function resolveReference(fromDir: string, specifier: string): string | undefined {
  const base = resolve(fromDir, specifier)
  const declaration = base.replace(/\.[cm]?js$/u, '.d.ts')
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`, `${base}.css`
    , join(base, 'index.js'), join(base, 'index.mjs'), join(base, 'index.cjs'), declaration]) {
    if (isFile(candidate)) return candidate
  }
  return undefined
}

/**
 * Whether the path exists as a plain file, so directory specifiers keep falling
 * through to their index candidates.
 * @param path - absolute candidate path.
 */
function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true
}

/**
 * Every file the glob selects, plus its full subtree when the pattern names a
 * directory, so a bare `assets` or `lib` entry behaves like npm's pack.
 * @param patterns - positive glob patterns relative to the package root.
 * @param packageDir - package root the patterns resolve against.
 * @returns matched package-relative paths with forward slashes.
 */
function expandGlobs(patterns: readonly string[], packageDir: string): Set<string> {
  const matched = new Set<string>()
  for (const pattern of patterns) {
    const trimmed = pattern.replace(/\/+$/u, '')
    if (trimmed === '' || trimmed === '/') continue
    for (const candidate of globSync([trimmed, `${trimmed}/**`], { cwd: packageDir })) {
      matched.add(candidate.replaceAll('\\', '/'))
    }
  }
  return matched
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  try {
    const result = verifyPublishedClosure(root)
    if (result.violations.length > 0) {
      throw new Error('verify-published-closure: built lib/ output that a published entry reaches escapes the package files globs, so npm pack would ship a broken package. Extend the package files globs or pin the tsdown chunkFileNames (see packages/sandbox/sandbox-windows-acl/tsdown.config.ts).\n'
        + result.violations.map(violation => `  ${violation.packageName}: ${violation.file}`).join('\n'))
    }
    console.log(`verify-published-closure: ${String(result.checkedPackages)} publishable packages ship every reachable lib/ file inside the published files globs.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
