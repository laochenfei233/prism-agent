/**
 * Top-level render failure surface. React unmounts a root whose render throws
 * when no boundary owns the error; by then the boot kernel's failure page is
 * already detached, so the window would stay blank. This boundary keeps the
 * root mounted and replaces the application tree with a self-contained crash
 * face that names the error and offers a reload.
 * @module @deepseek-ai/dsh-client-ui-renderer/client/render-failure
 */
import { Component, createElement, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import { RENDER_FAILURE_COPY, type RenderFailureCopy } from './locales.ts'

/** Props of {@link RenderFailureBoundary}. */
export interface RenderFailureBoundaryProps {
  /** Called once for every caught error so the host logger records it. */
  onError: (error: unknown) => void
  /** Application tree the boundary guards. */
  children: ReactNode
}

interface RenderFailureBoundaryState {
  failed: boolean
  error?: unknown
}

const SURFACE_STYLE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 2147483647,
  display: 'grid',
  placeItems: 'center',
  padding: 24,
  background: 'Canvas',
  color: 'CanvasText',
  font: '13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif',
}

const CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  width: 'min(680px, 100%)',
  maxHeight: '100%',
  overflow: 'auto',
}

const HEADLINE_STYLE: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
}

const HINT_STYLE: CSSProperties = {
  color: 'GrayText',
}

const ERROR_BOX_STYLE: CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  border: '1px solid rgb(127 127 127 / 35%)',
  borderRadius: 6,
  background: 'rgb(127 127 127 / 8%)',
  font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

const DETAILS_STYLE: CSSProperties = {
  display: 'grid',
  gap: 6,
}

const DISCLOSURE_STYLE: CSSProperties = {
  cursor: 'pointer',
  color: 'GrayText',
}

const TRACE_STYLE: CSSProperties = {
  ...ERROR_BOX_STYLE,
  maxHeight: '30vh',
  overflow: 'auto',
}

const BUTTON_STYLE: CSSProperties = {
  alignSelf: 'flex-start',
  padding: '6px 14px',
  border: '1px solid currentColor',
  borderRadius: 6,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
}

/** Reload the served page so a transient render failure can be retried. */
function reloadApplication(): void {
  location.reload()
}

/** Mark the surface without relying on JSX-only `data-*` attribute typing. */
function markFailureSurface(node: HTMLDivElement | null): void {
  if (node !== null) node.dataset.renderFailure = ''
}

/**
 * Render the crash face for one caught render error.
 * @param error - Error thrown by the application tree.
 * @param copy - Crash-face copy (built in, never plugin-provided).
 * @returns The visible failure surface.
 */
export function renderFailureSurface(error: unknown, copy: RenderFailureCopy): ReactNode {
  const errorText = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const stack = error instanceof Error && error.stack !== undefined && error.stack !== errorText
    ? error.stack
    : undefined
  const details = stack === undefined
    ? null
    : createElement('details', { style: DETAILS_STYLE },
      createElement('summary', { style: DISCLOSURE_STYLE }, copy.details),
      createElement('pre', { style: TRACE_STYLE }, stack),
    )
  const card = createElement('div', { style: CARD_STYLE },
    createElement('div', { style: HEADLINE_STYLE }, copy.title),
    createElement('div', { style: HINT_STYLE }, copy.detail),
    createElement('pre', { style: ERROR_BOX_STYLE }, errorText),
    details,
    createElement('button', { type: 'button', style: BUTTON_STYLE, onClick: reloadApplication }, copy.reload),
  )
  return createElement('div', { ref: markFailureSurface, role: 'alert', style: SURFACE_STYLE }, card)
}

/**
 * Keep a render failure visible instead of letting React unmount the root into
 * a blank document. The boundary logs the error and delegates presentation to
 * {@link renderFailureSurface}; it never retries the failed tree itself, so a
 * deterministic render error cannot loop.
 */
export class RenderFailureBoundary extends Component<RenderFailureBoundaryProps, RenderFailureBoundaryState> {
  override state: RenderFailureBoundaryState = { failed: false }

  /**
   * Capture the thrown value for the crash face.
   * @param error - value thrown by the guarded tree.
   * @returns the failed state carrying the thrown value.
   */
  static getDerivedStateFromError(error: unknown): RenderFailureBoundaryState {
    return { failed: true, error }
  }

  /**
   * Log the failure before the crash face renders.
   * @param error - value thrown by the guarded tree.
   * @param info - React component stack of the failed tree.
   */
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('web app render failed:', error, info.componentStack)
    this.props.onError(error)
  }

  /**
   * Render the guarded tree, or the crash face after a failure.
   * @returns the application children or the crash face.
   */
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return renderFailureSurface(this.state.error, RENDER_FAILURE_COPY)
  }
}
