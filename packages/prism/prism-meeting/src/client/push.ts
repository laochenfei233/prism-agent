/**
 * Push one meeting question into the workspace: the page hands the question to
 * a fresh Session prompt and opens the Conversation on it, so answers come from
 * the agent that already holds the meeting tools.
 * @module @prism/prism-meeting/src/client/push
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the sessions and uiWorkspace Context merges this module calls.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** The meeting page's one-shot question pushed into a new Session. */
    meetingQuestion: unknown
  }
}

/** One question the page sends into a new Session. */
export interface MeetingQuestion {
  /** Durable meeting identity the agent reads through its meeting tools. */
  readonly meetingId: string
  readonly title: string
  readonly question: string
  /** Dictionary line naming the meeting and the question; `{title}`, `{id}`, and `{question}` are substituted. */
  readonly template: string
}

/**
 * Render the prompt the new Session receives.
 * @param request - meeting identity, title, question, and template.
 * @returns the complete user message text.
 */
export function meetingPrompt(request: MeetingQuestion): string {
  return request.template
    .replace('{title}', request.title)
    .replace('{id}', request.meetingId)
    .replace('{question}', request.question)
}

/**
 * Create a Session for one question, send it, and open the Conversation on it.
 * @param ctx - client root carrying `ctx.sessions` and `ctx.uiWorkspace`.
 * @param request - meeting identity, title, question, and prompt template.
 * @returns completion after the Session accepts the prompt and is selected.
 * @throws when Session creation or prompt admission fails; the created Session is left selected.
 */
export async function pushMeetingQuestion(ctx: Context, request: MeetingQuestion): Promise<void> {
  const workspace = ctx.workspaces.list.getSnapshot().items[0]
  const sessionId = await ctx.sessions.create(
    workspace === undefined ? {} : { workspaceId: workspace.workspaceId },
  )
  const reference = ctx.sessions.retain(sessionId, { source: 'meetingQuestion' })
  try {
    const binding = await reference.ready
    const admitted = await binding.session.prompt(
      [{ type: 'text', text: meetingPrompt(request) }],
      'queue',
    )
    if (!admitted.ok) throw new Error(admitted.error.message)
  } finally {
    reference.release()
  }
  ctx.uiWorkspace.openSession(sessionId)
}
