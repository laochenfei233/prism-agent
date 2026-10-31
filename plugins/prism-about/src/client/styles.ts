/**
 * Section stylesheet.
 *
 * Kept as a string because an out-of-tree bundle has no CSS pipeline: the
 * section renders it in a <style> element, so it leaves with the component.
 * Colors are the shell's own `--dsw-*` tokens with literal fallbacks, which is
 * what makes the section follow the active theme, including dark mode.
 */

/** The complete section stylesheet. */
export const ABOUT_CSS = `
.pa-about{display:grid;gap:12px;max-width:560px;color:var(--dsw-alias-label-primary,#0f1115);font:13px/20px system-ui,sans-serif}
.pa-brand{display:flex;gap:16px;align-items:flex-start;justify-content:space-between;padding:16px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));border-radius:14px;background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.pa-identity{display:grid;gap:4px;min-width:0}
.pa-title{display:flex;gap:8px;align-items:center}
.pa-title h2{margin:0;font-size:16px;line-height:24px;font-weight:500}
.pa-version{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:11px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b)}
.pa-muted{margin:0;color:var(--dsw-alias-label-secondary,#61666b)}
.pa-hint{margin:4px 0 0;color:var(--dsw-alias-state-business-primary,#4176e6)}
.pa-hint[data-tone=error]{color:var(--dsw-alias-state-danger-primary,#e5484d)}
.pa-brand button{flex:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:16px;background:transparent;color:inherit;padding:0 14px;min-height:32px}
.pa-brand button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.pa-brand button:disabled{cursor:default;color:var(--dsw-alias-label-tertiary,#81858c)}
.pa-brand button[data-variant=primary]{background:var(--dsw-alias-state-business-primary,#4176e6);border-color:var(--dsw-alias-state-business-primary,#4176e6);color:#fff}
.pa-brand button[data-variant=primary]:hover:not(:disabled){filter:brightness(1.05);background:var(--dsw-alias-state-business-primary,#4176e6)}
.pa-progress{display:grid;gap:6px}
.pa-bar{position:relative;height:6px;border-radius:3px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.1));overflow:hidden}
.pa-bar i{position:absolute;inset:0 auto 0 0;border-radius:3px;background:var(--dsw-alias-state-business-primary,#4176e6)}
.pa-bar i[data-indeterminate=true]{width:40%;animation:pa-slide 1.2s ease-in-out infinite}
@keyframes pa-slide{from{left:-40%}to{left:100%}}
.pa-card{display:grid;gap:6px;padding:12px 16px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));border-radius:14px}
.pa-row{display:flex;gap:8px;align-items:center}
.pa-label{color:var(--dsw-alias-label-secondary,#61666b)}
.pa-badge{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:10px;font-size:12px;line-height:16px;background:var(--dsw-alias-state-business-tertiary,#eaf1fd);color:var(--dsw-alias-state-business-primary,#4176e6)}
.pa-repo{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:inherit}
.pa-links{display:flex;gap:16px}
.pa-links a{color:var(--dsw-alias-state-business-primary,#4176e6);text-decoration:none}
.pa-links a:hover{text-decoration:underline}
`
