/**
 * Model-facing long-term memory tools over `ctx.prismMemory`.
 *
 * Five tools, deliberately: a write, a ranked read, an exact read, a retire,
 * and a conversation browse. Their schemas sit in the cached request prefix, so
 * every added tool and every added description is paid for on cold start and on
 * each profile switch. Governance operations that a human owns — approving,
 * rejecting, restoring, exporting, and the hygiene pass — stay off this surface
 * entirely; they live on the `/memory` operator command, which costs no tool
 * schema and cannot be invoked by the model.
 *
 * Scope is never a model choice about *whose* memory is addressed: the service
 * derives the caller's scope from the immutable calling session. The one
 * narrowing the model may ask for is `conversation`, which can only reduce the
 * caller's visible set, never widen it.
 *
 * @module @prism/prism-memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { layerOf, MEMORY_LAYERS } from './layers.ts'
import type { MemoryLayer } from './layers.ts'
import type { PrismMemoryService } from './service.ts'
import type { MemoryChainEntry, MemoryAttribution, MemoryView } from './types.ts'

/** Cordis plugin name for the tool registrant. */
export const name = 'prism-memory-tools'

/** Registries this row contributes to. */
export const inject = ['tools', 'prismMemory'] as const

/** The projection every result carries: the memory plus where it came from. */
interface LineEntry {
  /** The detached memory. */
  readonly memory: MemoryView
  /** Its origin conversation. */
  readonly attribution: MemoryAttribution
}

/** ISO-8601 rendering of a stored epoch-millisecond stamp, or null. */
function isoOrNull(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : new Date(value).toISOString()
}

/** The stored fields a projection needs. */
interface ProjectableRecord {
  /** Opaque identity. */
  readonly id: string
  /** Claim class. */
  readonly kind: string
  /** What the claim is about; absent on a record written before the layer axis. */
  readonly layer?: MemoryLayer | undefined
  /** Visibility class. */
  readonly scope: string
  /** Lifecycle state. */
  readonly status: string
  /** The claim. */
  readonly text: string
  /** Recall keywords. */
  readonly tags: readonly string[]
  /** Producer certainty. */
  readonly confidence: number
  /** Write time. */
  readonly createdAt: number
  /** Start of the validity window. */
  readonly validAt: number | null
  /** End of the validity window. */
  readonly invalidAt: number | null
  /** Time-to-live deadline; absent on a record written before the governance layer. */
  readonly expiresAt?: number | null | undefined
  /** Instant this claim becomes actionable; absent on a record with no date. */
  readonly dueAt?: number | null | undefined
  /** The record that replaced this one. */
  readonly supersededBy: string | null
  /** Explicit opens so far. */
  readonly hits: number
  /** Origin conversation. */
  readonly evidence: MemoryAttribution
}

/** Project one stored record for the model, without its scope key or internals. */
function memoryView(record: ProjectableRecord): MemoryView {
  return {
    id: record.id,
    kind: record.kind,
    layer: layerOf(record),
    scope: record.scope,
    status: record.status,
    text: record.text,
    tags: [...record.tags],
    confidence: record.confidence,
    createdAt: isoOrNull(record.createdAt),
    validAt: isoOrNull(record.validAt),
    invalidAt: isoOrNull(record.invalidAt),
    expiresAt: isoOrNull(record.expiresAt),
    dueAt: isoOrNull(record.dueAt),
    supersededBy: record.supersededBy,
    hits: record.hits,
  }
}

/** Project one record's attribution. */
function attributionOf(record: ProjectableRecord): MemoryAttribution {
  return {
    sessionId: record.evidence.sessionId,
    messageId: record.evidence.messageId,
    note: record.evidence.note,
  }
}

/** The projection of one hit: the memory plus its origin conversation. */
function entryOf(record: ProjectableRecord): LineEntry {
  return { memory: memoryView(record), attribution: attributionOf(record) }
}

/** Field schema shared by every result that returns a memory. */
const memoryProperties = {
  id: { type: 'string', required: true },
  kind: { type: 'string', required: true },
  layer: { type: 'string', required: true },
  scope: { type: 'string', required: true },
  status: { type: 'string', required: true },
  text: { type: 'string', required: true },
  tags: { type: 'array', required: true, items: { type: 'string' } },
  confidence: { type: 'number', required: true },
  createdAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  validAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  invalidAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  expiresAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  dueAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  supersededBy: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  hits: { type: 'integer', required: true },
} as const

/** Field schema of one record's attribution. */
const attributionProperties = {
  sessionId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  messageId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  note: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
} as const

/** Property schema of one hit: a memory and where it came from. */
const entryProperties = {
  memory: { type: 'object', additionalProperties: false, properties: memoryProperties, required: true },
  attribution: { type: 'object', additionalProperties: false, properties: attributionProperties, required: true },
} as const

/** Item schema of a list of hits. */
const entryItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: entryProperties,
} as const

/** Result schema for the operations that return exactly one memory. */
const memoryResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: entryProperties,
} as const

/** Result schema for the operations that return a list of memories. */
const memoryListSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'integer', required: true },
    memories: { type: 'array', required: true, items: entryItemSchema },
  },
} as const

/** Render one hit as a compact, attribution-carrying line. */
function entryLine(entry: LineEntry): string {
  const memory = entry.memory
  const date = memory.createdAt === null ? 'unknown' : memory.createdAt.slice(0, 10)
  const source = entry.attribution.sessionId
  return `[${memory.id}] (${memory.layer}, ${memory.kind}, ${memory.scope}, ${memory.status}, ${date}${source === null ? '' : `, ${source}`}) ${memory.text}`
}

/**
 * Bind the model-facing tool definitions to the activated memory service.
 * @param memory - The memory service exposed by the registrant context.
 * @returns tool definitions in registration order.
 */
function createMemoryTools(memory: PrismMemoryService): ToolDefinition[] {
  const remember = defineTool({
    name: 'memory_remember',
    description: 'Record one durable claim for later sessions. Use it once a conclusion is settled, not for restating the conversation. The layer says what the claim is about: a user preference or a hard rule is recalled on its own in later sessions, while other layers are recalled by relevance.',
    parameters: {
      text: { type: 'string', required: true, description: 'One self-contained claim, understandable without this conversation.' },
      kind: { type: 'string', enum: ['fact', 'decision', 'pitfall', 'preference', 'procedure'], description: 'What sort of statement this is; defaults to fact.' },
      layer: { type: 'string', enum: [...MEMORY_LAYERS], description: 'What the claim is about. user and rule are recalled without a keyword match; soul is the assistant\'s own standing settings; project, fact, lesson, and topic are recalled by relevance. Defaults to fact.' },
      scope: { type: 'string', enum: ['global', 'project', 'conversation'], description: 'Visibility; defaults to global. project is limited to this working directory.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase keywords that improve later recall; omitted, they are derived.' },
      confidence: { type: 'number', description: 'How certain this claim is, 0 to 1. Low confidence stores it pending review.' },
      supersedes: { type: 'string', description: 'Memory id this claim replaces; that record is invalidated in the same write.' },
      ttl_days: { type: 'number', description: 'Days until this claim stops being recalled; omit for a claim that never expires.' },
      due_after_days: { type: 'number', description: 'Days until this claim becomes actionable, for something to be reminded about; omit for a claim with no date.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...entryProperties,
          outcome: { type: 'string', required: true },
          duplicates: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                similarity: { type: 'number', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [value.outcome === 'existing'
          ? 'An identical claim already stood; its reuse count rose and nothing was stored twice:'
          : 'Stored:']
        lines.push(entryLine(value))
        if (value.duplicates.length > 0) {
          lines.push('Near-duplicates already stored — pass one as supersedes if this claim replaces it:')
          for (const duplicate of value.duplicates) lines.push(`  [${duplicate.id}] ${duplicate.text}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async (args, exec) => {
      // The model's claim is anchored to the message it was recorded while
      // answering; the fingerprint lets `/memory verify` re-read it later.
      const anchor = memory.evidenceAnchor(exec.agent)
      const result = await memory.remember({
        text: args.text,
        ...args.kind === undefined ? {} : { kind: args.kind },
        ...args.layer === undefined ? {} : { layer: args.layer },
        ...args.scope === undefined ? {} : { scope: args.scope },
        ...args.tags === undefined ? {} : { tags: args.tags },
        ...args.confidence === undefined ? {} : { confidence: args.confidence },
        ...args.supersedes === undefined ? {} : { supersedes: args.supersedes },
        ...args.ttl_days === undefined ? {} : { ttlDays: args.ttl_days },
        ...args.due_after_days === undefined ? {} : { dueAt: Date.now() + args.due_after_days * 86_400_000 },
        ...anchor === null ? {} : { evidenceMessage: anchor },
      }, exec.agent)
      return {
        ...entryOf(result.record),
        outcome: result.outcome,
        duplicates: result.duplicates.map(entry => ({ id: entry.id, similarity: entry.similarity, text: entry.text })),
      }
    },
  })

  const search = defineTool({
    name: 'memory_search',
    description: 'Search long-term memory by literal keywords and get ranked summaries. Call it before repeating earlier work or re-deciding something. An empty query lists the most recent memories.',
    parameters: {
      query: { type: 'string', required: true, description: 'Literal keywords or an exact phrase; an empty string lists recent memories.' },
      limit: { type: 'integer', description: 'Maximum results; bounded by the deployment configuration.' },
      conversation: { type: 'string', description: 'Restrict to memory distilled from one session id, as memory_conversations lists it.' },
    },
    output: {
      schema: memoryListSchema,
      render: (_args, value) => (value.memories.length === 0
        ? [{ type: 'text', text: 'No memory matched. Record one with memory_remember, or search an empty query to list recent memories.' }]
        : [{
          type: 'text',
          text: [
            `${value.memories.length} memory match(es), best first:`,
            ...value.memories.map(entry => entryLine(entry)),
          ].join('\n'),
        }]),
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const hits = memory.search(args.query, exec.agent, {
        ...args.limit === undefined ? {} : { limit: args.limit },
        ...args.conversation === undefined ? {} : { sessionId: args.conversation },
      })
      return { total: hits.length, memories: hits.map(hit => entryOf(hit.record)) }
    },
  })

  const open = defineTool({
    name: 'memory_open',
    description: 'Read one memory in full by id, with its attribution and the chain of claims it replaced or was replaced by. Use it when a search summary is not enough to verify a claim or to see what it superseded.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id exactly as memory_search rendered it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...entryProperties,
          chain: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                status: { type: 'string', required: true },
                createdAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                invalidAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [entryLine(value), `attribution note: ${value.attribution.note ?? 'none'}`]
        if (value.chain.length > 1) {
          lines.push('Chain, oldest first:')
          for (const entry of value.chain) {
            lines.push(`  [${entry.id}] ${entry.status} (created ${entry.createdAt ?? 'unknown'}, invalid ${entry.invalidAt ?? '—'})`)
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const record = await memory.open(args.id, exec.agent)
      const chain: MemoryChainEntry[] = memory.history(args.id, exec.agent).map(entry => ({
        id: entry.id,
        status: entry.status,
        createdAt: isoOrNull(entry.createdAt),
        invalidAt: isoOrNull(entry.invalidAt),
      }))
      return { ...entryOf(record), chain }
    },
  })

  const forget = defineTool({
    name: 'memory_forget',
    description: 'Retire one memory so it stops being recalled, without deleting it. Use it for a claim that has become wrong or obsolete; prefer memory_remember with supersedes when a replacement claim exists.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id to retire.' },
      reason: { type: 'string', description: 'Short reason, recorded on the retained record.' },
    },
    output: {
      schema: memoryResultSchema,
      render: (_args, value) => [{ type: 'text', text: `Retired, retained for audit:\n${entryLine(value)}` }],
    },
    execute: async (args, exec) => entryOf(await memory.forget(args.id, args.reason, exec.agent)),
  })

  const conversations = defineTool({
    name: 'memory_conversations',
    description: 'List the conversations that contributed long-term memory, with how much each holds. Use it when the question names a conversation rather than a phrase, such as "the conclusion from when we worked on X".',
    parameters: {
      limit: { type: 'integer', description: 'Maximum conversations to list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          conversations: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                sessionId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                liveCount: { type: 'integer', required: true },
                totalCount: { type: 'integer', required: true },
                latestAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                memories: { type: 'array', required: true, items: entryItemSchema },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.conversations.length === 0) {
          return [{ type: 'text', text: 'No conversation has contributed memory visible to this session.' }]
        }
        const lines = ['Conversations that contributed memory, newest first:']
        for (const bucket of value.conversations) {
          lines.push(`${bucket.sessionId ?? '(no session)'} — ${bucket.liveCount} live / ${bucket.totalCount} total`)
          for (const entry of bucket.memories) lines.push(`  ${entryLine(entry)}`)
        }
        lines.push('Narrow to one with the conversation argument of memory_search.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    execute: (args, exec) => {
      const buckets = memory.conversations(exec.agent, args.limit === undefined ? {} : { limit: args.limit })
      return Promise.resolve({
        total: buckets.length,
        conversations: buckets.map(bucket => ({
          sessionId: bucket.sessionId,
          liveCount: bucket.liveCount,
          totalCount: bucket.totalCount,
          latestAt: isoOrNull(bucket.latestAt),
          memories: bucket.recent.map(entryOf),
        })),
      })
    },
  })

  return [remember, search, open, forget, conversations]
}

/**
 * Register the model-facing memory tools.
 * @param ctx - Registrant context carrying `ctx.tools` and `ctx.prismMemory`.
 */
export function apply(ctx: Context): void {
  const memory = ctx.prismMemory
  const dispose = createMemoryTools(memory).map(definition => ctx.tools.register(definition))
  ctx.effect(() => () => {
    for (const remove of dispose) remove()
  }, 'prismMemory.tools.register')
}
