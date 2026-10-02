// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
import type { IconProps } from './icons/props.ts'

/** Edge of the rounded-square {@link PrismBadgeLogo} viewBox in user units. */
export const PRISM_BADGE_VIEWBOX = 24

const PRISM_RING_PATH = 'M12 2 L20.66 7 L20.66 17 L12 22 L3.34 17 L3.34 7 Z'
const PRISM_SPOKE_PATH =
  'M12 12 L12 2 M12 12 L20.66 7 M12 12 L20.66 17 M12 12 L12 22 M12 12 L3.34 17 M12 12 L3.34 7'
const PRISM_RING_NODES: readonly (readonly [number, number])[] = [
  [12, 2], [20.66, 7], [20.66, 17], [12, 22], [3.34, 17], [3.34, 7],
]

const PRISM_BADGE_MARK_SCALE = 0.82

/**
 * Render the Prism badge: a white rounded square carrying the black
 * hexagonal lattice used by the desktop application icon.
 * @param props.size - square edge in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the badge svg (aria-hidden; pair it with a wordmark for accessibility).
 */
export function PrismBadgeLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox={`0 0 ${PRISM_BADGE_VIEWBOX} ${PRISM_BADGE_VIEWBOX}`}
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="0.5"
        y="0.5"
        width="23"
        height="23"
        rx="5.5"
        fill="#FFFFFF"
        stroke="#E5E7EB"
        strokeWidth="0.8"
      />
      <g
        transform={`translate(12 12) scale(${PRISM_BADGE_MARK_SCALE}) translate(-12 -12)`}
        fill="none"
        stroke="#111827"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={PRISM_RING_PATH} />
        <path d={PRISM_SPOKE_PATH} />
      </g>
      <g transform={`translate(12 12) scale(${PRISM_BADGE_MARK_SCALE}) translate(-12 -12)`} fill="#111827">
        <circle cx="12" cy="12" r="3.2" />
        {PRISM_RING_NODES.map(([cx, cy]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.6" />
        ))}
      </g>
    </svg>
  )
}
