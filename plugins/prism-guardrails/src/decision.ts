/**
 * The bundle's own record of what its rails decided, and the identity of the
 * configuration that decided it.
 *
 * A rail's refusal is model-visible text and an approval is an approver's
 * reason, so a call a rail let through leaves nothing behind — and in `observe`
 * mode nothing is refused at all, so without this record the mode would have no
 * evidence of its own. The ledger is that evidence.
 *
 * It is deliberately in memory and per session: it answers "what did the rails
 * do in this session", which is the question an operator tuning a rail asks.
 * Nothing here survives the process, so it is not an audit log.
 *
 * @module prism-guardrails/decision
 */

import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Config, Mode } from './config.ts'

/**
 * How one rail resolved a call.
 *
 * `observed` is a `deny` or `ask` the deployment's mode downgraded to a record;
 * `steer` is a continuation the rail asked for and kept either way.
 */
export type DecisionOutcome = 'deny' | 'ask' | 'steer' | 'observed'

/** One decision, as `/guardrails` reports it. */
export interface Decision {
  /** The rail's report name, as `describeRails` prints it. */
  readonly rail: string
  /** What the rail did, or would have done under `enforce`. */
  readonly outcome: DecisionOutcome
  /** What the rail judged: a tool name, a written path, or a command's text. */
  readonly subject: string
  /** When the decision was recorded. */
  readonly at: number
}

/** Decisions one session keeps before its oldest is dropped. */
const MAX_DECISIONS = 200

/** The per-session record every rail writes and `/guardrails` reads. */
export interface DecisionLedger {
  /**
   * Record one decision for the session that owns the agent.
   * @param agent - the agent whose session is deciding; a call outside any
   * agent records nothing, because there is no session to report it under.
   * @param decision - the decision to append.
   */
  record(agent: Agent | undefined, decision: Decision): void
  /**
   * Read one session's decisions, oldest first.
   * @param agent - the agent whose session to read.
   * @returns the retained decisions; empty for a session that decided nothing.
   */
  list(agent: Agent | undefined): readonly Decision[]
}

/**
 * Create one ledger, owned by the plugin instance that installs the rails.
 *
 * @returns the ledger the rails write to and the status command reads.
 */
export function createLedger(): DecisionLedger {
  const byAgent = new WeakMap<Agent, Decision[]>()
  return {
    record(agent, decision) {
      if (agent === undefined) return
      const decisions = byAgent.get(agent)
      if (decisions === undefined) {
        byAgent.set(agent, [decision])
        return
      }
      decisions.push(decision)
      if (decisions.length > MAX_DECISIONS) decisions.shift()
    },
    list(agent) {
      return agent === undefined ? [] : [...byAgent.get(agent) ?? []]
    },
  }
}

/**
 * The identity of one deployment's rail configuration.
 *
 * It covers the settings a rail decision reads and nothing else, so a
 * conversation about a refusal can name the configuration that produced it.
 *
 * `mode` is normalized through the resolved value, so writing the default
 * explicitly hashes the same as omitting it. An edit that changes no behavior —
 * `repeatAskAfter: 0` against an omitted key — still moves the version, which
 * costs a report line rather than a wrong decision.
 *
 * @param config - the deployment's raw rail configuration.
 * @param mode - the resolved mode, which defaults an omitted key.
 * @returns the first eight hex characters of the configuration's digest.
 */
export function configVersion(config: Config, mode: Mode): string {
  return createHash('sha256').update(JSON.stringify(sortKeys({ ...config, mode }))).digest('hex').slice(0, 8)
}

/**
 * Deep key-sort of a configuration value, so two writings that differ only in
 * property order hash alike.
 *
 * @param value - any value from the deployment's configuration.
 * @returns the same value with every object's keys in sorted order.
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key])
  return sorted
}
