/**
 * The `/memory` operator command: the human half of memory governance.
 *
 * Every operation here is one a model must not perform on its own — promoting a
 * record out of review, rolling a claim back, expiring the corpus, or writing
 * the audit mirror. Keeping them on the command surface rather than the tool
 * surface enforces that structurally: the model has no way to call them, and
 * the five tool schemas that do sit in the cached prefix stay unchanged.
 *
 * @module @prism/prism-memory/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { MemoryRecord } from './domain.ts'
import { layerOf, MEMORY_LAYERS } from './layers.ts'
import { IMPORT_SOURCE_IDS } from './import.ts'
import { PrismMemoryError, type PrismMemoryService } from './service.ts'

/** Cordis plugin name for the command registrant. */
export const name = 'prism-memory-commands'

/** Registries this row contributes to. */
export const inject = ['commands', 'prismMemory'] as const

const USAGE = [
  'Usage: /memory <subcommand>',
  '  status                     Counts by status, scope, layer, and kind (default)',
  '  review [limit]             The review inbox: records held back until approved',
  '  approve <id> [note]        Promote one pending record to active',
  '  reject <id> [reason]       Archive one pending record',
  '  show <id>                  One record with its provenance and supersede chain',
  '  restore <id> [reason]      Roll a record back to current',
  '  conversations [limit]      Browse the corpus by originating conversation',
  '  maintain [apply]           Hygiene pass; dry run unless "apply" is given',
  '  dream [apply]              Consolidation pass; dry run unless "apply" is given',
  '  journal [limit]            The consolidation journal and daily reflections',
  '  import [apply] [sources]   Read other tools\' memory files; dry run unless "apply" is given',
  '  export [dir]               Write the Markdown mirror and its JSON index',
].join('\n')

/** One parsed invocation: the subcommand and its remaining arguments. */
interface ParsedCommand {
  /** Lowercase subcommand, or an empty string when none was given. */
  readonly subcommand: string
  /** Remaining arguments, with the subcommand removed. */
  readonly rest: string
}

/** Split one raw invocation into its subcommand and the single argument tail. */
function parse(raw: string): ParsedCommand {
  const trimmed = raw.trim()
  if (trimmed === '') return { subcommand: '', rest: '' }
  const separator = trimmed.search(/\s/)
  if (separator < 0) return { subcommand: trimmed.toLowerCase(), rest: '' }
  return { subcommand: trimmed.slice(0, separator).toLowerCase(), rest: trimmed.slice(separator).trim() }
}

/** Split one argument tail into its first word and the remaining free text. */
function firstAndRest(rest: string): { first: string, tail: string | undefined } {
  const separator = rest.search(/\s/)
  if (separator < 0) return { first: rest, tail: undefined }
  const tail = rest.slice(separator).trim()
  return { first: rest.slice(0, separator), tail: tail === '' ? undefined : tail }
}

/** Parse a positive integer argument, or return the fallback. */
function limitOf(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** ISO-8601 date for one epoch-millisecond stamp, or `—`. */
function dateOf(value: number | null): string {
  return value === null ? '—' : new Date(value).toISOString().slice(0, 10)
}

/** One operator-facing line for a stored record. */
function line(record: MemoryRecord): string {
  const session = record.evidence.sessionId === null ? '' : ` session=${record.evidence.sessionId}`
  return `[${record.id}] ${layerOf(record)}/${record.kind}/${record.scope}/${record.status} created=${dateOf(record.createdAt)} invalid=${dateOf(record.invalidAt)}${session}\n  ${record.text}`
}

/** Build the `status` report. */
function statusReport(memory: PrismMemoryService, invocation: CommandInvocation): CommandResult {
  const visible = memory.visible(invocation.agent)
  if (visible.length === 0) return { kind: 'success', text: 'No memory is visible from this session.' }
  const count = (select: (record: MemoryRecord) => string): string => {
    const counts = new Map<string, number>()
    for (const record of visible) {
      const key = select(record)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts.entries()]
      .sort((left, right) => (left[0] < right[0] ? -1 : 1))
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')
  }
  const layers = MEMORY_LAYERS.filter(layer => visible.some(record => layerOf(record) === layer))
  return {
    kind: 'success',
    text: [
      `visible ${visible.length} record(s)`,
      `status: ${count(record => record.status)}`,
      `scope:  ${count(record => record.scope)}`,
      `kind:   ${count(record => record.kind)}`,
      `layer:  ${layers.length === 0 ? '(none)' : layers.join(' ')}`,
    ].join('\n'),
  }
}

/** Execute one `/memory` invocation against the memory service. */
async function execute(memory: PrismMemoryService, invocation: CommandInvocation): Promise<CommandResult> {
  const { subcommand, rest } = parse(invocation.rawInput)
  switch (subcommand) {
    case '': return statusReport(memory, invocation)
    case 'status': return statusReport(memory, invocation)

    case 'review': {
      const pending = memory.review(invocation.agent, { limit: limitOf(rest === '' ? undefined : rest, 50) })
      if (pending.length === 0) return { kind: 'success', text: 'The review inbox is empty.' }
      return {
        kind: 'success',
        text: [`${pending.length} record(s) awaiting review; they never inject until approved:`, ...pending.map(line)].join('\n'),
      }
    }

    case 'approve':
    case 'reject': {
      const { first, tail } = firstAndRest(rest)
      if (first === '') return { kind: 'error', text: USAGE }
      const record = subcommand === 'approve'
        ? await memory.approve(first, tail, invocation.agent)
        : await memory.reject(first, tail, invocation.agent)
      return { kind: 'success', text: `${subcommand}d:\n${line(record)}` }
    }

    case 'show': {
      const id = firstAndRest(rest).first
      if (id === '') return { kind: 'error', text: USAGE }
      const chain = memory.history(id, invocation.agent)
      const target = chain[chain.length - 1]
      if (target === undefined) return { kind: 'error', text: `unknown memory id: ${id}` }
      const detail = [
        line(target),
        `  tags: ${target.tags.length === 0 ? '(none)' : target.tags.join(', ')}`,
        `  confidence: ${target.confidence}  hits: ${target.hits}  corroborations: ${target.corroborations ?? 0}${(target.corroboratedAt ?? null) === null ? '' : ` (confirmed ${dateOf(target.corroboratedAt ?? null)})`}`,
        `  valid ${dateOf(target.validAt)} · expires ${dateOf(target.expiresAt ?? null)} · due ${dateOf(target.dueAt ?? null)} · note ${target.evidence.note ?? 'none'}`,
      ]
      if (chain.length > 1) {
        detail.push('  chain, oldest first:')
        for (const entry of chain) detail.push(`    [${entry.id}] ${entry.status} created=${dateOf(entry.createdAt)}`)
      }
      return { kind: 'success', text: detail.join('\n') }
    }

    case 'restore': {
      const { first, tail } = firstAndRest(rest)
      if (first === '') return { kind: 'error', text: USAGE }
      return { kind: 'success', text: `restored:\n${line(await memory.restore(first, tail, invocation.agent))}` }
    }

    case 'conversations': {
      const buckets = memory.conversations(invocation.agent, { limit: limitOf(rest === '' ? undefined : rest, 20) })
      if (buckets.length === 0) return { kind: 'success', text: 'No conversation has contributed visible memory.' }
      const lines: string[] = []
      for (const bucket of buckets) {
        lines.push(`${bucket.sessionId ?? '(no session)'} — ${bucket.liveCount} live / ${bucket.totalCount} total`)
        for (const record of bucket.recent) lines.push(`  ${line(record)}`)
      }
      return { kind: 'success', text: lines.join('\n') }
    }

    case 'maintain': {
      const report = await memory.maintain({ apply: rest.trim().toLowerCase() === 'apply' })
      const heading = report.applied
        ? 'Maintenance applied.'
        : 'Maintenance dry run: nothing was written. Re-run as "/memory maintain apply" to commit.'
      const details = [
        `records: ${report.totalBefore} → ${report.totalAfter}`,
        `expired: ${report.expired.length === 0 ? 'none' : report.expired.join(', ')}`,
        `duplicates: ${report.duplicates.length === 0 ? 'none' : report.duplicates.map(pair => `${pair.drop}→${pair.keep} (${pair.similarity.toFixed(2)})`).join(', ')}`,
        `evicted: ${report.evicted.length === 0 ? 'none' : report.evicted.join(', ')}`,
        `orphaned supersede links: ${report.orphaned.length === 0 ? 'none' : report.orphaned.join(', ')}`,
      ]
      return { kind: 'success', text: [heading, ...details].join('\n') }
    }

    case 'dream': {
      const report = await memory.dream({ apply: rest.trim().toLowerCase() === 'apply' })
      const heading = report.applied
        ? 'Consolidation applied.'
        : 'Consolidation dry run: nothing was written. Re-run as "/memory dream apply" to commit.'
      const details = [
        `new material scanned: ${report.scanned}`,
        `corroborated: ${report.corroborated.length === 0 ? 'none' : report.corroborated.map(entry => `${entry.id} (x${entry.corroborations})`).join(', ')}`,
        `topics: ${report.topics.length === 0 ? 'none' : report.topics.map(topic => `${topic.tag} (${topic.memberIds.length})`).join(', ')}`,
        `unresolved contradictions: ${report.conflicts.length === 0 ? 'none' : report.conflicts.map(conflict => `${conflict.left} vs ${conflict.right} (${conflict.similarity.toFixed(2)})`).join(', ')}`,
        `journal: ${report.journalId ?? 'not written'}`,
        `reflection: ${report.reflectionId ?? 'not due'}`,
      ]
      return { kind: 'success', text: [heading, ...details].join('\n') }
    }

    case 'journal': {
      const entries = memory.journal(invocation.agent, limitOf(rest === '' ? undefined : rest, 20))
      if (entries.length === 0) return { kind: 'success', text: 'No consolidation pass has run yet.' }
      const lines: string[] = []
      for (const entry of entries) {
        lines.push(`[${entry.id}] ${dateOf(entry.createdAt)} ${entry.tags.join(', ')}`)
        lines.push(`  ${entry.text}`)
      }
      return { kind: 'success', text: lines.join('\n') }
    }

    case 'import': {
      const tokens = rest.split(/\s+/).filter(token => token !== '')
      const apply = tokens.includes('apply')
      const sources = tokens.filter(token => token !== 'apply')
      const report = await memory.importMemories({
        apply,
        ...sources.length === 0 ? {} : { sources },
        agent: invocation.agent,
      })
      const heading = report.applied
        ? 'Import applied.'
        : 'Import dry run: nothing was written. Re-run as "/memory import apply" to commit.'
      const details = [
        `sources read: ${report.sources.join(', ')}`,
        `files contributing: ${report.files.length === 0 ? 'none' : report.files.join(', ')}`,
        `claims parsed: ${report.scanned}`,
        `already known: ${report.skipped}`,
        `stored: ${report.created.length === 0 ? 'none' : report.created.join(', ')}`,
        `known sources: ${IMPORT_SOURCE_IDS.join(', ')}`,
      ]
      return { kind: 'success', text: [heading, ...details].join('\n') }
    }

    case 'export': {
      const dir = rest === '' ? undefined : rest
      const result = await memory.exportMarkdown(dir === undefined ? {} : { dir })
      return { kind: 'success', text: `Exported ${result.total} record(s) to ${result.dir}:\n  ${result.files.join('\n  ')}` }
    }

    default: return { kind: 'error', text: `unknown subcommand: ${subcommand}\n${USAGE}` }
  }
}

/**
 * Register `/memory` for every composed human-command adapter.
 * @param ctx - context carrying the command registry and the memory service.
 */
export function apply(ctx: Context): void {
  const memory = ctx.prismMemory
  const active = new Set<Promise<CommandResult>>()
  const handler = (invocation: CommandInvocation): Promise<CommandResult> => {
    const operation = execute(memory, invocation).catch((error: unknown): CommandResult => {
      if (error instanceof PrismMemoryError) return { kind: 'error', text: `${error.code}: ${error.message}` }
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
      definitionId: CommandDefinitionId('@prism/prism-memory'),
      name: 'memory',
      description: 'Inspect and govern long-term memory',
      handler,
    })
  }, 'prism-memory-commands lifecycle')
}
