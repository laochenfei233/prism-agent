// Shell page logic: dsh lifecycle events and the
// host <-> iframe bridge (interface readiness, native notifications,
// default-browser links, and the update relay).
// The top navigation bar is intentionally gone; the dsh UI owns its chrome.
// The hub port is delivered by the Rust side through dsh_status (it picks a
// free port when the default 3081 is occupied); the constant below is only
// the plain-browser fallback.

const DEFAULT_ORIGIN = 'http://127.0.0.1:3081';

// Boot polls this often. The shell spawns the server before the window exists,
// so readiness can be published before this document subscribes to events;
// polling is what makes the handoff independent of that race. The interval is
// short because each round is one local invoke and a lazy wait costs the user
// visible time on the one screen they are staring at.
const CONVERGE_INTERVAL_MS = 250;
const CONVERGE_ROUNDS = 2400;

// The shell keeps its splash over the frame until the interface is mounted,
// which the injected host bridge reports. A frame whose bridge never reports
// (a stale bundle) falls back to this bound, longer than any observed boot so
// it cannot cut a healthy load short.
const READY_TIMEOUT_MS = 20000;

// The splash hides with a 180ms opacity fade (style.css). The reveal event is
// not guaranteed to arrive — a reveal before the first paint of the overlay
// starts no transition — so the settled layer is also armed on this timer.
const SPLASH_SETTLE_MS = 600;

const frame = document.getElementById('dsh-frame');
const banner = document.getElementById('error-banner');
const errorText = document.getElementById('error-text');
const splash = document.getElementById('splash');
const splashStatus = document.getElementById('splash-status');

const TAURI_BRIDGE = Boolean(window.__TAURI__);
const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
const listen = (event, cb) => window.__TAURI__.event.listen(event, cb);

let currentPort;
let currentUrl;
let statusRequest;
let readyFallback;
// Set while the frame's bridge asks the splash to outlive the frame's load.
let holdRequested = false;
// The splash must survive the `about:blank` load that happens before the frame
// is pointed at a real server URL.
let frameCommitted = false;

function showError(text) {
  errorText.textContent = text;
  banner.classList.remove('hidden');
}

function hideError() {
  banner.classList.add('hidden');
}

function setSplashStatus(text) {
  if (splashStatus !== null) splashStatus.textContent = text;
}

function hideSplash() {
  if (splash === null || splash.classList.contains('hidden')) return;
  splash.classList.add('hidden');
  // The fade is what the user sees; `gone` is what takes the layer out of the
  // document. A reveal that lands before the splash ever painted runs no
  // transition at all, so the timer is the guarantee and the event is only the
  // fast path — an overlay that stayed mounted at zero opacity would still
  // intercept the app's own pointer and paint work.
  const settle = () => splash.classList.add('gone');
  splash.addEventListener('transitionend', settle, { once: true });
  setTimeout(settle, SPLASH_SETTLE_MS);
}

function showSplash(status) {
  if (splash === null) return;
  splash.classList.remove('gone');
  splash.classList.remove('hidden');
  if (status !== undefined) setSplashStatus(status);
}

// The frame's bridge has not reported a mounted interface yet: bound the wait
// so a bridge that never reports cannot leave the splash over a usable frame.
function armReadyFallback() {
  if (splash === null || splash.classList.contains('hidden')) return;
  clearTimeout(readyFallback);
  readyFallback = setTimeout(hideSplash, READY_TIMEOUT_MS);
}

function settleSplash() {
  clearTimeout(readyFallback);
  readyFallback = undefined;
  hideSplash();
}

function loadPlainUi() {
  frameCommitted = true;
  frame.src = DEFAULT_ORIGIN;
}

function loadAuthenticatedUi(port, url) {
  if (typeof port !== 'number' || typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
      || parsed.port !== String(port) || !parsed.searchParams.has('token')) {
    return false;
  }
  // Assigning src reloads the frame, so an unchanged URL must not be reassigned
  // when the polling loop re-reads the same status.
  if (frameCommitted && currentUrl === url) return true;
  currentPort = port;
  currentUrl = url;
  holdRequested = false;
  frameCommitted = true;
  setSplashStatus('正在加载界面…');
  frame.src = url;
  hideError();
  return true;
}

function clearUi() {
  currentPort = undefined;
  currentUrl = undefined;
  clearTimeout(readyFallback);
  readyFallback = undefined;
  holdRequested = false;
  frameCommitted = false;
  frame.src = 'about:blank';
}

async function convergeOnAuthenticatedUi() {
  if (statusRequest !== undefined) return statusRequest;
  statusRequest = (async () => {
    try {
      const status = await invoke('dsh_status');
      if (status.error) {
        setSplashStatus('运行时不可用');
        showError(status.error);
        return false;
      }
      return status.running && loadAuthenticatedUi(status.port, status.url);
    } catch {
      return false;
    } finally {
      statusRequest = undefined;
    }
  })();
  return statusRequest;
}

// The updater commands the embedded UI may ask the shell to run. The relay is
// allow-listed on purpose: the frame is web content, and a general invoke
// passthrough would hand every Tauri capability to it.
const UPDATE_COMMANDS = new Set([
  'prism_update_state',
  'prism_check_update',
  'prism_install_update',
]);

function replyToFrame(id, payload) {
  frame.contentWindow?.postMessage(
    { source: 'dsh-desktop-host', kind: 'rpc-result', id, ...payload }, '*');
}

// The dsh iframe's injected host bridge posts here (source
// 'dsh-desktop-host'): show native OS toasts through tauri-plugin-notification,
// open external links in the default browser through the opener plugin, and
// run the allow-listed updater commands whose results come back as a promise
// RPC reply.
function handleHostBridge(event) {
  if (!event.data || event.data.source !== 'dsh-desktop-host') return;
  if (event.data.kind === 'hold') {
    holdRequested = true;
  } else if (event.data.kind === 'ready') {
    settleSplash();
  } else if (event.data.kind === 'notify') {
    invoke('plugin:notification|notify', {
      options: { title: event.data.title, body: event.data.body },
    }).catch((err) => console.error('[desktop] notification failed:', err));
  } else if (event.data.kind === 'open') {
    invoke('plugin:opener|open_url', { url: event.data.url })
      .catch((err) => console.error('[desktop] open failed:', err));
  } else if (event.data.kind === 'call') {
    const { id, cmd } = event.data;
    if (!UPDATE_COMMANDS.has(cmd)) {
      replyToFrame(id, { ok: false, error: 'command not allowed through the desktop host bridge' });
      return;
    }
    invoke(cmd).then(
      (value) => replyToFrame(id, { ok: true, value }),
      (err) => replyToFrame(id, { ok: false, error: String(err) }),
    );
  }
}

document.getElementById('btn-retry').addEventListener('click', () => {
  hideError();
  clearUi();
  showSplash('正在重启本地服务…');
  invoke('restart_dsh');
});

window.addEventListener('message', handleHostBridge);

// A frame load is not a mounted interface: it fires while the client plugins
// are still activating and the application has yet to take the mount point, so
// the bridge injected into the served page asks the splash to hold and reports
// the mount itself. A page without that bridge — a plain-browser preview, or a
// dev runtime seeded from an unpatched dist — keeps load as its reveal.
frame.addEventListener('load', () => {
  if (!frameCommitted) return;
  if (holdRequested) armReadyFallback();
  else hideSplash();
});

(async () => {
  // The browser-session cookie is granted only by the tokenized URL printed by
  // dsh web. Never point the frame at a bare loopback port: another dsh
  // process may own it, and the resulting 401 is indistinguishable from a
  // failed launch. The frame keeps the splash until the port and token agree.
  if (TAURI_BRIDGE) frame.src = 'about:blank';
  else loadPlainUi();

  if (!TAURI_BRIDGE) return;

  listen('dsh://launch-url', () => {
    void convergeOnAuthenticatedUi();
  });
  listen('dsh://ready', () => {
    void convergeOnAuthenticatedUi();
  });
  listen('dsh://restarted-by-plugin', () => {
    clearUi();
    void convergeOnAuthenticatedUi();
  });
  listen('dsh://restarting', () => {
    clearUi();
  });
  listen('dsh://failed', (e) => {
    setSplashStatus('本地服务启动失败');
    showError(String(e.payload ?? 'dsh 服务启动失败'));
  });
  // Update-state pushes ride the same bridge into the frame, where the
  // injected carrier fans them out to its subscribers.
  listen('prism://update-state', (e) => {
    frame.contentWindow?.postMessage(
      { source: 'dsh-desktop-host', kind: 'event', event: 'prism://update-state', payload: e.payload }, '*');
  });

  // The first round runs immediately: the shell may already be serving, and the
  // events above may have fired before this document existed.
  for (let round = 0; round < CONVERGE_ROUNDS; round++) {
    if (await convergeOnAuthenticatedUi()) return;
    await new Promise((resolve) => setTimeout(resolve, CONVERGE_INTERVAL_MS));
  }
  setSplashStatus('本地服务启动超时');
  showError('dsh 服务启动失败');
})();
