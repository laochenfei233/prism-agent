/**
 * Browser half: registers the archived-projects settings section and its
 * dictionaries.
 *
 * The section reads the client Workspace and Session snapshots and restores a
 * project through the Workspace navigation; it needs no Host call of its own.
 * @module prism-session-autoarchive/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { IconArchiveOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { createArchivedProjectsSection, type ArchivedProjectsSectionContext } from './ArchivedProjectsSection.tsx'
import { en, NS, zh } from './locales.ts'

export { NS }
export { archivedWorkspaceRows } from './rows.ts'
export type { ArchivedWorkspaceRow, ArchivedWorkspacesInput } from './rows.ts'
export { when } from './rows.ts'
export type { ArchivedProjectsSectionProps } from './ArchivedProjectsSection.tsx'

/** Services required by the browser half. */
export const inject = ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace']

/**
 * The shell seats this half registers through. Declared structurally because
 * an out-of-tree bundle compiles without the shell's client packages.
 */
interface ShellSeats {
  readonly slots: {
    inject(name: 'settings.section', register: () => () => void): void
    register(
      seat: { name: 'settings.section'; id: string; order: number; label: () => string; locale: string },
      component: (props: { close: () => void; t: (key: string, params?: Record<string, string | number>) => string }) => unknown,
    ): () => void
    inject(name: 'settings.section.icon', register: () => () => void): void
    register(
      seat: { name: 'settings.section.icon'; id: string; locale: string },
      component: (props: { size: number; active: boolean }) => unknown,
    ): () => void
  }
  readonly locale: {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): () => void
    bind(namespace: string): (key: string, params?: Record<string, string | number>) => string
  }
}

/** Nav glyph for the archived-projects section; the shell keeps its gear fallback without this seat. */
function ArchivedProjectsNavIcon({ size }: { size: number; active: boolean }) {
  return <IconArchiveOutlineMedium size={size} />
}

/**
 * Register the archived-projects page.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  const seats = ctx as unknown as Context & ShellSeats & ArchivedProjectsSectionContext
  ctx.effect(() => seats.locale.register(NS, { zh, en }), 'prism-session-autoarchive: project dictionaries')
  const t = seats.locale.bind(NS)
  const Section = createArchivedProjectsSection(seats)
  seats.slots.inject('settings.section', () => seats.slots.register({
    name: 'settings.section',
    id: 'archived-projects',
    order: 45,
    label: () => t('nav'),
    locale: NS,
  }, Section))
  seats.slots.inject('settings.section.icon', () => seats.slots.register({
    name: 'settings.section.icon',
    id: 'archived-projects',
    locale: NS,
  }, ArchivedProjectsNavIcon))
}
