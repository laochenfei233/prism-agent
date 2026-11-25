/**
 * The Team entry in the session header, beside the subagent and background-job
 * chips, and the panel it opens.
 *
 * The chip is always present; the panel loads on first open, so an ordinary
 * session costs one request only when somebody looks.
 *
 * @module prism-team/client/TeamAction
 */

import { useRef, useState } from 'react'
import type { TeamPanelValue } from '../panel-contract.ts'
import type { TeamKey } from './locales.ts'
import { styles } from './styles.ts'
import { TeamPanel } from './TeamPanel.tsx'

/** What the plugin injects into the header entry. */
export interface TeamActionInjected {
  /** Read the panel for the session this header belongs to. */
  readonly load: (signal: AbortSignal) => Promise<TeamPanelValue>
  /** Localized copy for this entry. */
  readonly t: (key: TeamKey) => string
}

/**
 * Render the header entry and, when opened, the team panel.
 *
 * @param props - the injected read and copy.
 * @returns the chip and its panel.
 */
export function TeamAction(props: TeamActionInjected) {
  const { t } = props
  const trigger = useRef<HTMLButtonElement>(null)
  const [placement, setPlacement] = useState<{ readonly top: number; readonly right: number }>()

  return (
    <span style={styles.anchor}>
      <button
        ref={trigger}
        type="button"
        style={styles.chip}
        aria-expanded={placement !== undefined}
        aria-label={t('view.team')}
        onClick={() => {
          if (placement !== undefined) {
            setPlacement(undefined)
            return
          }
          const rect = trigger.current?.getBoundingClientRect()
          if (rect === undefined) return
          setPlacement({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
        }}
      >
        {t('view.team')}
      </button>
      {placement === undefined ? null : (
        <div
          role="dialog"
          aria-label={t('view.team')}
          style={{ ...styles.popover, top: placement.top, right: placement.right }}
        >
          <TeamPanel load={props.load} t={props.t} />
        </div>
      )}
    </span>
  )
}
