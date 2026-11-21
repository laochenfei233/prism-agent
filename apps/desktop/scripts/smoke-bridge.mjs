/**
 * Smoke: the injected desktop host bridge must speak the update-carrier
 * protocol the client and the shell page expect.
 *
 * Renders the bridge onto a fixture entry document and asserts the markers
 * both ends of the relay depend on: the `dshDesktop` carrier shape, the
 * allow-listed updater commands, the state-event name, and the injection's
 * idempotence (a re-run must not stack a second bridge). It also exercises
 * the open routing behaviorally: a click the page claims (preventDefault —
 * React links opening in-app or through the overridden window.open) must
 * open exactly once through the page's own route, an orphan anchor must
 * open exactly once through the bridge, and a window.open outside any
 * anchor click must still open.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectDesktopHostBridge } from './bundle-runtime.mjs';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '.bridge-smoke');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

try {
  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    join(dist, 'index.html'),
    '<!doctype html><html><head><title>fixture</title></head><body></body></html>\n',
  );

  injectDesktopHostBridge(dist);
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const markers = [
    'dsh-desktop-host',
    'window.dshDesktop',
    'protocolVersion: 1',
    'prism_update_state',
    'prism_check_update',
    'prism_install_update',
    'prism://update-state',
    'updates',
  ];
  const missing = markers.filter((marker) => !html.includes(marker));
  if (missing.length > 0) {
    throw new Error(`injected bridge is missing markers: ${missing.join(', ')}`);
  }

  const occurrences = (text, needle) => text.split(needle).length - 1;
  const before = occurrences(html, 'window.dshDesktop');
  injectDesktopHostBridge(dist);
  const after = readFileSync(join(dist, 'index.html'), 'utf8');
  if (occurrences(after, 'window.dshDesktop') !== before) {
    throw new Error('bridge injection is not idempotent');
  }

  // Behavior: the bridge opens only anchors the page did not claim. A page
  // handler preventDefaults the click before the bridge's bubble listener
  // runs (the DOM order is root-container bubble, then document bubble), so
  // the stub dispatch replays that order. `preventDefault` flips the event's
  // own flag exactly like a real event.
  const scriptBody = /<script>([\s\S]*?)<\/script>/.exec(after)[1];
  const opens = [];
  const frameWindow = {
    parent: { postMessage: (message) => { if (message.kind === 'open') opens.push(message.url); } },
    addEventListener: () => {},
  };
  const clickRegistrations = [];
  const frameDocument = {
    addEventListener: (type, handler, options) => { if (type === 'click') clickRegistrations.push({ handler, options }); },
    documentElement: {},
    querySelector: () => null,
    readyState: 'complete',
  };
  const frameLocation = { href: 'http://127.0.0.1:38081/app', origin: 'http://127.0.0.1:38081' };
  new Function('window', 'document', 'location', 'MutationObserver', scriptBody)(
    frameWindow, frameDocument, frameLocation,
    class { observe() {} disconnect() {} },
  );
  // The anchor listener must run on the bubble: capture registration re-opens
  // the page's claimed clicks before their own handlers run (the original
  // double-open), which the claimed-click flow below would otherwise catch.
  const clickListeners = clickRegistrations
    .filter(({ options }) => options?.capture !== true)
    .map(({ handler }) => handler);
  if (clickListeners.length !== clickRegistrations.length) {
    throw new Error('the bridge must register its click listener on the bubble, not the capture phase');
  }
  const anchor = {
    getAttribute: (name) => (name === 'href' ? 'https://example.com/page' : null),
    target: '_blank',
  };
  const makeEvent = () => ({
    target: { closest: (selector) => (selector === 'a' ? anchor : null) },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  });

  // A page handler claims the click and routes it itself (in-app or through
  // the overridden window.open); the bridge must not add a system-browser
  // open. One dispatch, one open.
  const claimedEvent = makeEvent();
  claimedEvent.preventDefault(); // the page handler runs before the bubble listener
  frameWindow.open('https://example.com/page', '_blank', 'noopener,noreferrer');
  clickListeners.forEach((handler) => handler(claimedEvent));
  if (opens.length !== 1 || opens[0] !== 'https://example.com/page') {
    throw new Error(`a claimed anchor click must open once, got ${JSON.stringify(opens)}`);
  }

  // An orphan anchor (no page handler) opens once through the bridge, and its
  // default navigation is prevented — ahead of the opener plugin's click
  // listener, whose preventDefault-then-throw would otherwise kill the link.
  const orphanEvent = makeEvent();
  clickListeners.forEach((handler) => handler(orphanEvent));
  if (opens.length !== 2 || opens[1] !== 'https://example.com/page') {
    throw new Error(`an orphan anchor click must open once, got ${JSON.stringify(opens)}`);
  }
  if (!orphanEvent.defaultPrevented) {
    throw new Error('the bridge must prevent the orphan anchor\'s default navigation');
  }

  // A click outside any anchor must not suppress the next window.open, and a
  // window.open outside any click must still open.
  clickListeners.forEach((handler) => handler({ target: { closest: () => null }, defaultPrevented: false, preventDefault() {} }));
  frameWindow.open('https://other.example/path', '_blank', 'noopener');
  if (opens.length !== 3 || opens[2] !== 'https://other.example/path') {
    throw new Error(`a non-anchor click must not suppress window.open, got ${JSON.stringify(opens)}`);
  }

  console.log('desktop host bridge smoke: OK');
} finally {
  rmSync(root, { recursive: true, force: true });
}
