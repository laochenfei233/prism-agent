/**
 * Inheriting memory that already exists outside this plugin.
 *
 * A user who has been working with several assistants arrives with durable
 * knowledge already on disk: instruction files in the workspace, per-user memory
 * directories, editor rule files. None of it is reachable from this plugin's own
 * store, so a fresh corpus starts by forgetting everything the user already told
 * another tool.
 *
 * This module finds those files and turns them into candidates. It is two
 * halves on purpose: {@link collectMemoryFiles} touches the filesystem,
 * {@link parseMemoryClaims} is pure. The importer can therefore be tested against
 * recorded file contents without a fixture tree, and the parsing rules can be
 * reviewed without reading filesystem code.
 *
 * Every read is bounded — file count, file size, and claims per file — because
 * the directories this walks belong to other tools and their size is not ours to
 * assume. Nothing here writes; the caller decides status, scope, and confidence.
 *
 * @module @prism/prism-memory/import
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryScope } from './memory.ts'
import type { MemoryLayer } from './layers.ts'

/** One known external layout this plugin can read. */
export interface ImportSourceSpec {
  /** Stable identifier used on the command line. */
  readonly id: string
  /** What the layout is, for an operator choosing one. */
  readonly description: string
  /** Layer assumed for claims this layout yields when its own headings say nothing. */
  readonly defaultLayer: MemoryLayer
  /** Visibility claims from this layout are stored under, subject to the caller having a workspace. */
  readonly scope: MemoryScope
  /**
   * Where the layout lives.
   * @param context - the user's home directory and the calling session's working directory.
   * @returns absolute file or directory paths; a missing one is skipped, not an error.
   */
  readonly roots: (context: { readonly home: string, readonly cwd: string | null }) => string[]
}

/**
 * The layouts this plugin knows. Each is read only when asked for by id: a
 * deployment's own files are not enumerated behind its back, and adding a layout
 * is a deliberate act rather than something the plugin discovers.
 */
export const IMPORT_SOURCES: readonly ImportSourceSpec[] = [
  {
    id: 'claude-code',
    description: "Claude Code's user memory and per-project memory directories",
    defaultLayer: 'user',
    scope: 'global',
    roots: ({ home, cwd }) => [
      join(home, '.claude', 'CLAUDE.md'),
      join(home, '.claude', 'memory'),
      ...cwd === null ? [] : [join(home, '.claude', 'projects')],
    ],
  },
  {
    id: 'mimocode',
    description: 'MiMoCode memory files under the user data directory',
    defaultLayer: 'user',
    scope: 'global',
    roots: ({ home }) => [join(home, '.local', 'share', 'mimocode', 'memory')],
  },
  {
    id: 'cursor',
    description: "Cursor's rule files for the calling workspace",
    defaultLayer: 'project',
    scope: 'project',
    roots: ({ cwd }) => cwd === null ? [] : [join(cwd, '.cursor', 'rules'), join(cwd, '.cursorrules')],
  },
  {
    id: 'workspace',
    description: 'Instruction files at the calling workspace root',
    defaultLayer: 'project',
    scope: 'project',
    roots: ({ cwd }) => cwd === null ? [] : [join(cwd, 'AGENTS.md'), join(cwd, 'CLAUDE.md')],
  },
]

/** The source ids an operator may name. */
export const IMPORT_SOURCE_IDS: readonly string[] = IMPORT_SOURCES.map(source => source.id)

/** Extensions this importer reads. Everything else in a walked directory is ignored. */
const READABLE_EXTENSIONS = ['.md', '.mdc', '.markdown', '.txt']

/** Directory names never descended into. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'lib', 'out', 'coverage'])

/** Bounds on one import. */
export interface CollectOptions {
  /** Maximum files read in one import. */
  readonly maxFiles?: number
  /** Maximum bytes read from one file; a larger file is skipped. */
  readonly maxFileBytes?: number
  /** Maximum directory depth below a root. */
  readonly maxDepth?: number
}

/** One discovered file, with the layout that found it. */
export interface DiscoveredFile {
  /** Absolute path of the file. */
  readonly path: string
  /** The source id whose root reached it. */
  readonly sourceId: string
  /** The layer assumed when the file's own headings say nothing. */
  readonly defaultLayer: MemoryLayer
  /** The visibility the file's layout implies. */
  readonly scope: MemoryScope
}

/**
 * Walk one root and append every readable memory file under it.
 *
 * A root that does not exist is skipped silently: these directories belong to
 * other tools, so "this user does not have that layout" is the ordinary case
 * rather than an error. Bounds stop the walk at the first limit reached, so a
 * surprise in someone else's directory cannot become an unbounded read.
 * @param root - absolute file or directory path.
 * @param found - the accumulator, appended in walk order.
 * @param state - the remaining file budget and the walk bounds.
 */
async function walk(
  root: string,
  found: DiscoveredFile[],
  state: { readonly sourceId: string, readonly defaultLayer: MemoryLayer, readonly scope: MemoryScope, readonly maxFiles: number, readonly maxFileBytes: number, readonly maxDepth: number, depth: number },
): Promise<void> {
  if (found.length >= state.maxFiles) return
  let info
  try {
    info = await stat(root)
  } catch (error: unknown) {
    // A nonexistent root is the expected outcome for a layout this user does not use.
    if ((error as { code?: string }).code === 'ENOENT') return
    throw error
  }
  if (info.isFile()) {
    if (READABLE_EXTENSIONS.some(extension => root.endsWith(extension)) && info.size <= state.maxFileBytes) {
      found.push({ path: root, sourceId: state.sourceId, defaultLayer: state.defaultLayer, scope: state.scope })
    }
    return
  }
  if (!info.isDirectory() || state.depth >= state.maxDepth) return
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error: unknown) {
    // An unreadable directory is not this plugin's to fix; the import reports what it read.
    if ((error as { code?: string }).code === 'EACCES' || (error as { code?: string }).code === 'EPERM') return
    throw error
  }
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if (found.length >= state.maxFiles) return
    const child = join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(child, found, { ...state, depth: state.depth + 1 })
    } else if (READABLE_EXTENSIONS.some(extension => entry.name.endsWith(extension))) {
      const size = (await stat(child)).size
      if (size <= state.maxFileBytes) {
        found.push({ path: child, sourceId: state.sourceId, defaultLayer: state.defaultLayer, scope: state.scope })
      }
    }
  }
}

/**
 * Discover the memory files the named layouts hold.
 * @param sourceIds - layout ids to read; an unknown id fails rather than being skipped.
 * @param context - the user's home directory and the calling session's working directory.
 * @param options - file-count, file-size, and depth bounds.
 * @returns the discovered files, in walk order, deduplicated by path.
 */
export async function collectMemoryFiles(
  sourceIds: readonly string[],
  context: { readonly home: string, readonly cwd: string | null },
  options: CollectOptions = {},
): Promise<DiscoveredFile[]> {
  const { maxFiles = 50, maxFileBytes = 131_072, maxDepth = 6 } = options
  const selected = sourceIds.map(id => {
    const source = IMPORT_SOURCES.find(candidate => candidate.id === id)
    if (source === undefined) {
      throw new Error(`unknown memory import source: ${id} (known: ${IMPORT_SOURCE_IDS.join(', ')})`)
    }
    return source
  })
  const found: DiscoveredFile[] = []
  const seen = new Set<string>()
  for (const source of selected) {
    for (const root of source.roots(context)) {
      await walk(root, found, {
        sourceId: source.id,
        defaultLayer: source.defaultLayer,
        scope: source.scope,
        maxFiles,
        maxFileBytes,
        maxDepth,
        depth: 0,
      })
    }
  }
  return found.filter(file => {
    if (seen.has(file.path)) return false
    seen.add(file.path)
    return true
  })
}

/** One claim parsed out of a foreign memory file. */
export interface ImportedClaim {
  /** The claim, stripped of its markdown markers. */
  readonly text: string
  /** The layer inferred from its heading, or the source's default. */
  readonly layer: MemoryLayer
}

/** Parsing bounds and the source's fallback layer. */
export interface ParseOptions {
  /** Layer assumed when nothing in the file names one. */
  readonly defaultLayer: MemoryLayer
  /** Maximum claims one file contributes. */
  readonly maxClaims?: number
  /** Shortest accepted claim. */
  readonly minChars?: number
  /** Longest accepted claim. */
  readonly maxChars?: number
}

/**
 * Heading words that name a layer, checked before the source default.
 *
 * Imported files were written for other tools, so their headings are the only
 * in-band signal about what a section is. A file that names nothing keeps its
 * source's default rather than being guessed at.
 */
const HEADING_LAYERS: readonly { readonly pattern: RegExp, readonly layer: MemoryLayer }[] = [
  { pattern: /(persona|identity|人格|身份|语气|tone|style)/i, layer: 'soul' },
  { pattern: /(user|profile|偏好|preference|习惯|habit)/i, layer: 'user' },
  { pattern: /(rule|constraint|must|规则|约束|禁止|红线)/i, layer: 'rule' },
  { pattern: /(pitfall|lesson|gotcha|教训|坑|避免)/i, layer: 'lesson' },
  { pattern: /(project|repo|workspace|setup|架构|项目|目录结构)/i, layer: 'project' },
  { pattern: /(fact|factual|事实)/i, layer: 'fact' },
  { pattern: /(topic|reference|knowledge|主题|参考)/i, layer: 'topic' },
]

/** Strip markdown emphasis, links, and code ticks from one line. */
function plain(line: string): string {
  return line
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?。！？;；:：,，]+$/u, '')
    .trim()
}

/**
 * Read one foreign memory file into claims.
 *
 * Three exclusions make the result usable rather than merely complete. Fenced
 * code is skipped, because a command block in a rule file is an example rather
 * than a claim. Table rows and link-only lines are skipped, because they are
 * indexes. And a line ending in a colon is skipped, because it announces a list
 * instead of stating something.
 * @param content - the file's text.
 * @param options - the fallback layer and the claim bounds.
 * @returns claims in document order, with their inferred layers.
 */
export function parseMemoryClaims(content: string, options: ParseOptions): ImportedClaim[] {
  const { defaultLayer, maxClaims = 20, minChars = 12, maxChars = 320 } = options
  const claims: ImportedClaim[] = []
  let layer = defaultLayer
  let inFence = false
  for (const rawLine of content.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('```') || line.startsWith('~~~')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (line.startsWith('#')) {
      const heading = plain(line.replace(/^#+/, ''))
      layer = HEADING_LAYERS.find(entry => entry.pattern.test(heading))?.layer ?? defaultLayer
      continue
    }
    if (line === '' || line.startsWith('|') || line.startsWith('<')) continue
    const raw = line.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, '')
    // The question test runs on the raw line: `plain` strips trailing
    // punctuation, and a sentence whose only question mark is terminal would
    // otherwise pass as a statement.
    if (raw.includes('?') || raw.includes('？')) continue
    const body = plain(raw)
    if (body === '' || body.endsWith(':')) continue
    if (body.length < minChars || body.length > maxChars) continue
    if (/^https?:\/\//.test(body)) continue
    claims.push({ text: body, layer })
    if (claims.length >= maxClaims) break
  }
  return claims
}

/**
 * Read one discovered file.
 * @param file - the discovered file to read.
 * @returns the file's text.
 */
export function readMemoryFile(file: DiscoveredFile): Promise<string> {
  return readFile(file.path, 'utf8')
}
