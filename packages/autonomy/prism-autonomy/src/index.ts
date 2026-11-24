/**
 * Prism autonomy: under the configured permission preset (shipped as
 * `autonomous-guarded`, `workspace-write` + `ask`), approval requests are
 * answered automatically through the approval seam instead of reaching the
 * client's approval card. Deny rails are unaffected — they never produce an
 * ask — and the configured require-human matchers (shipped default: sandbox
 * escalations) still hand their requests to the human. Every auto-answer
 * keeps the approval audit pair, so the log reads like any other decision.
 *
 * The engaging preset is a permission-presets preset: switching runs through
 * the existing `/permission` command and Settings picker. The session's
 * current preset folds from the durable `permission/preset` events into a
 * session projection, so the derived state survives reload and restart. A
 * live switch to or from the preset injects one model-facing notice.
 *
 * @module @prism/prism-autonomy
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { z as zod } from 'zod'
import { Config, requiresHuman, type RequireHumanMatcher } from './config.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'prism-autonomy': { kind: 'prism-autonomy' } & ContextFormed
  }
}

/** The projected autonomy state: the session's current permission preset. */
interface AutonomyState {
  /** Last seen `permission/preset` payload; null before any preset event. */
  preset: string | null
}

const autonomyStateSchema: zod.ZodType<AutonomyState> = zod.object({
  preset: zod.string().nullable(),
})

/** One-event autonomy-state transition (the projection's `apply`). */
function applyAutonomyEvent(state: AutonomyState, event: SessionEvent): AutonomyState {
  if (event.type === 'permission/preset') {
    return state.preset === event.data.preset ? state : { ...state, preset: event.data.preset }
  }
  return state
}

const autonomyStateDefinition = {
  key: 'autonomy',
  stateVersion: 1,
  stateSchema: autonomyStateSchema,
  init: (): AutonomyState => ({ preset: null }),
  apply: applyAutonomyEvent,
} satisfies ProjectionDefinition<'autonomy', AutonomyState>

/** Model-facing notice injected on a live switch into the autonomous preset. */
const ENGAGED_NOTICE = 'Autonomous approvals are on for this session: approval requests are granted automatically, except sandbox escalations, which still ask the user. Denial rules still apply — do not request sandbox escalation without evidence of a denial.'
/** Model-facing notice injected on a live switch back to a manual preset. */
const DISENGAGED_NOTICE = 'Autonomous approvals are off for this session: approval requests are routed to the user again.'

/**
 * Owns the autonomous answering policy: derives the session's engagement from
 * its current permission preset, answers the approval requests that stay
 * autonomous, and notifies the model on live switches. Requires the
 * permission-presets service (the preset catalog validates the configured
 * preset) and the agents registry (notice routing).
 */
export class PrismAutonomyService extends Service {
  static inject = ['sessionProjections', 'permissionPresets', 'agents']

  static Config = Config

  private handle: ProjectionHandle<AutonomyState> | undefined
  /** Live engagement per session id, seeded at agent creation, for change detection. */
  private readonly engaged = new Map<string, boolean>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'prism-autonomy')
  }

  protected async [Service.init](): Promise<void> {
    // Registration can finish after an unload has started. Do not add effects then.
    if (this.ctx.fiber.uid === null) return
    if (!this.ctx.permissionPresets.names.includes(this.config.preset)) {
      throw new Error(`prism-autonomy: preset "${this.config.preset}" is not in the permission-presets catalog (known: ${this.ctx.permissionPresets.names.join(', ')})`)
    }
    this.handle = await this.ctx.sessionProjections.register(autonomyStateDefinition)

    for (const agent of this.ctx.agents.list()) {
      this.seedEngagement(agent.session)
    }
    // Registered after permission-presets' prepinned pinning listener, so the
    // creation-time preset event is already folded when this reads it.
    this.ctx.on('agent/created', ({ agent }) => {
      this.seedEngagement(agent.session)
    })
    this.ctx.on('session/event', (session, event) => {
      this.onSessionEvent(session, event)
    })
    this.ctx.on('approval/request', (request, next) => this.answer(request, next), { prepend: true })
  }

  /**
   * Record the session's current engagement without notifying: creation and
   * restore establish the baseline the first live switch is measured against.
   * @param session - the session whose preset folds into the baseline.
   */
  private seedEngagement(session: Session): void {
    const state = this.handle?.stateOf(session)
    if (state === undefined) return
    this.engaged.set(session.id, state.preset === this.config.preset)
  }

  /**
   * React to one committed session event: a live preset switch that changes
   * the engagement injects exactly one model-facing notice. Replay never
   * reaches here — `session/event` fires for live appends only.
   * @param session - the session the event committed to.
   * @param event - the committed event.
   */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type !== 'permission/preset') return
    const engaged = event.data.preset === this.config.preset
    const previous = this.engaged.get(session.id)
    this.engaged.set(session.id, engaged)
    if (previous === undefined || previous === engaged) return
    const agent = this.ctx.agents.get(session.id)
    agent?.inject(createUserMessage({
      content: [{ type: 'text', text: engaged ? ENGAGED_NOTICE : DISENGAGED_NOTICE }],
      source: { kind: 'prism-autonomy' },
    }))
  }

  /**
   * Answer one approval request under the autonomy policy: outside the
   * engaging preset, or on a require-human match, the request delegates to
   * the composed answerers (the client card); otherwise it is granted.
   * @param request - the pending approval request.
   * @param next - delegates to the remaining answerer chain.
   * @returns the closed outcome for the request.
   */
  private answer(
    request: { readonly agent: Agent; readonly toolName: string; readonly reason?: string },
    next: () => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>,
  ): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> {
    const state = this.handle?.stateOf(request.agent.session)
    if (state?.preset !== this.config.preset) return next()
    if (requiresHuman(request.toolName, request.reason, this.config.requireHuman as readonly RequireHumanMatcher[])) return next()
    return Promise.resolve('allowed-once')
  }
}

export default PrismAutonomyService
