/**
 * Section stylesheet.
 *
 * Kept as a string because an out-of-tree bundle has no CSS pipeline: the
 * section renders it in a <style> element. Colors are the shell's own
 * `--dsw-*` tokens with literal fallbacks, so the section follows the active
 * theme, including dark mode.
 */

/** The complete section stylesheet. */
export const ARCHIVED_CSS = `
.pap{display:grid;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary,#0f1115);font:13px/20px system-ui,sans-serif}
.pap-head{display:flex;gap:12px;align-items:baseline;justify-content:space-between;flex-wrap:wrap}
.pap-count{color:var(--dsw-alias-label-secondary,#61666b);font-variant-numeric:tabular-nums}
.pap-intro,.pap-report{margin:0;color:var(--dsw-alias-label-secondary,#61666b)}
.pap-report{color:var(--dsw-alias-state-business-primary,#4176e6)}
.pap-list{display:grid;gap:1px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06));border-radius:12px;overflow:hidden;background:var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.pap-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:12px;align-items:center;padding:10px 12px;background:var(--dsw-alias-bg-base,#fff)}
.pap-row:hover{background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.pap-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pap-meta{color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}
.pap-button{height:26px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-bg-base,#fff);color:inherit;font:inherit;cursor:pointer}
.pap-button:hover{background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.pap-button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6);outline-offset:2px}
.pap-button[disabled]{opacity:.5;cursor:default}
.pap-empty{margin:0;color:var(--dsw-alias-label-secondary,#61666b)}
@media (prefers-reduced-motion:no-preference){.pap-row{transition:background-color .12s ease}}
`
