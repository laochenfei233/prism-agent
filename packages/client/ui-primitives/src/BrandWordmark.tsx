import type { IconProps } from './icons/props.ts'
import { PrismLogo } from './PrismLogo.tsx'

/** Display options for the brand wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Product name the artwork spells out; the owning feature supplies it from its locale dictionary. */
  name: string
  /** Whether to include the leading Prism mark; defaults to true. */
  includeMark?: boolean | undefined
}

/** Edge of the wordmark's design box in user units (the `size` prop is exactly this height). */
const WORDMARK_HEIGHT = 24

/** Left edge of the name text, leaving room for the mark and its gap. */
const NAME_LEFT = 34

/** Tracked-out advance per character, giving every name a deterministic artwork width. */
const NAME_ADVANCE = 11.2

/** Inset and scale placing the Prism mark inside the design box. */
const MARK_INSET = 2.4
const MARK_SCALE = 0.8

/**
 * Render the brand wordmark: the Prism mark followed by the product name set in
 * tracked capitals. The name is measured as {@link NAME_ADVANCE} per character
 * and forced to that width, so the artwork keeps a fixed width whatever font
 * the platform resolves.
 * @param props.name - product name to spell out.
 * @param props.size - artwork height in px (default 24; width follows the name length).
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading Prism mark.
 * @returns the wordmark svg (aria-hidden decorative brand art).
 */
export function BrandWordmark({ name, size = 24, className, includeMark = true }: BrandWordmarkProps) {
  // Rounded to hundredths so the viewBox never carries float noise.
  const nameWidth = Math.round(Math.max(name.length, 1) * NAME_ADVANCE * 100) / 100
  const artworkWidth = includeMark ? NAME_LEFT + nameWidth : nameWidth
  return (
    <svg
      width={(size * artworkWidth) / WORDMARK_HEIGHT}
      height={size}
      className={className}
      viewBox={includeMark
        ? `0 0 ${artworkWidth} ${WORDMARK_HEIGHT}`
        : `${NAME_LEFT} 0 ${nameWidth} ${WORDMARK_HEIGHT}`}
      fill="none"
      aria-hidden="true"
    >
      {includeMark && (
        <g transform={`translate(${MARK_INSET} ${MARK_INSET}) scale(${MARK_SCALE})`}>
          <PrismLogo size={WORDMARK_HEIGHT} />
        </g>
      )}
      <text
        x={NAME_LEFT}
        y="17.2"
        textLength={nameWidth}
        lengthAdjust="spacing"
        fontSize="16.5"
        fontWeight="600"
        fill="currentColor"
      >
        {name}
      </text>
    </svg>
  )
}
