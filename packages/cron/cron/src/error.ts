/**
 * The typed refusal a cron operation reports for an expected state.
 *
 * The code comes from the closed {@link CronErrorCode} union in
 * {@link ./types.ts}, so a consumer branches on a stable value instead of
 * matching a message, and a refusal outside that union is a defect rather than
 * a state a caller handles.
 * @module @deepseek-ai/dsh-cron/error
 */

import type { CronErrorCode } from './types.ts'

/** A cron operation refused by a state this process can answer for. */
export class CronServiceError extends Error {
  /**
   * @param code - the closed code the caller branches on.
   * @param reason - the concrete condition behind the code.
   */
  constructor(readonly code: CronErrorCode, reason: string) {
    super(reason)
    this.name = 'CronServiceError'
  }
}
