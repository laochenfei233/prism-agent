/**
 * Scenario setup for the capability end-to-end run: the state a rail needs that
 * the model cannot reach by itself.
 *
 * Both switches are environment-driven so one fixture serves every scenario,
 * and both fail loud: a scenario that asks for state the composition cannot
 * provide must not silently pass for the wrong reason.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PlanModeController } from '@deepseek-ai/dsh-plan-mode'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'

export const name = 'capability-scenario'
export const inject = ['agents']

/** Enter plan mode and/or register a user-only skill for each agent as it is created. */
export function apply(ctx: Context): void {
  const enterPlanMode = process.env['PRISM_GUARDRAILS_PLAN'] === '1'
  const userOnlySkill = process.env['PRISM_GUARDRAILS_USER_ONLY_SKILL']
  if (!enterPlanMode && userOnlySkill === undefined) return

  ctx.on('agent/created', ({ agent }) => {
    if (enterPlanMode) {
      const planMode = ctx.get('planMode') as PlanModeController | undefined
      if (planMode === undefined) throw new Error('capability-scenario: the composition mounts no plan-mode service')
      // No turn is open at creation, so the selection commits immediately.
      planMode.set(agent, true)
    }
    if (userOnlySkill !== undefined) {
      const skills = ctx.get('skills') as SkillRegistry | undefined
      if (skills === undefined) throw new Error('capability-scenario: the composition mounts no skill service')
      skills.register({
        name: userOnlySkill,
        description: 'Registered by the capability scenario.',
        source: 'runtime',
        content: 'Scenario body.',
        invocation: { modelInvocable: false, userInvocable: true },
      })
    }
  })
}
