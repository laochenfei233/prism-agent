/**
 * Wire types shared by the Host route and the browser panel.
 *
 * @module prism-team/panel-contract
 */

/** One report row the panel renders. */
export interface TeamPanelReport {
  /** Member that produced the row. */
  readonly name: string
  /** Reported status, or `observed` for a write the scope check let through. */
  readonly status: string
  /** What the member reported, or the path a write touched. */
  readonly summary: string
  /** Task the report names, when it names one. */
  readonly taskId?: string
}

/** One roster row. */
export interface TeamPanelMember {
  /** Model-facing member name. */
  readonly name: string
  /** Team role. */
  readonly role: 'lead' | 'teammate'
  /** Live status; `inactive` means no turn is executing. */
  readonly status: string
}

/** One shared task row. */
export interface TeamPanelTask {
  /** Team-local task identity. */
  readonly id: string
  /** Task title. */
  readonly subject: string
  /** Task state. */
  readonly status: string
  /** Owner name, when the task has one. */
  readonly ownerName?: string
  /** Whether every blocker is complete. */
  readonly ready: boolean
}

/** One panel response. */
export interface TeamPanelValue {
  /** Team brand, or the requested session when the session is not on a team. */
  readonly team: string
  /** Whether a live Agent answered the roster and task reads. */
  readonly live: boolean
  /** Roster rows, empty when the team is not live. */
  readonly members: readonly TeamPanelMember[]
  /** Task rows, empty when the team is not live. */
  readonly tasks: readonly TeamPanelTask[]
  /** Every report this team recorded, oldest first. */
  readonly reports: readonly TeamPanelReport[]
  /** The team projection's first rejected record, when it reported one. */
  readonly failure?: string
}
