/**
 * Section stylesheet.
 *
 * Kept as a string because an out-of-tree bundle has no CSS pipeline: the
 * section renders it in a `<style>` element, so it leaves with the component.
 * Every value comes from the shell's `--dsw-*` tokens with literal fallbacks,
 * and the geometry (16/24 title, 720px column, settings-card fill, 32px control
 * height, 36×20 switch) matches the Models and About settings pages.
 */

/** The complete section stylesheet. */
export const SEARCH_CSS = `
.ps-section{display:flex;flex-direction:column;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary,#0f1115);font:13px/20px system-ui,-apple-system,"Segoe UI",sans-serif}
.ps-head{display:flex;flex-direction:column;gap:6px}
.ps-title{margin:0;font-size:16px;line-height:24px;font-weight:500}
.ps-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary,#81858c)}
.ps-engines{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ps-card{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border:.5px solid var(--dsw-alias-settings-card-stroke,rgba(0,0,0,.08));border-radius:var(--dsw-radius-xl,14px);background:var(--dsw-alias-settings-card-fill,#fff)}
.ps-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.ps-rowText{display:flex;flex-direction:column;gap:2px;min-width:0}
.ps-rowTitle{font-size:14px;line-height:22px;font-weight:500}
.ps-rowDesc{display:flex;align-items:center;gap:6px;margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#61666b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ps-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-dimmed,#9aa0a6)}
.ps-dot[data-on=true]{background:var(--dsw-alias-state-success-primary,#2f9e44)}
.ps-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary,#0f1115)}
.ps-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#81858c)}
.ps-alert{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-danger-primary,#e5484d);overflow-wrap:anywhere}
.ps-field{display:flex;flex-direction:column;gap:6px}
.ps-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary,#61666b)}
.ps-select{box-sizing:border-box;height:32px;width:min(100%,360px);padding:0 8px;border:.5px solid var(--dsw-alias-border-l4,rgba(0,0,0,.16));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:inherit}
.ps-select:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6);box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6))}
.ps-select:disabled{opacity:.5}
.ps-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3,rgba(0,0,0,.2));cursor:pointer}
.ps-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary,#4176e6)}
.ps-switch:disabled{cursor:default;opacity:.5}
.ps-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}
.ps-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform 120ms ease}
.ps-switch[aria-checked=false] .ps-thumb{background:var(--dsw-alias-switch-thumb,#fff)}
.ps-switch[aria-checked=true] .ps-thumb{transform:translateX(16px)}
.ps-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ps-primary{box-sizing:border-box;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-button-primary-fill,#4176e6);color:var(--dsw-alias-label-primary-foreground,#fff);font:inherit;font-size:14px;cursor:pointer}
.ps-primary:hover:not(:disabled){filter:brightness(1.04)}
.ps-primary:disabled{cursor:default;opacity:.4}
.ps-primary:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6))}
.ps-status{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary,#2f9e44)}
@media (prefers-reduced-motion:reduce){.ps-thumb{transition:none}}
`
