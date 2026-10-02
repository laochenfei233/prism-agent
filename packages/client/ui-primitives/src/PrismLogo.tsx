// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
import type { IconProps } from './icons/props.ts'

/** Edge of the square {@link PrismLogo} viewBox in user units. */
export const PRISM_LOGO_VIEWBOX = 24

/**
 * Hexagon ring of the Prism mark: the six pointy-top vertices of a hexagon
 * with circumradius 10 around the centre (12, 12).
 */
const PRISM_RING_PATH = 'M12 2 L20.66 7 L20.66 17 L12 22 L3.34 17 L3.34 7 Z'

/** Six spokes joining the centre node to the ring vertices. */
const PRISM_SPOKE_PATH =
  'M12 12 L12 2 M12 12 L20.66 7 M12 12 L20.66 17 M12 12 L12 22 M12 12 L3.34 17 M12 12 L3.34 7'

/** The six ring vertices, each carrying an outer node. */
const PRISM_RING_NODES: readonly (readonly [number, number])[] = [
  [12, 2], [20.66, 7], [20.66, 17], [12, 22], [3.34, 17], [3.34, 7],
]

/* Weights chosen for legibility down to a 16px sidebar rail: the ring, spokes,
   and nodes must still read as one lattice after rasterization, so the line
   weight is deliberately close to the node diameter. */
/** Ring and spoke line weight in viewBox units. */
const PRISM_STROKE = 2.4
/** Radius of each of the six outer nodes. */
const PRISM_RING_NODE_RADIUS = 2.6
/** Radius of the centre node. */
const PRISM_CENTER_NODE_RADIUS = 3.2

/**
 * Render the Prism mark: a hexagonal lattice of one centre node, six ring
 * nodes, and the spokes and ring that join them. Every part is
 * `currentColor`, so the mark adopts the ink of the surface it sits on.
 * @param props.size - square edge in px (default 24).
 * @param props.className - extra class for layout placement.
 * @returns the mark svg (aria-hidden; pair it with a wordmark for accessibility).
 */
export function PrismLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox={`0 0 ${PRISM_LOGO_VIEWBOX} ${PRISM_LOGO_VIEWBOX}`}
      fill="none"
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth={PRISM_STROKE} strokeLinecap="round" strokeLinejoin="round">
        <path d={PRISM_RING_PATH} />
        <path d={PRISM_SPOKE_PATH} />
      </g>
      <g fill="currentColor">
        <circle cx="12" cy="12" r={PRISM_CENTER_NODE_RADIUS} />
        {PRISM_RING_NODES.map(([cx, cy]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={PRISM_RING_NODE_RADIUS} />
        ))}
      </g>
    </svg>
  )
}
