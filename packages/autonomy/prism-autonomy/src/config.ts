/**
 * The autonomy plugin's deployment policy: which permission preset engages
 * autonomous answering, and which approval requests stay with a human. Both
 * fields are deployment-static (patch-set), not settings-editable.
 * @module @prism/prism-autonomy/config
 */

import z from '@deepseek-ai/schemastery'

/** The permission preset that engages autonomous answering. */
export const DEFAULT_PRESET = 'autonomous-guarded'

/**
 * Default require-human matchers: a sandbox escalation widens the session's
 * confinement for one call, so it stays a human decision even under autonomy.
 * The prefix is the approval reason the sandbox seam writes
 * (`escalate sandbox to <mode>: <sentence>`).
 */
export const DEFAULT_REQUIRE_HUMAN: readonly RequireHumanMatcher[] = [
  { reasonPrefix: 'escalate sandbox to' },
]

/** One require-human rule: a request matching every set field stays with the human. */
export interface RequireHumanMatcher {
  /** Match the asking tool's name; unset matches every tool. */
  readonly tool?: string
  /** Match the asker's reason by prefix; unset matches every reason. */
  readonly reasonPrefix?: string
}

/** The autonomy plugin's configuration as the plugin receives it. */
export interface Config {
  /** The permission preset that engages autonomous answering. */
  readonly preset: string
  /** Requests matching any matcher keep their human decision; the rest auto-answer. */
  readonly requireHuman: readonly RequireHumanMatcher[]
}

/** The plugin's configuration schema. */
export const Config = z.object({
  preset: z.string().default(DEFAULT_PRESET),
  requireHuman: z.array(z.object({
    tool: z.string(),
    reasonPrefix: z.string(),
  })).default([...DEFAULT_REQUIRE_HUMAN.map(matcher => ({ ...matcher }))]),
})

/**
 * Whether one approval request hits a require-human matcher. A matcher matches
 * when every set field matches; an empty matcher list never requires a human.
 * @param toolName - the asking tool's name.
 * @param reason - the asker's human-readable reason, when provided.
 * @param matchers - the configured require-human rules.
 * @returns true when the request must keep its human decision.
 */
export function requiresHuman(
  toolName: string,
  reason: string | undefined,
  matchers: readonly RequireHumanMatcher[],
): boolean {
  return matchers.some((matcher) => {
    if (matcher.tool !== undefined && matcher.tool !== toolName) return false
    if (matcher.reasonPrefix !== undefined && !(reason ?? '').startsWith(matcher.reasonPrefix)) return false
    return true
  })
}
