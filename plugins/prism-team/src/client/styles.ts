/**
 * Presentation styles for the team panel.
 *
 * Token-free on purpose: every color resolves from the inherited text color, so
 * the panel follows whichever theme the shell applies without naming an alias.
 *
 * @module prism-team/client/styles
 */

import type { CSSProperties } from 'react'

/** Shared style objects the panel uses. */
export const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    font: 'inherit',
    fontSize: '13px',
    padding: '12px',
    overflow: 'auto',
    height: '100%',
    boxSizing: 'border-box',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  headline: { flex: '1 1 auto', fontWeight: 600 },
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  sectionTitle: {
    fontSize: '11px',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    opacity: 0.6,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '72px 96px 1fr',
    gap: '8px',
    alignItems: 'baseline',
    padding: '2px 0',
  },
  status: { opacity: 0.8, fontVariantNumeric: 'tabular-nums' },
  name: { opacity: 0.8 },
  muted: { opacity: 0.65 },
  notice: {
    border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
    borderRadius: '6px',
    padding: '6px 8px',
    opacity: 0.8,
  },
  button: {
    font: 'inherit',
    fontSize: '12px',
    padding: '2px 8px',
    borderRadius: '6px',
    border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  anchor: { position: 'relative', display: 'inline-flex' },
  chip: {
    font: 'inherit',
    fontSize: '12px',
    padding: '2px 8px',
    borderRadius: '999px',
    border: '1px solid color-mix(in srgb, currentColor 20%, transparent)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  popover: {
    position: 'fixed',
    width: '440px',
    maxWidth: 'calc(100vw - 16px)',
    maxHeight: '60vh',
    overflow: 'auto',
    border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
    borderRadius: '10px',
    background: 'Canvas',
    color: 'CanvasText',
    boxShadow: '0 8px 24px color-mix(in srgb, CanvasText 18%, transparent)',
    zIndex: 60,
  },
} satisfies Record<string, CSSProperties>
