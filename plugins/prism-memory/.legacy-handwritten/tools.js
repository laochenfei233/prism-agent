/**
 * Model-facing long-term memory tools over `ctx.prismMemory`.
 *
 * Four tools, deliberately: a write, a ranked read, an exact read, and a
 * retire. Their schemas sit in the cached request prefix, so every added tool
 * and every added description is paid for on cold start and on each profile
 * switch. Scope is never a model choice about *whose* memory is addressed: the
 * service derives the caller's scope from the immutable calling session.
 *
 * @module @prism/prism-memory/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

/** Cordis plugin name for the tool registrant. */
export const name = 'prism-memory-tools';

/** Registries this row contributes to. */
export const inject = ['tools', 'prismMemory'];

/** One text block carrying a label and a lossless JSON projection. */
function renderJson(label, value) {
  return [{ type: 'text', text: `${label}: ${JSON.stringify(value)}` }];
}

/** ISO-8601 rendering of a stored epoch-millisecond stamp, or null. */
function isoOrNull(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

/** The detached model-facing projection of one stored memory. */
function memoryView(record) {
  return {
    id: record.id,
    kind: record.kind,
    scope: record.scope,
    status: record.status,
    text: record.text,
    tags: [...record.tags],
    confidence: record.confidence,
    createdAt: isoOrNull(record.createdAt),
    validAt: isoOrNull(record.validAt),
    invalidAt: isoOrNull(record.invalidAt),
    supersededBy: record.supersededBy,
    hits: record.hits,
  };
}

/** Shared result schema for operations returning one memory. */
const memoryProperties = {
  id: { type: 'string', required: true },
  kind: { type: 'string', required: true },
  scope: { type: 'string', required: true },
  status: { type: 'string', required: true },
  text: { type: 'string', required: true },
  tags: { type: 'array', required: true, items: { type: 'string' } },
  confidence: { type: 'number', required: true },
  createdAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  validAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  invalidAt: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  supersededBy: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
  hits: { type: 'integer', required: true },
};

const memoryResultSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    memory: {
      type: 'object',
      additionalProperties: false,
      properties: memoryProperties,
      required: true,
    },
  },
};

/** Render one ranked result list as compact, best-first lines. */
function renderSearch(memories) {
  if (memories.length === 0) return [{ type: 'text', text: 'No memory matched. Record one with memory_remember, or search an empty query to list recent memories.' }];
  const lines = memories.map(record => {
    const date = new Date(record.createdAt).toISOString().slice(0, 10);
    return `[${record.id}] (${record.kind}, ${record.scope}, ${date}, ${record.status}) ${record.text}`;
  });
  return [{ type: 'text', text: [`${memories.length} memory match(es), best first:`, ...lines].join('\n') }];
}

/**
 * Bind the four tool definitions to the activated memory service.
 * @param memory - The memory service exposed by the registrant context.
 * @returns tool definitions in registration order.
 */
function createMemoryTools(memory) {
  const remember = defineTool({
    name: 'memory_remember',
    description: 'Record one durable fact, decision, pitfall, preference, or procedure for later sessions. Use it once a conclusion is settled, not for restating the conversation.',
    parameters: {
      text: { type: 'string', required: true, description: 'One self-contained claim, understandable without this conversation.' },
      kind: { type: 'string', enum: ['fact', 'decision', 'pitfall', 'preference', 'procedure'], description: 'Memory kind; defaults to fact.' },
      scope: { type: 'string', enum: ['global', 'project', 'conversation'], description: 'Visibility; defaults to global. project is limited to this working directory.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional lowercase keywords that improve later recall.' },
      confidence: { type: 'number', description: 'How certain this claim is, 0 to 1. Low confidence stores it pending review.' },
      supersedes: { type: 'string', description: 'Memory id this claim replaces; that record is invalidated in the same write.' },
    },
    output: {
      schema: memoryResultSchema,
      render: (_args, value) => renderJson('Stored memory', value),
    },
    async execute(args, exec) {
      const record = await memory.remember({
        text: args.text,
        ...(args.kind === undefined ? {} : { kind: args.kind }),
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        ...(args.tags === undefined ? {} : { tags: args.tags }),
        ...(args.confidence === undefined ? {} : { confidence: args.confidence }),
        ...(args.supersedes === undefined ? {} : { supersedes: args.supersedes }),
      }, exec.agent);
      return { memory: memoryView(record) };
    },
  });

  const search = defineTool({
    name: 'memory_search',
    description: 'Search long-term memory by literal keywords and get ranked summaries. Call it before repeating earlier work or re-deciding something. An empty query lists the most recent memories.',
    parameters: {
      query: { type: 'string', required: true, description: 'Literal keywords or an exact phrase; an empty string lists recent memories.' },
      limit: { type: 'integer', description: 'Maximum results; bounded by the deployment configuration.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          memories: {
            type: 'array',
            required: true,
            items: { type: 'object', additionalProperties: false, properties: memoryProperties },
          },
        },
      },
      render: (_args, value) => renderSearch(value.memories),
    },
    execute(args, exec) {
      const hits = memory.search(args.query, exec.agent, args.limit === undefined ? {} : { limit: args.limit });
      return Promise.resolve({ total: hits.length, memories: hits.map(hit => memoryView(hit.record)) });
    },
  });

  const open = defineTool({
    name: 'memory_open',
    description: 'Read one memory in full by id, with its kind, dates, tags, confidence, and attribution. Use it when a search summary is not enough to verify a claim.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id exactly as memory_search rendered it.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memory: { type: 'object', additionalProperties: false, properties: memoryProperties, required: true },
          evidence: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              sessionId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
              messageId: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
              note: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
            },
          },
        },
      },
      render: (_args, value) => renderJson('Memory', value),
    },
    async execute(args, exec) {
      const record = await memory.open(args.id, exec.agent);
      return {
        memory: memoryView(record),
        evidence: {
          sessionId: record.evidence.sessionId,
          messageId: record.evidence.messageId,
          note: record.evidence.note,
        },
      };
    },
  });

  const forget = defineTool({
    name: 'memory_forget',
    description: 'Retire one memory so it stops being recalled, without deleting it. Use it for a claim that has become wrong or obsolete; prefer memory_remember with supersedes when a replacement claim exists.',
    parameters: {
      id: { type: 'string', required: true, description: 'Memory id to retire.' },
      reason: { type: 'string', description: 'Short reason, recorded on the retained record.' },
    },
    output: {
      schema: memoryResultSchema,
      render: (_args, value) => renderJson('Retired memory', value),
    },
    async execute(args, exec) {
      const record = await memory.forget(args.id, args.reason, exec.agent);
      return { memory: memoryView(record) };
    },
  });

  return [remember, search, open, forget];
}

/**
 * Register the model-facing memory tools.
 * @param ctx - Registrant context carrying `ctx.tools` and `ctx.prismMemory`.
 */
export function apply(ctx) {
  const dispose = createMemoryTools(ctx.prismMemory).map(definition => ctx.tools.register(definition));
  ctx.effect(() => () => {
    for (const remove of dispose) remove();
  }, 'prismMemory.tools.register');
}

/** Plugin descriptor consumed by the Cordis loader. */
export default { name, inject, apply };
