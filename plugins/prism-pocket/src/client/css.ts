/**
 * The Pocket stylesheets, split by lifetime: {@link POCKET_CSS} styles the
 * settings page and the notification cards and stays injected on every
 * surface; {@link POCKET_ADAPTATION_CSS} carries the mobile adaptation and
 * injects only while active (`html.prism-active`).
 *
 * Every selector anchors on a `[data-slot="<key>"]` wrapper the app renders
 * for its slots — the documented addressable seam — or on the plugin's own
 * `.prism-*` classes. When the app renames a seam, the rule simply stops
 * matching; nothing breaks.
 *
 * @module @prism/prism-pocket/client/css
 */

/** The adaptation stylesheet, injected only while active (`html.prism-active`). */
export const POCKET_ADAPTATION_CSS = `
html.prism-active {
  touch-action: manipulation;
  overscroll-behavior-y: none;
  -webkit-text-size-adjust: 100%;
}

/* The drawer: the sidebar leaves the column flow and covers the viewport.
   The slot anchor renders display:contents, so it is restored to a real box
   here — otherwise the fixed positioning would have nothing to position. */
html.prism-active.prism-drawer-open [data-slot="sidebar"] {
  /* The anchor's inline display:contents only yields to !important. */
  display: block !important;
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  width: min(82vw, 360px);
  height: 100dvh;
  z-index: 100;
  overflow-y: auto;
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

`

/** The always-on stylesheet: the Pocket page and the notification cards. */
export const POCKET_CSS = `
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

/* The Pocket page: the settings material the surrounding pages use — card
   surface, card stroke, and the 13/20 row type — with one colored edge as the
   only accent. The verdict strip is the page's single bold element; every
   other surface stays quiet. */
.prism-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
}
.prism-panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border: 0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l1));
  border-radius: var(--dsw-radius-xl, 12px);
  background: var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-1));
}
.prism-panel-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
}
.prism-verdict {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-left: 3px solid var(--dsw-alias-state-idle-primary);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-2);
}
.prism-verdict[data-tone='ok'] { border-left-color: var(--dsw-alias-state-success-primary); }
.prism-verdict[data-tone='wait'] { border-left-color: var(--dsw-alias-state-warn-primary); }
.prism-verdict[data-tone='blocked'] { border-left-color: var(--dsw-alias-state-error-primary); }
.prism-verdict-text {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
}
.prism-address {
  font: 500 13px/20px ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--dsw-alias-label-secondary);
  overflow-wrap: anywhere;
}
.prism-steps {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 0.5px solid var(--dsw-alias-border-l1);
}
.prism-steps-title {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
}
.prism-step { display: flex; gap: 10px; }
.prism-step-number {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 20px;
  text-align: center;
}
.prism-step-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
}
.prism-step-label { font-size: 13px; line-height: 20px; }
.prism-step-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.prism-code {
  display: block;
  box-sizing: border-box;
  max-width: 100%;
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-markdown-code-block, var(--dsw-alias-bg-layer-2));
  font: 500 12px/18px ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.prism-code-inline { display: inline; padding: 2px 6px; }
.prism-facts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.prism-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.prism-note {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.prism-page-message {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.prism-page-message[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }

/* The phone panel: the QR is the page's signature element — a white plate
   either theme scans, flanked by the verdict and the missing steps. */
.prism-phone {
  display: grid;
  grid-template-columns: minmax(168px, 216px) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}
.prism-phone-qr {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.prism-qr {
  box-sizing: border-box;
  width: 100%;
  padding: 12px;
  border-radius: var(--dsw-radius-md, 8px);
  background: #fff;
  box-shadow: 0 0 0 0.5px var(--dsw-alias-border-l1);
}
.prism-qr svg {
  display: block;
  width: 100%;
  height: auto;
}
.prism-qr-empty {
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: 24px 12px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}
.prism-qr-caption {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  text-align: center;
}
.prism-phone-side {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
@media (max-width: 560px) {
  .prism-phone { grid-template-columns: 1fr; }
}

/* The channel cards: a quiet list with one brand chip each. */
.prism-channels {
  display: flex;
  flex-direction: column;
}
.prism-channel {
  border-top: 0.5px solid var(--dsw-alias-border-l1);
  padding-top: 12px;
}
.prism-channel:first-child { border-top: 0; padding-top: 0; }
.prism-channel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.prism-channel-chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: #fff;
  font-size: 13px;
  line-height: 1;
  font-weight: 500;
  user-select: none;
}
.prism-channel-name {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.prism-channel-title {
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
}
.prism-channel-tag {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 18px;
}
.prism-channel-status {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.prism-channel-status::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  border-radius: 999px;
  background: var(--dsw-alias-label-quaternary, var(--dsw-alias-border-l4));
  vertical-align: 1px;
}
.prism-channel-status[data-tone='online']::before { background: var(--dsw-alias-state-success-primary); }
.prism-channel-status[data-tone='starting']::before { background: var(--dsw-alias-state-warn-primary); }
.prism-channel-status[data-tone='error'] { color: var(--dsw-alias-state-error-primary); }
.prism-channel-status[data-tone='error']::before { background: var(--dsw-alias-state-error-primary); }
.prism-channel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-left: auto;
}
.prism-channel-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 12px;
  padding: 12px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-2);
}
.prism-channel-hint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.prism-channel-link {
  color: var(--dsw-alias-state-business-primary);
  text-decoration: none;
}
.prism-channel-link:hover { text-decoration: underline; }
.prism-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.prism-field-label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}
.prism-field-set { color: var(--dsw-alias-state-success-primary); }
.prism-input {
  box-sizing: border-box;
  width: 100%;
  height: 30px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
}
.prism-input:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
select.prism-input { height: 30px; }
.prism-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 14px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-md, 8px);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.prism-button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
}
.prism-button-primary {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-primary-inverted, var(--dsw-alias-brand-primary-invert));
}
.prism-button-primary:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); }
.prism-button-quiet {
  border-color: var(--dsw-alias-border-l4);
  background: none;
  color: var(--dsw-alias-label-secondary);
}
.prism-button-quiet:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
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
