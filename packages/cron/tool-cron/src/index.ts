/**
 * Model-facing scheduled-task tools over the `ctx.cron` capability:
 * `cron_create`, `cron_list`, `cron_update`, `cron_delete`, and `cron_run`.
 *
 * Every tool answers one canonical JSON value whose failure branch carries a
 * code from the closed `CronErrorCode` union, so a provider refusal reaches the
 * model as a stable value rather than as a thrown stack. The schemas, the
 * results, and the refusals name only what a scheduled task is: its rule, its
 * zone, its target, its prompt, and its run ceiling.
 *
 * Creating or re-pointing a task is the act that authorizes future unattended
 * spending, so those two tools require the direct human authority the goal
 * tools own; a task whose runs create their own Session must also state the
 * agent and permission presets it runs under.
 * @module @deepseek-ai/dsh-tool-cron
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CronServiceError } from '@deepseek-ai/dsh-cron'
import type {
  CronErrorCode,
  CronJob,
  CronJobId,
  CronJobRequest,
  CronJobUpdate,
  CronRunRecord,
  CronTarget,
} from '@deepseek-ai/dsh-cron'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  GenericCallView,
  ParameterPropertySpec,
  ParameterSchemaSpec,
  ToolRunContext,
  ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import { cronToolAuthority, requireHumanAuthority } from './authority.ts'

export const name = 'tool-cron'
export const inject = ['agents', 'cron', 'sessionProjections', 'tools']

/** Deployment policy for the scheduled-task tools. */
export interface Config {
  /** Run ceiling, in milliseconds, for a task whose creation states none. */
  defaultMaxRunMs?: number
}

/** Schemastery configuration for the scheduled-task tools. */
export const Config: z<Config> = z.object({
  defaultMaxRunMs: z.natural().min(1).default(600_000),
})

/** Fully materialized tool policy. */
interface ResolvedConfig {
  readonly defaultMaxRunMs: number
}

/** The target fields a tool schema accepts, as the model states them. */
interface TargetArgs {
  kind: 'new-session' | 'session'
  workspace_path?: string
  agent_preset?: string
  permission_preset?: string
  model_provider?: string
  model?: string
  session_id?: string
}

/** The stored target, as a model reads it. */
type TargetValue =
  | {
    kind: 'new-session'
    workspace_path: string
    agent_preset: string
    permission_preset: string
    model_provider?: string
    model?: string
  }
  | { kind: 'session'; session_id: string }

/** One finished run, as a model reads it. */
interface RunValue {
  started_at: string
  finished_at: string
  outcome: CronRunRecord['outcome']
}

/** The scheduled-task fields a model sees for a stored task. */
interface JobValue {
  id: string
  expression: string
  time_zone: string
  enabled: boolean
  target: TargetValue
  prompt: string
  overlap_policy: CronJob['overlapPolicy']
  misfire_policy: CronJob['misfirePolicy']
  max_run_ms: number
  next_due_at: string
  recent_runs: RunValue[]
}

/** A management call refused by a state the cron capability names. */
interface CronFailure {
  ok: false
  code: CronErrorCode
  message: string
}

/** One task plus the occurrence a creation or update stored for it. */
interface CronJobStoredValue {
  ok: true
  id: string
  next_due_at: string
  enabled: boolean
}

/** The tasks a management call read. */
interface CronJobListValue {
  ok: true
  jobs: JobValue[]
}

/** The removal of one task. */
interface CronDeleteValue {
  ok: true
  id: string
  deleted: true
}

/** The run one immediate execution recorded. */
interface CronRunValue {
  ok: true
  run: RunValue
}

const RUN_OUTCOMES = ['completed', 'failed', 'timeout', 'blocked', 'interrupted'] as const

const OVERLAP_POLICIES = ['skip', 'queue-one'] as const

const MISFIRE_POLICIES = ['skip', 'run-once-late'] as const

/**
 * The target fields one tool schema accepts.
 *
 * A `new-session` target must state the agent and permission presets its
 * unattended runs act under, so no default stands in for a choice nobody made.
 * One readonly block is shared by every schema that states a target, so the
 * tools that create and update one cannot drift apart.
 */
const TARGET_PROPERTIES = {
  kind: {
    type: 'string',
    required: true,
    enum: ['new-session', 'session'],
    description: 'new-session (each run creates its own session) | session (each run continues one existing session).',
  },
  workspace_path: {
    type: 'string',
    description: 'Absolute directory a new-session run works in; required with kind new-session.',
  },
  agent_preset: {
    type: 'string',
    description: 'Agent preset a new-session run is composed from; required with kind new-session.',
  },
  permission_preset: {
    type: 'string',
    description: 'Permission preset a new-session run acts under; required with kind new-session.',
  },
  model_provider: {
    type: 'string',
    description: 'Provider for a new-session run when it must differ from the deployment default.',
  },
  model: {
    type: 'string',
    description: 'Model for a new-session run when it must differ from the deployment default.',
  },
  session_id: {
    type: 'string',
    description: 'Session every run continues; required with kind session.',
  },
} as const satisfies ParameterSchemaSpec

/** The target node a write states. */
const TARGET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: true,
  description: 'Where each run happens.',
  properties: TARGET_PROPERTIES,
} as const satisfies ParameterPropertySpec

/** The target node an update states, which may be omitted to keep the stored one. */
const TARGET_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: 'Replacement target; a new-session target must state its workspace, agent preset, and permission preset.',
  properties: TARGET_PROPERTIES,
} as const satisfies ParameterPropertySpec

/** One finished run in a listed task. */
const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    started_at: { type: 'string', required: true },
    finished_at: { type: 'string', required: true },
    outcome: { type: 'string', required: true, enum: [...RUN_OUTCOMES] },
  },
} as const satisfies ValueSchemaSpec

/** The task fields a listing reports. */
const JOB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: 'Exact task id for later calls.' },
    expression: { type: 'string', required: true, description: 'The cron expression the task fires on.' },
    time_zone: { type: 'string', required: true, description: 'The IANA zone the expression is read in.' },
    enabled: { type: 'boolean', required: true, description: 'Whether the scheduler may fire the task.' },
    target: {
      type: 'object',
      additionalProperties: false,
      properties: TARGET_PROPERTIES,
    },
    prompt: { type: 'string', required: true, description: 'The message a firing delivers.' },
    overlap_policy: { type: 'string', required: true, enum: [...OVERLAP_POLICIES] },
    misfire_policy: { type: 'string', required: true, enum: [...MISFIRE_POLICIES] },
    max_run_ms: { type: 'integer', required: true, description: 'Ceiling on one run, in milliseconds.' },
    next_due_at: { type: 'string', required: true, description: 'Next occurrence, RFC 3339 in UTC.' },
    recent_runs: { type: 'array', required: true, items: RUN_SCHEMA },
  },
} as const satisfies ValueSchemaSpec

/** The failure branch every scheduled-task tool shares. */
const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true, const: false },
    code: {
      type: 'string',
      required: true,
      enum: [
        'cron_invalid_expression',
        'cron_invalid_time_zone',
        'cron_not_found',
        'cron_not_leader',
        'cron_run_in_progress',
      ],
    },
    message: { type: 'string', required: true },
  },
} as const satisfies ValueSchemaSpec

/** The task identity and next occurrence a creation or update stored. */
const STORED_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true, const: true },
        id: { type: 'string', required: true },
        next_due_at: { type: 'string', required: true, description: 'Next occurrence, RFC 3339 in UTC.' },
        enabled: { type: 'boolean', required: true },
      },
    },
    ERROR_SCHEMA,
  ],
} as const satisfies ValueSchemaSpec

/** The tasks one listing read. */
const LIST_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true, const: true },
        jobs: { type: 'array', required: true, items: JOB_SCHEMA },
      },
    },
    ERROR_SCHEMA,
  ],
} as const satisfies ValueSchemaSpec

/** The removal of one task. */
const DELETE_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true, const: true },
        id: { type: 'string', required: true },
        deleted: { type: 'boolean', required: true, const: true },
      },
    },
    ERROR_SCHEMA,
  ],
} as const satisfies ValueSchemaSpec

/** The run one immediate execution recorded. */
const RUN_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true, const: true },
        run: RUN_SCHEMA,
      },
    },
    ERROR_SCHEMA,
  ],
} as const satisfies ValueSchemaSpec

const CREATE_DESCRIPTION =
  'Create one scheduled task that runs unattended, without a conversation open. '
  + 'Supply the cron expression, the IANA time zone it is read in, the target, and the '
  + 'prompt the firing delivers. The task must name where it runs: a new-session target '
  + 'states the workspace, the agent preset, and the permission preset every run acts under, '
  + 'and a session target states the session every run continues. '
  + 'This requires a direct human request in the current turn and cannot be called from '
  + 'autonomous work. Every run is bounded by max_run_ms.'

const LIST_DESCRIPTION =
  'List every scheduled task with its exact id, expression, time zone, target, prompt, '
  + 'run ceiling, enabled state, next occurrence in UTC, and most recent runs.'

const UPDATE_DESCRIPTION =
  'Change one scheduled task by its exact id. Supply only the fields to replace: expression, '
  + 'time_zone, target, prompt, overlap_policy, misfire_policy, max_run_ms, or enabled. '
  + 'A target that creates a session must state its workspace, agent preset, and permission '
  + 'preset. This requires a direct human request in the current turn.'

const DELETE_DESCRIPTION =
  'Delete one scheduled task by the exact id returned by cron_create or cron_list. '
  + 'The task stops firing; its recorded runs are removed with it.'

const RUN_DESCRIPTION =
  'Run one scheduled task once, now, without changing its schedule. The task must exist and '
  + 'must have no run in flight. The result reports how that run ended; it does not move the '
  + 'next occurrence.'

/** Render one canonical value as the model-facing JSON text block. */
function renderValue(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

/** Pure pending card. */
function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/**
 * One instant as the model reads it.
 * @param epochMs - Milliseconds since the Unix epoch.
 * @returns The instant in RFC 3339 UTC.
 */
function rfc3339(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

/**
 * One stored target as the model reads it.
 * @param target - The stored target.
 * @returns The target fields, with only the ones it carries.
 */
function targetValue(target: CronTarget): TargetValue {
  if (target.kind === 'session') return { kind: 'session', session_id: target.sessionId }
  return {
    kind: 'new-session',
    workspace_path: target.workspacePath,
    agent_preset: target.agentPreset,
    permission_preset: target.permissionPreset,
    ...target.model === undefined ? {} : { model_provider: target.model.provider, model: target.model.model },
  }
}

/**
 * One finished run as the model reads it.
 * @param run - The stored run record.
 * @returns Its instants in RFC 3339 UTC and its outcome.
 */
function runValue(run: CronRunRecord): RunValue {
  return {
    started_at: rfc3339(run.startedAt),
    finished_at: rfc3339(run.finishedAt),
    outcome: run.outcome,
  }
}

/**
 * One stored task as the model reads it.
 * @param job - The stored task.
 * @returns Every field a management call reports.
 */
function jobValue(job: CronJob): JobValue {
  return {
    id: job.id,
    expression: job.expression,
    time_zone: job.timeZone,
    enabled: job.enabled,
    target: targetValue(job.target),
    prompt: job.prompt,
    overlap_policy: job.overlapPolicy,
    misfire_policy: job.misfirePolicy,
    max_run_ms: job.maxRunMs,
    next_due_at: rfc3339(job.nextDueAt),
    recent_runs: job.recentRuns.map(runValue),
  }
}

/**
 * Approve one config even when `apply` is called directly outside Loader normalization.
 * @param config - The config the caller supplied.
 * @returns The config with its default stated.
 */
function resolveConfig(config: Config): ResolvedConfig {
  const defaultMaxRunMs = config.defaultMaxRunMs ?? 600_000
  if (!Number.isSafeInteger(defaultMaxRunMs) || defaultMaxRunMs < 1) {
    throw new TypeError('defaultMaxRunMs must be a positive safe integer')
  }
  return { defaultMaxRunMs }
}

/**
 * Turn one provider refusal into the model-facing failure value.
 * @param code - The code from the closed {@link CronErrorCode} union.
 * @param message - The concrete condition behind the code.
 * @returns The failure branch every tool shares.
 */
function failure(code: CronErrorCode, message: string): CronFailure {
  return { ok: false, code, message }
}

/**
 * The failure branch for one provider refusal.
 *
 * Only the five states a provider can genuinely report reach the model as a
 * `{ ok: false, code }` value. Anything else — a malformed argument, or a throw
 * from outside the capability — is not a domain state, so it fails loud with
 * its own text rather than borrowing a code that means something else.
 * @param error - The value a provider raised.
 * @returns The failure branch, or a rethrow of a throw this union does not name.
 */
function providerFailure(error: unknown): CronFailure {
  if (error instanceof CronServiceError) return failure(error.code, error.message)
  throw error
}

/**
 * Refuse one argument the schema cannot express.
 * @param message - The concrete condition the caller must fix.
 * @returns Never; the registry turns the throw into an `isError` result.
 */
function invalidArgument(message: string): never {
  throw new Error(message)
}

/** Whether an optional text field carries a stated value rather than a schema filler. */
function hasText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0
}

/** Whether an optional number field carries a stated value rather than a schema filler. */
function hasPositive(value: number | undefined): value is number {
  return value !== undefined && value > 0
}

/**
 * Resolve the target one call states.
 *
 * A `new-session` target that leaves out what its unattended runs act as is a
 * malformed argument, not a stored-task state, so it fails loud.
 * @param args - The target fields the call supplied.
 * @returns The target to store.
 */
function resolveTarget(args: TargetArgs): CronTarget {
  if (args.kind === 'session') {
    if (!hasText(args.session_id)) {
      invalidArgument('a session target requires the session_id every run continues.')
    }
    return { kind: 'session', sessionId: args.session_id }
  }
  if (!hasText(args.workspace_path)) {
    invalidArgument('a new-session target requires workspace_path: the directory its runs work in.')
  }
  if (!hasText(args.agent_preset)) {
    invalidArgument('a new-session target requires agent_preset: the agent preset its runs are composed from.')
  }
  if (!hasText(args.permission_preset)) {
    invalidArgument(
      'a new-session target requires permission_preset: what its unattended runs may do without asking.',
    )
  }
  if (hasText(args.model_provider) !== hasText(args.model)) {
    invalidArgument('a new-session run model requires both model_provider and model, or neither.')
  }
  return {
    kind: 'new-session',
    workspacePath: args.workspace_path,
    agentPreset: args.agent_preset,
    permissionPreset: args.permission_preset,
    ...hasText(args.model_provider) && hasText(args.model)
      ? { model: { provider: args.model_provider, model: args.model } }
      : {},
  }
}

/**
 * The one place a model-stated id reaches the capability, so no call can
 * substitute a task nobody named.
 * @param id - The exact id the model stated.
 * @returns The same id as the capability's opaque identity.
 */
function jobId(id: string): CronJobId {
  return id as CronJobId
}

/**
 * Register the five scheduled-task tools.
 * @param ctx - The context carrying the cron capability, the tool registry, and the agent graph.
 * @param config - The deployment's run-ceiling policy.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cron_create',
    description: CREATE_DESCRIPTION,
    parameters: {
      expression: {
        type: 'string',
        required: true,
        description: 'Five-field cron expression, for example 0 9 * * 1-5, or an @hourly-family macro.',
      },
      time_zone: {
        type: 'string',
        required: true,
        description: 'IANA zone the expression is read in, for example Asia/Shanghai.',
      },
      target: TARGET_SCHEMA,
      prompt: {
        type: 'string',
        required: true,
        description: 'Message a firing delivers to the target session.',
      },
      max_run_ms: {
        type: 'integer',
        description: `Ceiling on one run in milliseconds; defaults to ${resolved.defaultMaxRunMs}.`,
      },
      overlap_policy: {
        type: 'string',
        enum: [...OVERLAP_POLICIES],
        description: 'What happens when a run is still going at the next occurrence; defaults to skip.',
      },
      misfire_policy: {
        type: 'string',
        enum: [...MISFIRE_POLICIES],
        description: 'What happens to occurrences missed while no scheduler ran; defaults to skip.',
      },
    },
    output: { schema: STORED_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec: ToolRunContext): Promise<CronJobStoredValue | CronFailure> {
      const execution = cronToolAuthority(ctx, exec)
      requireHumanAuthority(ctx, execution)
      if (!hasText(args.prompt)) {
        invalidArgument('prompt must be a non-empty message a firing delivers.')
      }
      const target = resolveTarget(args.target)
      const request: CronJobRequest = {
        expression: args.expression,
        timeZone: args.time_zone,
        target,
        prompt: args.prompt,
        maxRunMs: hasPositive(args.max_run_ms) ? args.max_run_ms : resolved.defaultMaxRunMs,
        ...args.overlap_policy === undefined ? {} : { overlapPolicy: args.overlap_policy },
        ...args.misfire_policy === undefined ? {} : { misfirePolicy: args.misfire_policy },
      }
      try {
        const job = await ctx.cron.create(request)
        return { ok: true, id: job.id, next_due_at: rfc3339(job.nextDueAt), enabled: job.enabled }
      } catch (error: unknown) {
        return providerFailure(error)
      }
    },
    presentCall: args => present('Create scheduled task', 'other', args.expression),
  })), 'tool-cron.create')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cron_list',
    description: LIST_DESCRIPTION,
    parameters: {},
    output: { schema: LIST_OUTPUT_SCHEMA, render: renderValue },
    execute(_args, exec: ToolRunContext): Promise<CronJobListValue | CronFailure> {
      cronToolAuthority(ctx, exec)
      try {
        return Promise.resolve({ ok: true, jobs: ctx.cron.list().map(jobValue) })
      } catch (error: unknown) {
        return Promise.resolve(providerFailure(error))
      }
    },
    presentCall: () => present('List scheduled tasks', 'read'),
  })), 'tool-cron.list')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cron_update',
    description: UPDATE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Exact task id returned by cron_create or cron_list.' },
      expression: { type: 'string', description: 'Replacement five-field cron expression.' },
      time_zone: { type: 'string', description: 'Replacement IANA zone the expression is read in.' },
      target: TARGET_PATCH_SCHEMA,
      prompt: { type: 'string', description: 'Replacement message a firing delivers.' },
      max_run_ms: { type: 'integer', description: 'Replacement ceiling on one run, in milliseconds.' },
      overlap_policy: { type: 'string', enum: [...OVERLAP_POLICIES] },
      misfire_policy: { type: 'string', enum: [...MISFIRE_POLICIES] },
      enabled: { type: 'boolean', description: 'Whether the scheduler may fire the task.' },
    },
    output: { schema: STORED_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec: ToolRunContext): Promise<CronJobStoredValue | CronFailure> {
      const execution = cronToolAuthority(ctx, exec)
      requireHumanAuthority(ctx, execution)
      if (!hasText(args.id)) {
        invalidArgument('id must be the exact task id returned by cron_create or cron_list.')
      }
      const target = args.target === undefined ? undefined : resolveTarget(args.target)
      const update: CronJobUpdate = {
        ...hasText(args.expression) ? { expression: args.expression } : {},
        ...hasText(args.time_zone) ? { timeZone: args.time_zone } : {},
        ...target === undefined ? {} : { target },
        ...hasText(args.prompt) ? { prompt: args.prompt } : {},
        ...hasPositive(args.max_run_ms) ? { maxRunMs: args.max_run_ms } : {},
        ...args.overlap_policy === undefined ? {} : { overlapPolicy: args.overlap_policy },
        ...args.misfire_policy === undefined ? {} : { misfirePolicy: args.misfire_policy },
        ...args.enabled === undefined ? {} : { enabled: args.enabled },
      }
      try {
        const job = await ctx.cron.update(jobId(args.id), update)
        return { ok: true, id: job.id, next_due_at: rfc3339(job.nextDueAt), enabled: job.enabled }
      } catch (error: unknown) {
        return providerFailure(error)
      }
    },
    presentCall: args => present('Update scheduled task', 'other', args.id),
  })), 'tool-cron.update')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cron_delete',
    description: DELETE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Exact task id returned by cron_create or cron_list.' },
    },
    output: { schema: DELETE_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec: ToolRunContext): Promise<CronDeleteValue | CronFailure> {
      cronToolAuthority(ctx, exec)
      try {
        const deleted = await ctx.cron.remove(jobId(args.id))
        if (!deleted) return failure('cron_not_found', `no scheduled task is stored under '${args.id}'.`)
        return { ok: true, id: args.id, deleted: true }
      } catch (error: unknown) {
        return providerFailure(error)
      }
    },
    presentCall: args => present('Delete scheduled task', 'other', args.id),
  })), 'tool-cron.delete')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'cron_run',
    description: RUN_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Exact task id returned by cron_create or cron_list.' },
    },
    output: { schema: RUN_OUTPUT_SCHEMA, render: renderValue },
    async execute(args, exec: ToolRunContext): Promise<CronRunValue | CronFailure> {
      cronToolAuthority(ctx, exec)
      try {
        return { ok: true, run: runValue(await ctx.cron.runNow(jobId(args.id))) }
      } catch (error: unknown) {
        return providerFailure(error)
      }
    },
    presentCall: args => present('Run scheduled task now', 'other', args.id),
  })), 'tool-cron.run')
}
