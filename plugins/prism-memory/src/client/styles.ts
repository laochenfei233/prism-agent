/**
 * Page stylesheet.
 *
 * Kept as a string because an out-of-tree bundle has no CSS pipeline: the page
 * renders it in a `<style>` element, so it leaves with the component. Colors are
 * the shell's own `--dsw-*` tokens with literal fallbacks, which is what makes
 * the page follow the active theme, including dark mode.
 */

/** The complete page stylesheet. */
export const MEMORY_CSS = `
.pm-page{display:flex;flex-direction:column;height:100%;min-height:0;padding:20px 24px;gap:14px;color:var(--dsw-alias-label-primary,#0f1115);font:13px/20px system-ui,sans-serif}
.pm-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.pm-head h1{margin:0;font-size:18px;line-height:26px;font-weight:500}
.pm-counts{margin:0;color:var(--dsw-alias-label-secondary,#61666b)}
.pm-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pm-bar .pm-grow{flex:1 1 240px;min-width:180px}
.pm-layer{height:32px;border-radius:9px;padding:0 8px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.pm-notice{margin:0;min-height:20px;color:var(--dsw-alias-label-secondary,#61666b)}
.pm-notice[data-tone=error]{color:var(--dsw-alias-state-danger-primary,#e5484d)}
.pm-body{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:16px}
.pm-section{display:flex;flex-direction:column;gap:8px}
.pm-section h2{margin:0;font-size:12px;line-height:18px;font-weight:500;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#81858c)}
.pm-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.pm-row{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));border-radius:12px;background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.pm-row-meta{display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;line-height:18px}
.pm-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:10px;background:var(--dsw-alias-state-business-tertiary,#eaf1fd);color:var(--dsw-alias-state-business-primary,#4176e6);font-size:12px}
.pm-badge[data-layer=rule],.pm-badge[data-layer=lesson]{background:var(--dsw-alias-state-warning-tertiary,#fdf3e6);color:var(--dsw-alias-state-warning-primary,#b7791f)}
.pm-badge[data-layer=user],.pm-badge[data-layer=soul]{background:var(--dsw-alias-state-success-tertiary,#e9f7ef);color:var(--dsw-alias-state-success-primary,#2f855a)}
.pm-row-text{margin:0;overflow-wrap:anywhere}
.pm-actions{display:flex;gap:8px}
.pm-state{margin:0;color:var(--dsw-alias-label-secondary,#61666b)}
`
