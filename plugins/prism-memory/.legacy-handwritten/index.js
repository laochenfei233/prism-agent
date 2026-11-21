/**
 * Durable long-term memory service (`ctx.prismMemory`).
 *
 * Design constraints this file encodes, in priority order:
 *
 * 1. **The prefix stays byte-stable.** Nothing here writes to the system prompt
 *    per turn, and nothing rewrites earlier history. The one model-visible
 *    dynamic contribution is a user-role message appended at the request tail
 *    by a prepended `agent/pre-step` listener, and only when retrieval finds
 *    something above the configured score.
 * 2. **Everything model-visible is logged.** Recall text lands as an ordinary
 *    durable `user/message`, so replay, fork, and resume reconstruct it.
 * 3. **A record is superseded, never silently rewritten.**
 *
 * @module @prism/prism-memory
 */

import { randomUUID } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { z as zod } from 'zod';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import {
  extractInjectedIds,
  MEMORY_KINDS,
  MEMORY_SCOPES,
  MEMORY_STATUSES,
  rankRecords,
  renderIndex,
  renderRecall,
} from './memory.js';

/**
 * Prompt-section order for the memory protocol. `getSectionOrder()` only knows
 * repository-allocated names, so this plugin claims a slot inside the tool
 * guidance band, between the goal section (2400) and workflow (2600).
 */
const MEMORY_SECTION_ORDER = 2500;

/** Upper bound on the recalled ids one session's projection carries. */
const MAX_TRACKED_INJECTIONS = 200;

/** The fixed, short memory protocol placed in the stable prompt prefix. */
const DEFAULT_PROTOCOL = [
  'Long-term memory is available through memory_search, memory_open, memory_remember, and memory_forget.',
  'Search memory before starting work that may repeat an earlier decision, and record a durable decision,',
  'pitfall, preference, or reusable procedure with memory_remember once it is settled. Recalled memory is',
  'background: verify it against the workspace before relying on it.',
].join(' ');

/** Durable statuses a search or index may return. */
const SEARCH_STATUSES = ['active'];

/** One stored memory record, validated at the durable boundary. */
const memoryRecordSchema = zod.object({
  id: zod.string().min(1),
  scope: zod.enum(MEMORY_SCOPES),
  scopeKey: zod.string(),
  kind: zod.enum(MEMORY_KINDS),
  text: zod.string().min(1),
  tags: zod.array(zod.string()),
  status: zod.enum(MEMORY_STATUSES),
  confidence: zod.number(),
  createdAt: zod.number(),
  updatedAt: zod.number(),
  validAt: zod.number().nullable(),
  invalidAt: zod.number().nullable(),
  supersedes: zod.string().nullable(),
  supersededBy: zod.string().nullable(),
  evidence: zod.object({
    sessionId: zod.string().nullable(),
    messageId: zod.string().nullable(),
    note: zod.string().nullable(),
  }),
  hits: zod.number(),
});

/** The memory domain: one per-record table so a supersede rewrites one document. */
export const prismMemoryDomainSpec = defineDomain({
  name: 'prism_memory',
  version: 1,
  layout: 'per-record',
  tables: { records: domainTable(memoryRecordSchema) },
});

/** Recalled memory ids for one session, folded from its own injected messages. */
const injectedStateSchema = zod.object({ injected: zod.array(zod.string()) });

/** A memory operation failed for a reason the caller can act on. */
export class PrismMemoryError extends Error {
  /** Stable failure code. */
  code;

  /**
   * @param message - Operator-facing description.
   * @param code - Stable failure code.
   */
  constructor(message, code) {
    super(message);
    this.name = 'PrismMemoryError';
    this.code = code;
  }
}

/** Trim, collapse whitespace, and bound one stored memory text. */
function normalizeText(text, maxChars) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed === '') throw new PrismMemoryError('memory text must not be empty', 'PRISM_MEMORY_EMPTY_TEXT');
  return collapsed.length <= maxChars ? collapsed : `${collapsed.slice(0, maxChars - 1)}…`;
}

/** Normalize one tag list, dropping empties and duplicates. */
function normalizeTags(tags, limit) {
  const seen = new Set();
  for (const tag of tags ?? []) {
    const normalized = String(tag).trim().toLowerCase();
    if (normalized !== '' && !seen.has(normalized)) seen.add(normalized);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/** Concatenate the direct-user text of one step's claimed messages. */
function directUserText(messages) {
  const parts = [];
  for (const message of messages) {
    if (message.source?.kind !== 'user') continue;
    for (const block of message.content ?? []) {
      if (block?.type === 'text') parts.push(String(block.text));
    }
  }
  return parts.join('\n');
}

/**
 * Durable long-term memory over one `prism_memory` domain.
 *
 * Reads are synchronous against the domain's in-memory state, so retrieval
 * never blocks a model step on storage. Writes are durable before they resolve.
 */
export class PrismMemoryService extends Service {
  /** Services required before memory work can activate. */
  static inject = ['storageDomain', 'systemPrompt', 'sessionProjections', 'agents'];

  /** Deployment-owned retrieval, injection, and governance bounds. */
  static Config = z.object({
    protocolSection: z.string().default(DEFAULT_PROTOCOL).volatile(),
    injectEnabled: z.boolean().default(true).volatile(),
    maxInjectedRecords: z.number().step(1).min(1).default(3).volatile(),
    maxInjectedChars: z.number().step(1).min(1).default(900).volatile(),
    minInjectScore: z.number().min(0).default(0.6).volatile(),
    residentIndex: z.boolean().default(false).volatile(),
    maxIndexChars: z.number().step(1).min(1).default(600).volatile(),
    searchLimit: z.number().step(1).min(1).default(6).volatile(),
    maxTextChars: z.number().step(1).min(1).default(2000).volatile(),
    maxTags: z.number().step(1).min(1).default(8).volatile(),
    maxRecords: z.number().step(1).min(1).default(5000).volatile(),
    requireApproval: z.boolean().default(false).volatile(),
    pendingBelowConfidence: z.number().min(0).max(1).default(0.5).volatile(),
  });

  /** The durable record table; assigned by {@link PrismMemoryService.init}. */
  records;

  /**
   * @param ctx - Registrant context carrying storage, prompt, projection, and agent services.
   * @param config - Validated deployment-owned memory bounds.
   */
  constructor(ctx, config) {
    super(ctx, 'prismMemory');
    this.config = config;
  }

  /** Open the durable domain and install the prompt, projection, and recall contributions. */
  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(prismMemoryDomainSpec);
    this.records = domain.table('records');
    this.ctx.effect(() => async () => {
      await domain.close();
    }, 'prismMemory.domainClose');

    this.ctx.systemPrompt.section({
      name: 'prism-memory',
      order: MEMORY_SECTION_ORDER,
      text: () => this.config.protocolSection.get(),
    });

    this.ctx.sessionProjections.register({
      key: 'prismMemory',
      stateVersion: 1,
      stateSchema: injectedStateSchema,
      init: () => ({ injected: [] }),
      apply: (state, event) => {
        if (event.type !== 'user/message' || event.data.source?.kind !== 'prism-memory') return state;
        const ids = extractInjectedIds(event.data.content);
        if (ids.length === 0) return state;
        const merged = new Set(state.injected);
        for (const id of ids) merged.add(id);
        return { injected: [...merged].slice(-MAX_TRACKED_INJECTIONS) };
      },
    });

    this.ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || signal.aborted) return decision;
      const text = this.recallText(agent, decision.messages, step);
      if (text === '') return decision;
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'prism-memory', form: 'snapshot', sections: [{ name: 'prism-memory', text }] },
          }),
        ],
      };
    }, { prepend: true });
  }

  /**
   * The caller's admission context. Scope is derived here from the immutable
   * agent and session, never from model-supplied arguments, so one workspace or
   * conversation cannot read another's records.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns scope key, cwd, session id, and the resulting admission predicate.
   */
  contextFor(agent) {
    const session = agent?.session;
    const cwd = session?.header?.cwd ?? null;
    const sessionId = session?.id ?? null;
    return {
      cwd,
      sessionId,
      isEligible: record => (
        record.scope === 'global'
        || (record.scope === 'project' && cwd !== null && record.scopeKey === cwd)
        || (record.scope === 'conversation' && sessionId !== null && record.scopeKey === sessionId)
      ),
    };
  }

  /** Every stored record, in unspecified order. */
  all() {
    return [...this.records.entries()].map(([, record]) => record);
  }

  /** Recalled ids already injected into one session. */
  injectedIds(agent) {
    const state = this.ctx.sessionProjections.stateOf(agent.session, 'prismMemory');
    return new Set(state?.injected ?? []);
  }

  /**
   * Render the tail block for one step, or an empty string when nothing is
   * worth injecting. Runs only on a turn's first step and never repeats a
   * record the session already received.
   * @param agent - The agent entering the step.
   * @param messages - Messages this step's downstream listeners accepted.
   * @param step - One-based step index within the turn.
   * @returns the block text, or an empty string.
   */
  recallText(agent, messages, step) {
    if (step !== 1 || !this.config.injectEnabled.get()) return '';
    const admission = this.contextFor(agent);
    const query = directUserText(messages);
    let text = '';
    if (query !== '') {
      const already = this.injectedIds(agent);
      // Over-fetch before the already-injected filter so a session that has
      // seen the top hits still reaches the next distinct record.
      const hits = rankRecords(this.all(), query, { isEligible: admission.isEligible, statuses: SEARCH_STATUSES, limit: 50 })
        .filter(hit => hit.matched.length > 0
          && hit.score >= this.config.minInjectScore.get()
          && !already.has(hit.record.id))
        .slice(0, this.config.maxInjectedRecords.get());
      text = renderRecall(hits, { maxChars: this.config.maxInjectedChars.get() });
    }
    if (text === '' && this.config.residentIndex.get()) {
      const visible = this.all().filter(record => admission.isEligible(record));
      const index = renderIndex(visible, { maxChars: this.config.maxIndexChars.get() });
      text = index === '' ? '' : `<prism-memory-index>\n${index}\n</prism-memory-index>`;
    }
    return text;
  }

  /**
   * Resolve the durable scope fields for one write.
   * @param agent - The calling agent, when the caller is model-facing.
   * @param scope - Requested scope; defaults to the deployment default.
   * @returns the stored scope and scope key.
   */
  resolveScope(agent, scope) {
    const requested = scope ?? 'global';
    if (!MEMORY_SCOPES.includes(requested)) {
      throw new PrismMemoryError(`unknown memory scope: ${String(requested)}`, 'PRISM_MEMORY_INVALID_SCOPE');
    }
    const admission = this.contextFor(agent);
    if (requested === 'project') {
      if (admission.cwd === null) {
        throw new PrismMemoryError('project-scoped memory requires a session working directory', 'PRISM_MEMORY_NO_WORKSPACE');
      }
      return { scope: requested, scopeKey: admission.cwd };
    }
    if (requested === 'conversation') {
      if (admission.sessionId === null) {
        throw new PrismMemoryError('conversation-scoped memory requires a calling session', 'PRISM_MEMORY_NO_SESSION');
      }
      return { scope: requested, scopeKey: admission.sessionId };
    }
    return { scope: 'global', scopeKey: '' };
  }

  /** The oldest archived record, the eviction candidate when the store is full. */
  evictionCandidate() {
    let oldest;
    for (const record of this.all()) {
      if (record.status !== 'archived') continue;
      if (oldest === undefined || record.updatedAt < oldest.updatedAt) oldest = record;
    }
    return oldest;
  }

  /**
   * Store one memory. A supplied `supersedes` id is invalidated in the same
   * operation, so the store never holds two claims to be current.
   * @param input - Text, kind, scope, tags, confidence, evidence, and optional supersede target.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the stored record.
   */
  async remember(input, agent) {
    const now = Date.now();
    if (this.records.size >= this.config.maxRecords.get()) {
      const candidate = this.evictionCandidate();
      if (candidate === undefined) {
        throw new PrismMemoryError(
          `memory capacity ${this.config.maxRecords.get()} reached with nothing archived to evict`,
          'PRISM_MEMORY_FULL',
        );
      }
      await this.records.delete(candidate.id);
    }
    const kind = input.kind ?? 'fact';
    if (!MEMORY_KINDS.includes(kind)) {
      throw new PrismMemoryError(`unknown memory kind: ${String(kind)}`, 'PRISM_MEMORY_INVALID_KIND');
    }
    const confidence = input.confidence ?? 1;
    const id = `mem_${randomUUID()}`;
    const { scope, scopeKey } = this.resolveScope(agent, input.scope);
    const status = this.config.requireApproval.get() || confidence < this.config.pendingBelowConfidence.get()
      ? 'pending'
      : 'active';
    const record = {
      id,
      scope,
      scopeKey,
      kind,
      text: normalizeText(input.text, this.config.maxTextChars.get()),
      tags: normalizeTags(input.tags, this.config.maxTags.get()),
      status,
      confidence,
      createdAt: now,
      updatedAt: now,
      validAt: input.validAt ?? now,
      invalidAt: null,
      supersedes: null,
      supersededBy: null,
      evidence: {
        sessionId: agent?.session?.id ?? null,
        messageId: input.messageId ?? null,
        note: null,
      },
      hits: 0,
    };
    if (input.supersedes !== undefined) {
      const previous = this.records.get(input.supersedes);
      if (previous === undefined) {
        throw new PrismMemoryError(`unknown memory id: ${input.supersedes}`, 'PRISM_MEMORY_NOT_FOUND');
      }
      record.supersedes = previous.id;
      await this.records.put(previous.id, {
        ...previous,
        status: 'superseded',
        invalidAt: now,
        supersededBy: id,
        updatedAt: now,
      });
    }
    await this.records.put(id, record);
    return record;
  }

  /**
   * Rank the caller-visible corpus against a literal query.
   * @param query - Literal query text.
   * @param agent - The calling agent, when the caller is model-facing.
   * @param options - Optional result cap and the confidence floor for `pending` admission.
   * @returns ranked hits.
   */
  search(query, agent, options = {}) {
    const cap = this.config.searchLimit.get();
    const requested = options.limit ?? cap;
    const limit = Math.min(Math.max(1, Math.trunc(requested)), cap);
    const statuses = this.config.requireApproval.get() ? ['active', 'pending'] : SEARCH_STATUSES;
    return rankRecords(this.all(), query, {
      isEligible: this.contextFor(agent).isEligible,
      statuses,
      limit,
    });
  }

  /**
   * Read one memory by exact id and record the read as a reuse signal.
   * @param id - Opaque memory id.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the record.
   */
  async open(id, agent) {
    const record = this.records.get(id);
    if (record === undefined) {
      throw new PrismMemoryError(`unknown memory id: ${id}`, 'PRISM_MEMORY_NOT_FOUND');
    }
    if (!this.contextFor(agent).isEligible(record)) {
      throw new PrismMemoryError(`memory ${id} is outside the caller's scope`, 'PRISM_MEMORY_OUT_OF_SCOPE');
    }
    const updated = { ...record, hits: record.hits + 1, updatedAt: Date.now() };
    await this.records.put(id, updated);
    return updated;
  }

  /**
   * Stop injecting one memory without destroying it.
   * @param id - Opaque memory id.
   * @param reason - Optional operator note appended to the record's evidence.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the retired record.
   */
  async forget(id, reason, agent) {
    const record = this.records.get(id);
    if (record === undefined) {
      throw new PrismMemoryError(`unknown memory id: ${id}`, 'PRISM_MEMORY_NOT_FOUND');
    }
    if (!this.contextFor(agent).isEligible(record)) {
      throw new PrismMemoryError(`memory ${id} is outside the caller's scope`, 'PRISM_MEMORY_OUT_OF_SCOPE');
    }
    const now = Date.now();
    const updated = {
      ...record,
      status: 'archived',
      invalidAt: record.invalidAt ?? now,
      updatedAt: now,
      evidence: { ...record.evidence, note: reason ?? record.evidence.note },
    };
    await this.records.put(id, updated);
    return updated;
  }

  /**
   * List caller-visible records, newest first.
   * @param agent - The calling agent, when the caller is model-facing.
   * @param options - Optional status filter and result cap.
   * @returns the selected records.
   */
  list(agent, options = {}) {
    const statuses = options.statuses ?? MEMORY_STATUSES;
    const limit = options.limit ?? 50;
    return this.all()
      .filter(record => this.contextFor(agent).isEligible(record) && statuses.includes(record.status))
      .sort((left, right) => right.createdAt - left.createdAt || (left.id < right.id ? -1 : 1))
      .slice(0, limit);
  }

  /**
   * The L0 index for the caller's visible corpus.
   * @param agent - The calling agent, when the caller is model-facing.
   * @returns the index text, or an empty string.
   */
  index(agent) {
    return renderIndex(
      this.all().filter(record => this.contextFor(agent).isEligible(record)),
      { maxChars: this.config.maxIndexChars.get() },
    );
  }
}

export default PrismMemoryService;
export { extractInjectedIds, MEMORY_KINDS, MEMORY_SCOPES, MEMORY_STATUSES };
