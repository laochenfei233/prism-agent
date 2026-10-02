/**
 * Unattended authority for the scheduled-task tools.
 *
 * A task spends resources while nobody is present, so the tool that creates or
 * re-points one requires the authority the shipped model-facing goal tools own:
 * an exact live root Agent inside its active driver, whose open turn carries a
 * host-attested human message. Reusing that implementation keeps one reading of
 * the turn boundary rather than a second one that could drift.
 * @module @deepseek-ai/dsh-tool-cron/authority
 */

import type { Context } from '@deepseek-ai/cordis'
import { goalToolExecution, requireDirectHuman } from '@deepseek-ai/dsh-tool-goal'
import type { GoalToolExecution } from '@deepseek-ai/dsh-tool-goal'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

/**
 * Authenticate the calling Agent and its open turn.
 *
 * A call without a live root Agent inside its driver — an autonomous
 * continuation, a subagent, or a nested caller — reaches no authority at all.
 * @param ctx - Context carrying the live agent registry and the turn-boundary projection.
 * @param exec - Tool execution metadata supplied by the registry.
 * @returns The authenticated agent, immutable event cut, and open-turn boundary.
 */
export function cronToolAuthority(ctx: Context, exec: ToolRunContext): GoalToolExecution {
  return goalToolExecution(ctx, exec)
}

/**
 * Require a direct human message in the live root-agent turn.
 * @param ctx - Context carrying the live agent graph.
 * @param execution - Authenticated current tool execution.
 */
export function requireHumanAuthority(ctx: Context, execution: GoalToolExecution): void {
  requireDirectHuman(ctx, execution, 'this scheduled-task operation')
}
