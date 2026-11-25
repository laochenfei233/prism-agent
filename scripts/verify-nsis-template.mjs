/**
 * Text-level smoke for the NSIS installer template, run on every PR.
 *
 * It verifies three things:
 * 1. every `!include` resolves against the repo, the makensis include
 *    directory, or the documented packaging-provided set below;
 * 2. every `!insertmacro` target is defined by the template, the repo hooks,
 *    a resolved include, or the documented packaging-provided definitions;
 * 3. `Win\RestartManager.nsh` is still included — packaging's app-running
 *    check needs it through tauri-provided hook code, and dropping it breaks
 *    the build only at release time (that is exactly how it broke once).
 *
 * It is not a compile: the template still carries `{{...}}` placeholders that
 * only exist after packaging fills them. Zero-dependency on purpose — the PR
 * CI job runs it with plain node after installing the `nsis` apt package.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
/** `argv[2]` optionally names a template to check beside the repo's own — used by scratch tests. */
const templateOverride = process.argv[2] === undefined ? undefined : resolve(process.argv[2])
const desktopDir = templateOverride === undefined ? join(root, 'apps', 'desktop', 'src-tauri') : dirname(templateOverride)
const TEMPLATE = templateOverride ?? join(desktopDir, 'installer-template.nsi')

/** NSIS include directories a makensis install provides, probed in order. */
const INCLUDE_DIR_CANDIDATES = [
  process.env.MAKENSIS_INCLUDE_DIR,
  'C:\\Program Files (x86)\\NSIS\\Include',
  'C:\\Program Files\\NSIS\\Include',
  '/usr/share/nsis/Include',
].filter(name => name !== undefined && name !== '')

/**
 * Includes that resolve only inside the packaging workspace, where tauri's
 * bundler drops its own NSIS files next to the filled template. CI cannot
 * read them, so include resolution and macro definitions they carry are
 * pinned by the grandfathering list instead of by their text.
 */
const PACKAGING_PROVIDED_INCLUDES = ['utils.nsh', 'FileAssociation.nsh']

/**
 * Macros defined by the packaging-provided includes (tauri-bundler's NSIS
 * files). Extend this list when the template starts inserting a new macro
 * whose definition ships with the bundler; anything else must resolve to a
 * readable include.
 */
const PACKAGING_PROVIDED_MACROS = new Set([
  'APP_ASSOCIATE',
  'APP_UNASSOCIATE',
  'CheckIfAppIsRunning',
  'DeleteAppUserModelId',
  'IsShortcutTarget',
  'SetContext',
  'SetLnkAppUserModelId',
  'SetShortcutTarget',
  'UnpinShortcut',
])

/** The include packaging's generated hook code requires; dropping it broke release packaging once. */
const REQUIRED_INCLUDES = ['Win\\RestartManager.nsh']

/** One unresolvable include, one undefined macro target, or one missing required include. */
class NsisTemplateViolation extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message)
    this.name = 'NsisTemplateViolation'
  }
}

/**
 * Read a text file and return its content, or throw a violation naming the file.
 * @param {string} path
 * @param {string} display
 * @returns {string}
 */
function readText(path, display) {
  if (!existsSync(path)) throw new NsisTemplateViolation(`missing ${display}: ${path}`)
  return readFileSync(path, 'utf8')
}

/**
 * Collect `!include <name>` arguments from NSIS text, skipping template
 * placeholders (`{{...}}`) and comments.
 * @param {string} text
 * @returns {string[]}
 */
function includesOf(text) {
  const found = []
  for (const line of text.split(/\r?\n/u)) {
    const comment = line.indexOf(';')
    const code = comment === -1 ? line : line.slice(0, comment)
    const match = /^\s*!include\s+(.+?)\s*$/u.exec(code)
    if (match !== null) found.push(match[1].replace(/^"(.*)"$/u, '$1'))
  }
  return found.filter(name => !name.startsWith('{{'))
}

/**
 * Collect `!insertmacro <name>` targets from NSIS text, skipping comments.
 * @param {string} text
 * @returns {string[]}
 */
function macrosOf(text) {
  const found = []
  for (const line of text.split(/\r?\n/u)) {
    const comment = line.indexOf(';')
    const code = comment === -1 ? line : line.slice(0, comment)
    const match = /^\s*!insertmacro\s+(\S+)/u.exec(code)
    if (match !== null) found.push(match[1])
  }
  return found
}

/**
 * Collect `!macro <name>` definitions from NSIS text.
 * @param {string} text
 * @returns {ReadonlySet<string>}
 */
function definedMacrosOf(text) {
  return new Set([...text.matchAll(/^\s*!macro\s+(\S+)/gmu)].map(match => match[1]))
}

/**
 * Resolve one include name against the repo desktop directory first, then the
 * makensis include directories. Packaging-provided names are skipped here and
 * handled through the grandfathering lists.
 * @param {string} name
 * @returns {{path: string, text: string} | undefined}
 */
function resolveInclude(name) {
  if (PACKAGING_PROVIDED_INCLUDES.includes(name)) return undefined
  const repoPath = join(desktopDir, name)
  if (existsSync(repoPath)) return { path: repoPath, text: readFileSync(repoPath, 'utf8') }
  for (const dir of INCLUDE_DIR_CANDIDATES) {
    const path = join(dir, ...name.split(/[\\/]/u))
    if (existsSync(path)) return { path, text: readFileSync(path, 'utf8') }
  }
  throw new NsisTemplateViolation(
    `unresolvable !include "${name}" in the template: not under apps/desktop/src-tauri, not found in ${INCLUDE_DIR_CANDIDATES.join(' or ')}, and not in the packaging-provided set`,
  )
}

function main() {
  const template = readText(TEMPLATE, 'NSIS installer template')
  if (!/^\s*!include\s+"?\{\{installer_hooks\}\}"?/gmu.test(template)) {
    throw new NsisTemplateViolation('the template no longer includes the {{installer_hooks}} placeholder; update verify-nsis-template.mjs')
  }
  const hooks = readText(join(desktopDir, 'installer-hooks.nsh'), 'installer hooks')

  /** Macro definitions the checked texts and every resolved include provide. */
  const defined = new Set([...definedMacrosOf(template), ...definedMacrosOf(hooks), ...PACKAGING_PROVIDED_MACROS])
  const included = new Set(includesOf(template))
  if (included.size === 0) throw new NsisTemplateViolation('the template lost its !include block')

  for (const name of included) {
    const resolved = resolveInclude(name)
    if (resolved === undefined) continue
    for (const macro of definedMacrosOf(resolved.text)) defined.add(macro)
  }

  const violations = []
  for (const name of REQUIRED_INCLUDES) {
    if (!included.has(name)) violations.push(`the template no longer includes "${name}"; packaging's app-running check needs it`)
  }
  for (const macro of [...macrosOf(template), ...macrosOf(hooks)]) {
    if (!defined.has(macro)) violations.push(`!insertmacro ${macro} is not defined by the template, installer-hooks.nsh, any resolved include, or the packaging-provided set`)
  }

  if (violations.length > 0) {
    process.stderr.write('verify-nsis-template: the installer template references something nothing provides. Add the missing !include or drop the reference.\n')
    for (const violation of violations) process.stderr.write(`  ${violation}\n`)
    process.exit(1)
  }
  process.stdout.write(`verify-nsis-template: ${included.size} includes resolve (${PACKAGING_PROVIDED_INCLUDES.length} packaging-provided) and every !insertmacro target is defined.\n`)
}

try {
  main()
} catch (error) {
  process.stderr.write(`verify-nsis-template: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
