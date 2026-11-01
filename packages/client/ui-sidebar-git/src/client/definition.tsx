// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
/**
 * Stage one of this package's registration: what the `git` tab type IS.
 *
 * The type is a page, not a viewer: it claims no address. The guide page
 * offers it as an entry box between the file tree and the terminal.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from './locales.ts'

/** The tab kind this package owns. */
export const GIT_KIND = 'git'

/** This implementation's identity in the tab system, and the key its body registers under. */
export const GIT_ID = '@deepseek-ai/dsh-client-ui-sidebar-git'

/**
 * The changes type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function gitDefinition(t: TranslateNS<'sidebarGit'>): SidebarRightTabDefinition {
  return {
    id: GIT_ID,
    kind: GIT_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [{
      id: 'changes',
      order: 15,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: IconBranchOutlineRegular,
    }],
  }
}
