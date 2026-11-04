/**
 * Browser access to the team panel route.
 *
 * @module prism-team/client/api
 */

import type { TeamPanelValue } from '../panel-contract.ts'
import { TEAM_PANEL_PATH } from '../routes.ts'

/**
 * Read one session's team panel.
 *
 * @param sessionId - the session the open panel belongs to; the Host maps it to its team.
 * @param signal - caller cancellation.
 * @returns the roster, tasks, and reports the Host holds.
 */
export async function loadTeamPanel(sessionId: string, signal: AbortSignal): Promise<TeamPanelValue> {
  const response = await fetch(TEAM_PANEL_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
    signal,
  })
  if (!response.ok) throw new Error(`team panel: HTTP ${String(response.status)}`)
  return await response.json() as TeamPanelValue
}
