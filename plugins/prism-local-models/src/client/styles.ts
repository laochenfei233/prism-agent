/**
 * Card stylesheet.
 *
 * Kept as a string because an out-of-tree bundle has no CSS pipeline: the card
 * renders it in a `<style>` element, so it leaves with the component. Rules
 * scope under `.lmm` wherever they compete with a primitive's own single-class
 * default; `button.lmm-danger` cannot, because the removal dialog portals to
 * `document.body` and takes its button out of the card's subtree. Every color
 * is a `--dsw-alias-*` token the Models page around it already consumes.
 *
 * @module @prism/prism-local-models/client/styles
 */

/** The complete card stylesheet. */
export const LOCAL_MODELS_CSS = `
.lmm{display:flex;flex-direction:column;gap:12px;margin-top:12px;color:var(--dsw-alias-label-primary)}
.lmm-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.lmm-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary)}
.lmm-path{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lmm-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.lmm-card{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:12px 14px;border:0.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.lmm-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.lmm-name{font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}
.lmm-status{display:inline-flex;align-items:center;gap:6px;margin-left:auto;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.lmm-status[data-state='error']{color:var(--dsw-alias-state-error-primary)}
.lmm-body{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
/* The chevron is a data URI because one cannot read CSS variables; #81858C is
   the caption gray both palettes share, the same literal the Models page's own
   select uses. */
.lmm-select{box-sizing:border-box;flex:1 1 240px;min-width:0;max-width:340px;height:32px;padding:0 32px 0 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;line-height:22px;background-color:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;background-size:12px 12px}
.lmm-select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.lmm-select:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.lmm-select:disabled{opacity:0.6;cursor:default}
.lmm-actions{display:inline-flex;align-items:center;gap:6px;margin-left:auto}
.lmm-track{height:4px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-module-platform);overflow:hidden}
.lmm-fill{height:100%;background:var(--dsw-alias-state-business-primary);transition:width 240ms ease}
.lmm-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.lmm-message{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.lmm-message[data-tone='error']{color:var(--dsw-alias-state-error-primary)}
button.lmm-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
button.lmm-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
@media (prefers-reduced-motion:reduce){.lmm-fill{transition:none}}
`
