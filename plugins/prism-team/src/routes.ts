/**
 * Route paths of the team panel, shared by both faces.
 *
 * Absolute, so a document served below the root still reaches them; the Host
 * registers the path on Connection's shared `/api` channel.
 *
 * @module prism-team/routes
 */

/** The one read: roster, tasks, and reports for the team a session belongs to. */
export const TEAM_PANEL_PATH = '/api/prism-team/panel'
