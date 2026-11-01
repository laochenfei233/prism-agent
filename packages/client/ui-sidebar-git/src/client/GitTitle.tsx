// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
/**
 * The changes type's chip title: the branch glyph before the type's label.
 * Registered under `sidebar.right.pane.tab.title`; without it the chip would
 * show the bare label.
 */
import type { ReactNode } from 'react'
import { IconBranchOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'

/** The title's props, narrowed to the member it reads so a test can supply it directly. */
export interface GitTitleProps {
  /** The framework's tab seat for this title. */
  useTabInfo: () => { tab: { title: string } }
}

/**
 * The title as the chip and a floating panel's header show it.
 * @param props - the tab information hook.
 * @returns the branch glyph followed by the tab's title text.
 */
export function GitTitle({ useTabInfo }: GitTitleProps): ReactNode {
  const { tab } = useTabInfo()
  return (
    <>
      <IconBranchOutlineRegular size={16} />
      {tab.title}
    </>
  )
}
