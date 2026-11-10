/**
 * Bridges subagent activation lifecycles into the background-job registry: one
 * `subagent`-kind job per parent-delivered activation epoch, so the same
 * `job_list` / `job_kill` controls that govern shell and workflow background
 * work also govern delegations. The child's answer itself is not carried by the
 * job — the subagent settlement notice already reports it to the delegating
 * parent — and `dsh-tool-jobs` suppresses its completion notice for this kind.
 * @module @prism/prism-subagent-jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SubagentRunEndInfo, SubagentRunId, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-subagent'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    subagent: 'subagent'
  }
}

export const name = 'subagent-jobs'
export const inject = ['subagents', 'jobs']

/**
 * Map a terminal subagent stop reason onto a job outcome. {@link SubagentStopReason}
 * is merge-extensible, so unnameable backend variants land in the documented default.
 * @param info - the settled epoch's terminal edge.
 * @returns the registry outcome; `result` stays unset because the settlement
 *   notice already carried the child's answer to the owner.
 */
function outcomeOf(info: SubagentRunEndInfo): JobOutcome {
  switch (info.stopReason) {
    case 'completed':
      return { status: 'completed' }
    case 'aborted':
      return { status: 'killed', detail: info.stopReason }
    default:
      return { status: 'failed', detail: info.stopReason }
  }
}

/**
 * Register the lifecycle listeners that mirror delegations into `ctx.jobs`.
 * Caller-delivered activations — the workflow engine's internal plumbing, whose
 * result never reaches a parent session — produce no job, so the tool-jobs
 * notice suppression is always correct.
 *
 * Registration requires a job controller (load `@deepseek-ai/dsh-tool-jobs` in
 * the owning composition); without one, `ctx.jobs.start` rejects and the
 * lifecycle emitter logs the containment warning — delegation itself is unaffected.
 *
 * @param ctx - context carrying the subagent service and the job registry.
 */
export function apply(ctx: Context): void {
  /** Start-to-terminal pairing by activation epoch, deleted on the end edge. */
  const epochs = new Map<SubagentRunId, (outcome: JobOutcome) => void>()

  ctx.effect(() => ctx.on('subagent/start', (info: SubagentRunInfo) => {
    if (info.delivery === 'caller') return
    let settle!: (outcome: JobOutcome) => void
    const done = new Promise<JobOutcome>((resolve) => { settle = resolve })
    epochs.set(info.runId, settle)
    try {
      ctx.jobs.start({
        kind: 'subagent',
        label: `${info.provider} subagent ${info.id}`,
        owner: info.parentId,
        run: () => ({
          // The job-owner fence already proved the killer is the delegating
          // session, so the human-parent authority names that same session.
          cancel: () => {
            ctx.subagents.interrupt(info.id, { kind: 'user', parentSessionId: info.parentId })
          },
          done,
        }),
      })
    } catch (error: unknown) {
      epochs.delete(info.runId)
      throw error
    }
  }))

  ctx.effect(() => ctx.on('subagent/end', (info: SubagentRunEndInfo) => {
    const settle = epochs.get(info.runId)
    if (settle === undefined) return
    epochs.delete(info.runId)
    settle(outcomeOf(info))
  }))
}
