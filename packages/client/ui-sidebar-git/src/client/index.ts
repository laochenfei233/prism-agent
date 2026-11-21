// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
/**
 * Browser half: register `git` as a right-Sidebar tab type.
 *
 * The public two-stage path: the type into `ctx.sidebarRightTabs`, the body
 * into the keyed `sidebar.right.pane.tab` seat and the chip title into the
 * keyed `sidebar.right.pane.tab.title` seat, both under the type's `id`.
 * The Host half that serves the routes lives in `src/index.ts`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { GIT_ID, gitDefinition } from './definition.tsx'
import { createGitFace, type GitFetch } from './face.ts'
import { GitBody } from './GitBody.tsx'
import { GitTitle } from './GitTitle.tsx'
import { en, zh } from './locales.ts'
import { createGitStore } from './store.ts'

export type { SidebarGitKey } from './locales.ts'

/** This package's copy namespace. */
const NS = 'sidebarGit'

/** Required browser services: the tab registry, the keyed seats, and copy. */
export const inject = ['slots', 'locale', 'sidebarRightTabs']

/**
 * Client plugin body: register the type, its dictionaries, its body, and its chip title.
 * @param ctx - client root context carrying the registry and the slots.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.sidebarRightTabs.register(gitDefinition(t)), 'ui-sidebar-git: type')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar-git: dictionaries')
  const store = createGitStore()
  const fetchImpl: GitFetch = (input, init) => globalThis.fetch(input, init)
  const face = createGitFace(fetchImpl)
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: GIT_ID, locale: NS, store, inject: face },
    GitBody,
  )), 'ui-sidebar-git: body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: GIT_ID },
    GitTitle,
  )), 'ui-sidebar-git: title')
}
