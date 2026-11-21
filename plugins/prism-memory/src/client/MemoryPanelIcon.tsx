/**
 * The sidebar's memory entry glyph: a stored-corpus cylinder, distinct from the
 * Meetings and Schedules glyphs. The sidebar owns the button, the label, and the
 * selected state around it; this entry supplies the drawing only.
 */

import type { ReactNode } from 'react'

/** The size the sidebar asks an entry glyph to render at. */
interface PanelIconProps {
  /** Edge length in pixels. */
  readonly size: number
}

/**
 * Render the memory glyph.
 * @param props - the requested edge length.
 * @returns the icon element.
 */
export function MemoryPanelIcon({ size }: PanelIconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <ellipse cx="8" cy="4" rx="5" ry="2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M3 4v3.4c0 1.1 2.24 2 5 2s5-.9 5-2V4M3 7.4V10.8c0 1.1 2.24 2 5 2s5-.9 5-2V7.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}
