/**
 * The `/wiki` operator command: the human half of vault maintenance.
 *
 * Everything here is inspection a person runs deliberately — health, counts,
 * the vault schema, the log, and a rebuild of the search cache. It costs no
 * tool schema, so the cached request prefix is unchanged by it, and the model
 * has no way to invoke it.
 *
 * @module @prism/prism-wiki/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { WikiError, WikiVaultError, brandPagePath } from './service.ts'
import type { WikiVaultService } from './service.ts'
import type { WikiLintReport, WikiPageView, WikiVaultStatus } from './types.ts'

/** Cordis plugin name for the command registrant. */
export const name = 'prism-wiki-commands'

/** Registries this row contributes to. */
export const inject = ['commands', 'wikiVault'] as const

/** How many log entries `/wiki log` lists when the invocation names no count. */
const DEFAULT_LOG_LINES = 10

const USAGE = [
  'Usage: /wiki <subcommand>',
  '  status                     Vault counts and the newest log entry (default)',
  '  lint                       Every finding the health pass reports',
  '  reindex                    Rebuild the search cache from the page files',
  '  open <page>                One page with its links, backlinks, and cited sources',
  '  log [n]                    The newest log entry headings; 10 unless n is given',
  '  schema                     The vault\'s own AGENTS.md conventions',
].join('\n')

/** One parsed invocation: the subcommand and the argument tail after it. */
interface ParsedCommand {
  /** Lowercase subcommand, or an empty string when none was given. */
  readonly subcommand: string
  /** Everything after the subcommand, trimmed. */
  readonly rest: string
}

/**
 * Split one raw invocation into its subcommand and the argument tail.
 * @param raw - the text that followed the command name.
 * @returns the lowercased subcommand and the trimmed remainder.
 */
function parse(raw: string): ParsedCommand {
  const trimmed = raw.trim()
  if (trimmed === '') return { subcommand: '', rest: '' }
  const separator = trimmed.search(/\s/u)
  if (separator < 0) return { subcommand: trimmed.toLowerCase(), rest: '' }
  return { subcommand: trimmed.slice(0, separator).toLowerCase(), rest: trimmed.slice(separator).trim() }
}

/**
 * Parse a positive integer argument, or return the fallback.
 * @param value - the argument text, when one was given.
 * @param fallback - the count to use when the argument is absent or unusable.
 * @returns the requested count.
 */
function limitOf(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * Build the `status` report.
 * @param status - the vault statistics.
 * @returns the operator-facing result.
 */
function statusReport(status: WikiVaultStatus): CommandResult {
  return {
    kind: 'success',
    text: [
      `vault: ${status.vaultRoot}`,
      `pages: ${status.pages}`,
      `sources: ${status.sources} (${status.pendingSources} not yet cited by any page)`,
      `newest log entry: ${status.lastLogEntry ?? 'none'}`,
    ].join('\n'),
  }
}

/**
 * Build the `lint` report.
 * @param report - the vault health report.
 * @returns the operator-facing result.
 */
function lintReport(report: WikiLintReport): CommandResult {
  const heading = `${report.pages} page(s), ${report.sources} source(s), ${report.findings.length} finding(s)`
  if (report.findings.length === 0) return { kind: 'success', text: `${heading}; the vault is clean.` }
  const lines = [`${heading}:`]
  for (const finding of report.findings) {
    lines.push(`${finding.kind}${finding.page === null ? '' : ` ${finding.page}`}: ${finding.detail}`)
  }
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Build the `open` report for one page.
 * @param view - the page and its relations.
 * @returns the operator-facing result.
 */
function openReport(view: WikiPageView): CommandResult {
  const { frontmatter } = view.page
  const lines = [
    `${view.page.path} — ${frontmatter.title}`,
    `${frontmatter.type} · ${frontmatter.status} · updated ${frontmatter.updated} · confidence ${frontmatter.confidence ?? 'unstated'}`,
  ]
  if (frontmatter.tags.length > 0) lines.push(`tags: ${frontmatter.tags.join(', ')}`)
  if (frontmatter.aliases.length > 0) lines.push(`aliases: ${frontmatter.aliases.join(', ')}`)
  if (view.sources.length > 0) lines.push(`cites: ${view.sources.join(', ')}`)
  if (frontmatter.contradicts.length > 0) lines.push(`contradicts: ${frontmatter.contradicts.join(', ')}`)
  if (view.links.length > 0) lines.push(`links to: ${view.links.join(', ')}`)
  if (view.backlinks.length > 0) lines.push(`linked from: ${view.backlinks.join(', ')}`)
  lines.push('', view.page.body)
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Build the `log` report.
 * @param headings - the newest log entry headings, newest first.
 * @returns the operator-facing result.
 */
function logReport(headings: readonly string[]): CommandResult {
  if (headings.length === 0) {
    return { kind: 'success', text: 'The log is empty; it receives one entry per page write.' }
  }
  return { kind: 'success', text: ['Newest first:', ...headings.map(heading => `  ${heading}`)].join('\n') }
}

/**
 * Execute one `/wiki` invocation against the vault service.
 * @param vault - the vault service this deployment serves.
 * @param invocation - the command the operator issued.
 * @returns the operator-facing result.
 */
async function execute(vault: WikiVaultService, invocation: CommandInvocation): Promise<CommandResult> {
  const { subcommand, rest } = parse(invocation.rawInput)
  switch (subcommand) {
    case '': return statusReport(await vault.status())
    case 'status': return statusReport(await vault.status())

    case 'lint': return lintReport(await vault.lint())

    case 'reindex': {
      await vault.rebuildIndex()
      return { kind: 'success', text: 'Search cache discarded and rebuilt from the page files.' }
    }

    case 'open': {
      const page = rest.trim()
      if (page === '') return { kind: 'error', text: USAGE }
      return openReport(await vault.read(brandPagePath(page)))
    }

    case 'log': return logReport(await vault.logTail(limitOf(rest === '' ? undefined : rest, DEFAULT_LOG_LINES)))

    case 'schema': return { kind: 'success', text: await vault.schema() }

    default: return { kind: 'error', text: `unknown subcommand: ${subcommand}\n${USAGE}` }
  }
}

/**
 * Register `/wiki` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the vault service.
 */
export function apply(ctx: Context): void {
  const vault = ctx.wikiVault
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = execute(vault, invocation).catch((error: unknown): CommandResult => {
      if (error instanceof WikiError || error instanceof WikiVaultError) {
        return { kind: 'error', text: `${error.code}: ${error.message}` }
      }
      throw error
    })
    active.add(operation)
    const retire = (): void => { active.delete(operation) }
    // Both branches retire without rethrowing, so the derived observer promise
    // cannot become an unhandled mirror of an expected handler rejection.
    void operation.then(retire, retire)
    return operation
  }

  ctx.effect(function* () {
    // Yield drain before registration: composite teardown is LIFO, so no new
    // invocation can enter while already-started handler promises quiesce.
    yield async () => { await Promise.allSettled(active) }
    yield ctx.commands.register({
      // The id is the compile-time brand over a plain string; the shared brand
      // helper produces the same value without importing the provider's runtime.
      definitionId: brandString<CommandDefinitionId>('@prism/prism-wiki'),
      name: 'wiki',
      description: 'Inspect and maintain the knowledge vault',
      handler,
    })
  }, 'prism-wiki-commands lifecycle')
}
