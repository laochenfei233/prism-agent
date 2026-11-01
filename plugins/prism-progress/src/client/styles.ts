/**
 * Panel stylesheet.
 *
 * Kept as a string because an out-of-tree bundle has no CSS pipeline: the page
 * renders it in a <style> element, so it leaves with the component. Colors are
 * the shell's own `--dsw-*` tokens with literal fallbacks, which is what makes
 * the panel follow the active theme, including dark mode.
 */

/** The complete panel stylesheet. */
export const PANEL_CSS = `
.ap-page{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:14px/22px system-ui,sans-serif}
.ap-header{display:flex;align-items:center;gap:12px;flex:none;min-height:54px;padding:8px 16px 8px 20px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04))}
.ap-header h2{margin:0;font-size:16px;line-height:24px;font-weight:500}
.ap-summary{margin:2px 0 0;color:var(--dsw-alias-label-secondary,#61666b);font-size:13px;line-height:18px}
.ap-spacer{margin-left:auto}
.ap-page button{font:inherit;color:inherit;cursor:pointer}
.ap-header button{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:16px;background:transparent;padding:0 12px;min-height:32px}
.ap-header button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ap-scroll{flex:1;min-height:0;overflow:auto}
.ap-list{list-style:none;margin:0;padding:8px 12px 16px}
.ap-row{display:flex;width:100%;gap:10px;align-items:flex-start;padding:12px;border:0;border-radius:14px;background:transparent;text-align:left}
.ap-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ap-dot{flex:none;width:8px;height:8px;margin-top:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#adb2b8)}
.ap-dot[data-running=true]{background:var(--dsw-alias-state-success-primary,#22c55e);box-shadow:0 0 0 3px var(--dsw-alias-state-success-tertiary,#e6faed)}
.ap-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ap-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;color:var(--dsw-alias-label-tertiary,#81858c);font-size:12px;line-height:18px}
.ap-active{color:var(--dsw-alias-label-secondary,#61666b);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ap-side{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:6px;max-width:280px}
.ap-chip{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border-radius:11px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-module-platform,#f5f6f7);color:var(--dsw-alias-label-secondary,#61666b)}
.ap-chip[data-tone=running]{background:var(--dsw-alias-state-success-tertiary,#e6faed);color:var(--dsw-alias-state-success-primary,#22c55e)}
.ap-chip[data-tone=waiting]{background:var(--dsw-alias-state-warn-tertiary,#fef5e7);color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.ap-chip[data-tone=business]{background:var(--dsw-alias-bg-module-platform,#f5f6f7);color:var(--dsw-alias-state-business-primary,#4176e6)}
.ap-goal{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block}
.ap-bar{position:relative;width:88px;height:6px;border-radius:3px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.1));overflow:hidden}
.ap-bar i{position:absolute;inset:0 auto 0 0;border-radius:3px;background:var(--dsw-alias-state-business-primary,#4176e6)}
.ap-empty{padding:32px;text-align:center;color:var(--dsw-alias-label-secondary,#61666b)}
.ap-empty p{margin:8px 0 0;font-size:13px;color:var(--dsw-alias-label-tertiary,#81858c)}
.ap-approval{display:flex;align-items:center;gap:10px;margin:0 12px 8px 30px;padding:8px 10px;border:1px solid var(--dsw-alias-state-warn-secondary,rgba(245,158,11,.35));border-radius:10px;background:var(--dsw-alias-state-warn-tertiary,#fef5e7)}
.ap-approval-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#0f1115)}
.ap-approval-actions{flex:none;display:flex;align-items:center;gap:6px}
.ap-approval-actions button{min-height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:13px;background:transparent;font-size:12px;line-height:18px}
.ap-approval-reject:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger,rgba(239,68,68,.08));color:var(--dsw-alias-state-error-primary,#ef4444);border-color:transparent}
.ap-approval-allow{border-color:transparent!important;background:var(--dsw-alias-state-business-primary,#4176e6);color:#fff}
.ap-approval-allow:hover:not(:disabled){filter:brightness(1.06)}
.ap-approval button:disabled{opacity:.55;cursor:default}
`
