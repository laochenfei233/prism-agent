/**
 * The pocket adaptation stylesheet, injected once while active.
 *
 * Every selector anchors on a `[data-slot="<key>"]` wrapper the app renders
 * for its slots — the documented addressable seam — or on the plugin's own
 * `.prism-*` classes. When the app renames a seam, the rule simply stops
 * matching; nothing breaks.
 *
 * @module @prism/prism-pocket/client/css
 */

/** The complete pocket stylesheet, active only under `html.prism-active`. */
export const POCKET_CSS = `
html.prism-active {
  touch-action: manipulation;
  overscroll-behavior-y: none;
  -webkit-text-size-adjust: 100%;
}

/* The drawer: the sidebar leaves the column flow and covers the viewport. */
html.prism-active.prism-drawer-open [data-slot="sidebar"] {
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: min(82vw, 360px);
  height: 100dvh;
  z-index: 100;
  box-shadow: 0 0 40px rgb(0 0 0 / 0.35);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

.prism-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgb(0 0 0 / 0.45);
  opacity: 0;
  transition: opacity 0.22s ease;
  pointer-events: none;
}
html.prism-active.prism-drawer-open .prism-backdrop {
  opacity: 1;
  pointer-events: auto;
}

/* The soft keyboard: the header yields, the dock stays. */
html.prism-active.prism-keyboard [data-slot="conversation.session.header"],
html.prism-active.prism-keyboard [data-slot="conversation.header"] {
  display: none;
}

/* The composer area respects the home-indicator safe area. */
html.prism-active [data-slot="conversation.composer.dock"],
html.prism-active [data-slot="conversation.input.dock"] {
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 6px);
}

/* Control rows never wrap: the bar scrolls sideways instead. */
html.prism-active [data-slot="conversation.composer.bar"] {
  overflow-x: auto;
  scrollbar-width: none;
  flex-wrap: nowrap;
}
html.prism-active [data-slot="conversation.composer.bar"]::-webkit-scrollbar {
  display: none;
}

/* Message tables scroll instead of stretching the transcript. */
html.prism-active [data-slot="main"] table {
  display: block;
  max-width: 100%;
  overflow-x: auto;
}

/* The plugin's own notification cards. */
.prism-cards {
  position: fixed;
  left: 12px;
  right: 12px;
  top: calc(env(safe-area-inset-top, 0px) + 10px);
  z-index: 200;
  display: grid;
  gap: 8px;
  pointer-events: none;
}
.prism-card {
  pointer-events: auto;
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 14px;
  background: rgb(20 24 34 / 0.92);
  color: #e6e9f2;
  font: 500 14px/1.45 system-ui, sans-serif;
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
  animation: prism-card-in 0.28s cubic-bezier(0.2, 0.9, 0.3, 1);
}
.prism-card-title {
  font-weight: 700;
  white-space: nowrap;
}
.prism-card-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.prism-card button {
  margin-left: auto;
  border: 0;
  background: none;
  color: #7aa2f7;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
@keyframes prism-card-in {
  from { transform: translateY(-12px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .prism-card { animation: none; }
  .prism-backdrop { transition: none; }
}
`
