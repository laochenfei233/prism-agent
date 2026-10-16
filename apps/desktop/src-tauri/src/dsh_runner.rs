//! Owns the bundled `dsh web` process: adoption of a server an earlier shell
//! start left running, spawn, port health probe, automatic crash restart, and
//! clean teardown on app exit.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::INTERNAL_PORT;

const RESTART_LIMIT: u32 = 3;
const LOG_NAME: &str = "dsh-web.log";
/// Upper bound of the fallback port scan when `INTERNAL_PORT` is occupied.
const PORT_SCAN_LIMIT: u16 = 50;
/// Records the server this home last started, so a later shell can adopt it
/// instead of paying the whole `dsh web` boot again.
const SERVER_RECORD_NAME: &str = "desktop-server.json";
/// Loopback probe budget for the adopt check. A live server answers in
/// milliseconds; anything slower is treated as absent so the cold path never
/// waits on a dead record.
const ADOPT_PROBE_TIMEOUT: Duration = Duration::from_millis(500);
/// Bound on reaping the hub at exit. The kill itself is immediate; a hub that
/// somehow outlives it must not hold the shell's exit open.
const HUB_KILL_TIMEOUT: Duration = Duration::from_secs(3);

// PRISM-DIVERGENCE: replay list in docs/compose/spec/desktop-startup-latency.md (S5).
/// The live server a previous shell start left behind, named by the launch URL
/// it printed. The token is per process, so accepting it proves the server on
/// that port is the one this home started rather than a recycled port or a
/// foreign listener.
#[derive(Serialize, Deserialize)]
struct ServerRecord {
    port: u16,
    url: String,
    pid: u32,
    /// Runtime closure the recorded server was started from; a shell may only
    /// adopt a server from its own build.
    bin: String,
    bin_len: u64,
    bin_modified_ms: u64,
}

/// Handle to the managed dsh child process. `child` is `None` while the
/// process is down and about to be (or already) restarted.
pub struct DshHandle {
    child: Arc<Mutex<Option<Child>>>,
    stopping: Arc<AtomicBool>,
    port: Arc<AtomicU16>,
    node_path: PathBuf,
    dsh_bin: PathBuf,
    /// Tokenized launch URL parsed from the child's stdout, reset on each spawn.
    auth_url: Arc<std::sync::Mutex<Option<String>>>,
    /// Set while a restart is outstanding. A restart must not adopt the hub it
    /// was asked to replace, and must not wait out a hub that cannot be ended.
    restarting: Arc<AtomicBool>,
    /// Why the runtime could not be resolved. The window is built after the
    /// child is spawned, so a resolution failure has no page to report itself
    /// to through events; it is published here instead and read back through
    /// `dsh_status`.
    startup_error: Arc<std::sync::Mutex<Option<String>>>,
}

impl DshHandle {
    /// Resolves the bundled runtime and spawns the supervisor loop. A runtime
    /// that cannot be resolved is retained as state rather than returned: the
    /// shell still has to open a window to tell the user what is wrong.
    pub fn spawn(app: &AppHandle) -> Self {
        let startup_error = Arc::new(std::sync::Mutex::new(None));
        let (node_path, dsh_bin) = match resolve_runtime(app) {
            Ok(paths) => (paths.0, paths.1),
            Err(err) => {
                *startup_error.lock().unwrap() = Some(err);
                (PathBuf::new(), PathBuf::new())
            }
        };
        let handle = Self {
            child: Arc::new(Mutex::new(None)),
            stopping: Arc::new(AtomicBool::new(false)),
            port: Arc::new(AtomicU16::new(INTERNAL_PORT)),
            node_path,
            dsh_bin,
            auth_url: Arc::new(std::sync::Mutex::new(None)),
            restarting: Arc::new(AtomicBool::new(false)),
            startup_error: startup_error.clone(),
        };
        if startup_error.lock().unwrap().is_some() {
            return handle;
        }
        let loop_handle = Self {
            child: handle.child.clone(),
            stopping: handle.stopping.clone(),
            port: handle.port.clone(),
            node_path: handle.node_path.clone(),
            dsh_bin: handle.dsh_bin.clone(),
            auth_url: handle.auth_url.clone(),
            restarting: handle.restarting.clone(),
            startup_error,
        };
        let app_owned = (*app).clone();
        tauri::async_runtime::spawn(async move { loop_handle.supervise(app_owned).await });
        handle
    }

    /// Supervision loop: spawn, wait for ready or exit, then restart on
    /// unexpected exit (unless another process already took the port, which
    /// happens when the dsh-plugin market restarts the server itself).
    async fn supervise(&self, app: AppHandle) {
        let mut restarts = 0u32;
        loop {
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }
            // Adopt the server an earlier shell start left running. Repeating
            // the `dsh web` boot is the whole of the wait the user sees, and
            // the adopted server already carries the profile and plugins.
            if let Some(port) = self.adopt_running_server(&app).await {
                wait_port_closed(port, self.stopping.clone(), self.restarting.clone()).await;
                // Forget only a hub that stopped serving. One still listening
                // belongs to no child of this shell, and its record is what the
                // next start adopts instead of booting a rival on another port.
                if !port_open(port) {
                    forget_server();
                }
                continue;
            }
            let (child, port) = match self.spawn_child(app.clone()).await {
                Ok(owned) => owned,
                Err(err) => {
                    let _ = app.emit("dsh://failed", err);
                    return;
                }
            };
            *self.child.lock().await = Some(child);
            self.port.store(port, Ordering::SeqCst);

            let ready = {
                let mut guard = self.child.lock().await;
                match guard.as_mut() {
                    Some(child) => wait_ready(port, child, self.stopping.clone()).await,
                    None => false,
                }
            };
            if !ready {
                if self.stopping.load(Ordering::SeqCst) {
                    // Quit landed while this hub was still booting: it was not
                    // in the child slot yet when the exit path looked, so it is
                    // ended here instead of being left serving the port.
                    if let Some(mut child) = self.child.lock().await.take() {
                        end_owned_child(&mut child).await;
                    }
                    return;
                }
                // Process died before the port ever answered.
                let _ = app.emit("dsh://failed", "dsh exited during startup");
                self.child.lock().await.take();
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            let _ = app.emit("dsh://ready", port);
            append_startup_log(&format!("dsh listening on {port}"));

            // Wait for the child to exit (or the stopping flag).
            loop {
                if self.stopping.load(Ordering::SeqCst) {
                    return;
                }
                let exited = {
                    let mut guard = self.child.lock().await;
                    match guard.as_mut() {
                        Some(child) => child.try_wait().ok().flatten().is_some(),
                        None => true,
                    }
                };
                if exited {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            self.child.lock().await.take();
            forget_server();
            if self.stopping.load(Ordering::SeqCst) {
                return;
            }

            // the dsh-plugin market may restart the server itself; in that case the port
            // stays occupied and we must not spawn a rival.
            if port_open(port) {
                let _ = app.emit("dsh://restarted-by-plugin", port);
                wait_port_closed(port, self.stopping.clone(), self.restarting.clone()).await;
                continue;
            }
            if restarts >= RESTART_LIMIT {
                let _ = app.emit("dsh://failed", "dsh crashed repeatedly");
                return;
            }
            restarts += 1;
            let _ = app.emit("dsh://restarting", restarts);
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    /// Attach the supervisor to the server an earlier shell start left running,
    /// or report `None` to fall through to a cold spawn. The decision is one
    /// file read plus one loopback request, both blocking, so it runs on the
    /// blocking pool and leaves the async runtime free.
    async fn adopt_running_server(&self, app: &AppHandle) -> Option<u16> {
        // A restart asked for this hub's replacement; adopting it again would
        // answer the request with the hub it was meant to replace.
        if self.restarting.swap(false, Ordering::SeqCst) {
            return None;
        }
        let path = server_record_path();
        let bin = self.dsh_bin.clone();
        let record = tauri::async_runtime::spawn_blocking(move || adopt_decision(&path, &bin))
            .await
            .ok()
            .flatten()?;
        self.port.store(record.port, Ordering::SeqCst);
        *self.auth_url.lock().unwrap() = Some(record.url.clone());
        append_startup_log(&format!(
            "adopted running server on {} (pid {})",
            record.port, record.pid
        ));
        let _ = app.emit("dsh://ready", record.port);
        Some(record.port)
    }

    async fn spawn_child(&self, app: AppHandle) -> Result<(Child, u16), String> {
        append_startup_log("spawn_child: begin");
        self.auth_url.lock().unwrap().take();
        self.ensure_home_node_modules()?;
        crate::setup::ensure_default_plugins(&app)?;
        append_startup_log("spawn_child: default plugins ready");
        let port = match select_port() {
            Ok(port) => port,
            Err(err) => {
                append_startup_log(&format!("select_port failed: {err}"));
                return Err(err);
            }
        };
        let mut cmd = Command::new(&self.node_path);
        // The dsh child only understands `DSH_HOME`, so hand it Prism's
        // resolved home; without this it falls back to `~/.dsh`.
        cmd.env("DSH_HOME", crate::setup::dsh_home());
        cmd.arg(&self.dsh_bin)
            .arg("web")
            .arg("--port")
            .arg(port.to_string())
            .arg("--no-open")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Run the CLI from its package root so relative config lookups work.
        let workdir = self
            .dsh_bin
            .parent()
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf());
        if let Some(root) = &workdir {
            cmd.current_dir(root);
        }
        // Put the bundled pnpm (runtime/node/node_modules/.bin) and the deploy
        // closure's bins first on PATH so `dsh plugin` works offline.
        let mut path_parts: Vec<String> = Vec::new();
        if let Some(node_dir) = self.node_path.parent() {
            path_parts.push(
                node_dir
                    .join("node_modules")
                    .join(".bin")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        if let Some(closure) = self.dsh_bin.parent().and_then(|p| p.parent()) {
            path_parts.push(
                closure
                    .join("node_modules")
                    .join(".bin")
                    .to_string_lossy()
                    .into_owned(),
            );
        }
        if let Ok(existing) = std::env::var("PATH") {
            // Split the inherited PATH back into its elements before joining:
            // join_paths rejects a single element containing the platform
            // separator (':' on POSIX, ';' on Windows), and the whole PATH
            // string always does.
            path_parts
                .extend(std::env::split_paths(&existing).map(|p| p.to_string_lossy().into_owned()));
        }
        // join_paths uses the platform separator (";" on Windows, ":" on
        // POSIX); a literal ";" join breaks every PATH lookup in the dsh web
        // process on mac/linux (osascript/npx/git all spawn with ENOENT).
        let path_value = std::env::join_paths(&path_parts).map_err(|e| e.to_string())?;
        cmd.env("PATH", &path_value);
        no_window(&mut cmd);
        // Startup log in the dsh home (provably writable — the profile patch
        // was just written there), appended to at every failure point. The
        // app log dir can silently fail on a partially-installed bundle and
        // has swallowed every diagnostic in this chain before.
        append_startup_log(&format!(
            "spawn: node={} bin={} cwd={:?} PATH={}",
            self.node_path.display(),
            self.dsh_bin.display(),
            workdir,
            path_value.to_string_lossy(),
        ));
        // Diagnostics: record exactly what is about to be spawned.
        if let Ok(log_dir) = app.path().app_log_dir() {
            let _ = std::fs::create_dir_all(&log_dir);
            let _ = std::fs::write(
                log_dir.join("spawn-debug.log"),
                format!(
                    "node={}\nbin={}\ncwd={:?}\nPATH={}\n",
                    self.node_path.display(),
                    self.dsh_bin.display(),
                    workdir,
                    path_value.to_string_lossy(),
                ),
            );
        }
        let spawn_result = cmd.spawn();
        let mut child = match spawn_result {
            Ok(child) => child,
            Err(e) => {
                // Persist the failure for diagnostics: the GUI error banner is
                // easy to miss while the app is starting.
                append_startup_log(&format!(
                    "spawn FAILED: {e}\nnode={}\nbin={}",
                    self.node_path.display(),
                    self.dsh_bin.display()
                ));
                if let Ok(log_dir) = app.path().app_log_dir() {
                    let _ = std::fs::create_dir_all(&log_dir);
                    let _ = std::fs::write(
                        log_dir.join("spawn-error.log"),
                        format!(
                            "spawn dsh failed: {e}\nnode={}\nbin={}\n",
                            self.node_path.display(),
                            self.dsh_bin.display()
                        ),
                    );
                }
                return Err(format!("spawn dsh failed: {e}"));
            }
        };
        let pid = child.id().unwrap_or_default();
        forward_stdout_to_log(
            child.stdout.take(),
            app.path().app_log_dir().ok().map(|d| d.join(LOG_NAME)),
            self.auth_url.clone(),
            app.clone(),
            SpawnIdentity {
                port,
                pid,
                bin: self.dsh_bin.clone(),
            },
        );
        forward_to_log(
            child.stderr.take(),
            app.path()
                .app_log_dir()
                .ok()
                .map(|d| d.join("dsh-web.err.log")),
        );
        Ok((child, port))
    }

    /// End every hub this home is serving, then return — app exit and tray
    /// Quit. Nothing this app runs outlives its window, so a hub this shell only
    /// adopted is ended here too: an earlier shell that died abruptly leaves the
    /// hub it started on the loopback port, and quitting is the last point that
    /// can end it.
    ///
    /// The kill runs to completion before the process exits rather than on a
    /// spawned task: a task is dropped with the runtime, and the hub of every
    /// quit survived it.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        tauri::async_runtime::block_on(async {
            if let Some(mut child) = self.child.lock().await.take() {
                end_owned_child(&mut child).await;
                forget_server();
                return;
            }
            // An adopted hub is no longer this shell's child, so it is ended by
            // pid — and only a pid the record still proves: re-reading it
            // requires the process on that port to answer with the launch token
            // the recorded hub printed, which the pid of a replaced hub cannot.
            let path = server_record_path();
            let bin = self.dsh_bin.clone();
            let adopted =
                tauri::async_runtime::spawn_blocking(move || adopt_decision(&path, &bin)).await;
            if let Ok(Some(record)) = adopted {
                terminate_pid(record.pid);
                forget_server();
            }
        });
    }

    /// Graceful restart requested from the UI ("Restart service").
    pub fn request_restart(&self) {
        self.restarting.store(true, Ordering::SeqCst);
        let child = self.child.clone();
        let bin = self.dsh_bin.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(mut child) = child.lock().await.take() {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return;
            }
            // An adopted server is not this shell's child. Re-read and re-verify
            // its record before ending it by pid: the recorded pid belongs to a
            // serving process only while that server's own launch token still
            // authenticates, and a pid from a replaced server may have been
            // recycled by an unrelated process. A hub that cannot be verified is
            // left alone; the supervisor replaces it on another port instead.
            let path = server_record_path();
            let adopted =
                tauri::async_runtime::spawn_blocking(move || adopt_decision(&path, &bin)).await;
            if let Ok(Some(record)) = adopted {
                terminate_pid(record.pid);
            }
        });
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::SeqCst)
    }

    /// The web profile's loader resolves bundle rows (`@deepseek-ai/dsh-base`,
    /// `@deepseek-ai/dsh-web-app`) by walking node_modules upward from the
    /// profile directory. A normal npm install reaches them through the global
    /// node_modules chain; the bundled runtime has no such chain. Junction the
    /// closure's node_modules at `$DSH_HOME/node_modules` (a stop on that walk
    /// and outside the profile dir, so pnpm plugin management inside the
    /// profile never touches it). The junction target is the app's resource
    /// directory, so an app update replaces the closure in place and the
    /// junction keeps working.
    fn ensure_home_node_modules(&self) -> Result<(), String> {
        let home = crate::setup::dsh_home();
        let link = home.join("node_modules");
        let closure_root = self.dsh_bin.parent().and_then(|p| p.parent());
        let Some(closure_root) = closure_root else {
            return Err("cannot derive closure root from dsh bin path".into());
        };
        let target = closure_root.join("node_modules");
        if !target.exists() {
            return Err(format!("closure node_modules missing at {target:?}"));
        }
        if link.exists() {
            return Ok(());
        }
        std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            // Directory junction (no admin rights needed, unlike symlink).
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let mut mklink = std::process::Command::new("cmd");
            mklink.creation_flags(CREATE_NO_WINDOW);
            let status = mklink
                .args(["/c", "mklink", "/J"])
                .arg(&link)
                .arg(&target)
                .status()
                .map_err(|e| format!("mklink failed: {e}"))?;
            if !status.success() {
                return Err(format!("failed to link DSH_HOME node_modules ({status})"));
            }
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(&target, &link).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// Where the adopted-server record lives: Prism's harness home, beside the
/// startup log, so a shell upgrade keeps the same home in view.
fn server_record_path() -> PathBuf {
    crate::setup::dsh_home().join(SERVER_RECORD_NAME)
}

/// Runtime identity of the CLI entry point: length and modification time. An
/// app update replaces the bundled closure, so a mismatch means the recorded
/// server predates this build and must not serve this shell.
fn runtime_identity(bin: &Path) -> Option<(u64, u64)> {
    let metadata = std::fs::metadata(bin).ok()?;
    let modified = metadata.modified().ok()?;
    let millis = modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
    Some((metadata.len(), millis))
}

/// The launch URL's token when the URL is this profile's loopback launch URL
/// for `port`: `http://127.0.0.1:<port>/?token=<token>`.
fn launch_token(url: &str, port: u16) -> Option<String> {
    let rest = url.strip_prefix("http://127.0.0.1:")?;
    let (authority, query) = rest.split_once('/')?;
    if authority != port.to_string() {
        return None;
    }
    let token = query.strip_prefix("?token=")?;
    if token.is_empty() || token.contains('&') {
        return None;
    }
    Some(token.to_string())
}

/// Ask the recorded server to authenticate with its launch token. Only the
/// process that printed the URL accepts it, so a 303 to the root while holding
/// the cookie-minting token proves the recorded server is still the one this
/// home started. Every other answer — 401 for a foreign token, another status
/// for a foreign server, no answer at all — leaves the shell on the cold path.
fn probe_launch_url(port: u16, token: &str) -> bool {
    use std::io::{Read, Write};

    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&address, ADOPT_PROBE_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(ADOPT_PROBE_TIMEOUT));
    let _ = stream.set_write_timeout(Some(ADOPT_PROBE_TIMEOUT));
    let request = format!(
        "GET /?token={token} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = [0u8; 64];
    let read = match stream.read(&mut response) {
        Ok(read) => read,
        Err(_) => return false,
    };
    let status = String::from_utf8_lossy(&response[..read]);
    status.starts_with("HTTP/1.1 303") || status.starts_with("HTTP/1.0 303")
}

/// Read the record at `path` and report the server it names when that server
/// can still be adopted. Blocking (file read plus loopback request), so the
/// supervisor runs it on the blocking pool.
fn adopt_decision(path: &Path, bin: &Path) -> Option<ServerRecord> {
    let raw = std::fs::read(path).ok()?;
    let record: ServerRecord = serde_json::from_slice(&raw).ok()?;
    let Some(identity) = runtime_identity(bin) else {
        return None;
    };
    if record.bin != bin.to_string_lossy() || (record.bin_len, record.bin_modified_ms) != identity {
        return None;
    }
    let token = launch_token(&record.url, record.port)?;
    if !probe_launch_url(record.port, &token) {
        return None;
    }
    Some(record)
}

/// Record the server this spawn produced, so the next shell start can adopt it.
/// A record that cannot be written costs nothing but the adoption, so failures
/// are dropped rather than raised at a point where the server is already up.
fn remember_server(port: u16, url: &str, pid: u32, bin: &Path) {
    let Some((bin_len, bin_modified_ms)) = runtime_identity(bin) else {
        return;
    };
    let record = ServerRecord {
        port,
        url: url.to_string(),
        pid,
        bin: bin.to_string_lossy().into_owned(),
        bin_len,
        bin_modified_ms,
    };
    let path = server_record_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(&record) {
        let _ = std::fs::write(&path, bytes);
    }
}

fn forget_server() {
    let _ = std::fs::remove_file(server_record_path());
}

/// End the hub this shell spawned, together with everything it derived. The
/// hub's own children — language servers, persistent terminals, commands
/// started through the shell tool, MCP servers — hold the workspace and the
/// loopback port; ending the hub alone leaves them with no parent and no record
/// for a later shell to adopt, which is how a quit used to leave a workspace in
/// use by nobody.
async fn end_owned_child(child: &mut Child) {
    if let Some(pid) = child.id() {
        terminate_pid(pid);
    }
    // The tree kill runs as another process and can lose the race against a hub
    // that exits on its own; this one cannot, and it reaps.
    let _ = tokio::time::timeout(HUB_KILL_TIMEOUT, child.kill()).await;
}

/// Stop a server an earlier shell start left running. Windows has no portable
/// std API for a foreign pid, so this reuses the hidden-console `cmd` pattern
/// that `ensure_home_node_modules` uses for junctions; the pid is only ever
/// one whose live launch token this shell just verified.
fn terminate_pid(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut kill = std::process::Command::new("cmd");
        kill.creation_flags(CREATE_NO_WINDOW);
        let _ = kill
            .args(["/c", "taskkill", "/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .arg(pid.to_string())
            .status();
    }
}

/// Choose the port for the next `dsh web` spawn: the default `INTERNAL_PORT`
/// when it accepts a bind, otherwise the first free port in the scan range.
/// Selection runs on every spawn, so a restart returns to the default as soon
/// as the external occupier releases it. The probe listener is dropped before
/// the process binds, leaving a tiny bind race that the supervisor's
/// `wait_ready` restart path absorbs.
fn select_port() -> Result<u16, String> {
    if port_free(INTERNAL_PORT) {
        return Ok(INTERNAL_PORT);
    }
    let last = INTERNAL_PORT + PORT_SCAN_LIMIT;
    for port in (INTERNAL_PORT + 1)..=last {
        if port_free(port) {
            return Ok(port);
        }
    }
    Err(format!(
        "no free port in {}..={last} for the dsh web",
        INTERNAL_PORT + 1
    ))
}

/// A port is free when a loopback bind succeeds; the listener is dropped
/// immediately, leaving the port for the spawned process.
fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

async fn wait_ready(port: u16, child: &mut Child, stopping: Arc<AtomicBool>) -> bool {
    // Probe tightly: this is a loopback connect, so the probe interval is dead
    // time added between the child binding its port and the shell loading the
    // UI, on every launch.
    const PROBE_INTERVAL: Duration = Duration::from_millis(50);
    const PROBE_ATTEMPTS: u32 = 1200;
    let mut attempts = 0u32;
    while attempts < PROBE_ATTEMPTS {
        if stopping.load(Ordering::SeqCst) {
            return false;
        }
        if port_open(port) {
            return true;
        }
        if let Ok(Some(_)) = child.try_wait() {
            return false;
        }
        tokio::time::sleep(PROBE_INTERVAL).await;
        attempts += 1;
    }
    false
}

/// Wait until the server on `port` stops serving, the shell is stopping, or a
/// restart is requested. The restart arm is what lets a hub this shell did not
/// start — and therefore cannot wait on as a child — still be replaced.
async fn wait_port_closed(port: u16, stopping: Arc<AtomicBool>, restarting: Arc<AtomicBool>) {
    loop {
        if stopping.load(Ordering::SeqCst) || restarting.load(Ordering::SeqCst) {
            return;
        }
        if !port_open(port) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

/// Extract the tokenized launch URL from the Web bundle's readiness line.
fn parse_launch_url(line: &str) -> Option<String> {
    let announced = line.strip_prefix("dsh web: ")?;
    let at = announced
        .find("http://")
        .or_else(|| announced.find("https://"))?;
    let url = &announced[at..];
    let end = url.find([' ', '\t', '(']).unwrap_or(url.len());
    if end == 0 {
        None
    } else {
        Some(url[..end].to_string())
    }
}

/// What the stdout reader needs to record an adoptable server: the port the
/// child was told to bind, the child's pid, and the CLI entry point the closure
/// was resolved from.
struct SpawnIdentity {
    port: u16,
    pid: u32,
    bin: PathBuf,
}

/// Read the child's stdout: publish the launch URL, record the adoptable server,
/// and mirror the stream into the log when the app log directory is available.
/// That directory can be missing on a partially installed bundle, which must not
/// cost the launch URL the whole window depends on.
fn forward_stdout_to_log<S>(
    stream: Option<S>,
    path: Option<PathBuf>,
    auth_url: Arc<std::sync::Mutex<Option<String>>>,
    app: AppHandle,
    identity: SpawnIdentity,
) where
    S: AsyncRead + Unpin + Send + 'static,
{
    let Some(stream) = stream else {
        return;
    };
    if let Some(dir) = path.as_ref().and_then(|path| path.parent()) {
        let _ = std::fs::create_dir_all(dir);
    }
    tauri::async_runtime::spawn(async move {
        let mut log = match path {
            Some(path) => tokio::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .await
                .ok(),
            None => None,
        };
        let mut reader = tokio::io::BufReader::new(stream).lines();
        let mut announced = false;
        loop {
            let line = match reader.next_line().await {
                Ok(Some(line)) => line,
                Ok(None) | Err(_) => break,
            };
            if !announced {
                if let Some(url) = parse_launch_url(&line) {
                    // Only a URL this shell could adopt again is worth
                    // remembering; a line that does not name this spawn's own
                    // port and token belongs to no server of ours.
                    if launch_token(&url, identity.port).is_some() {
                        remember_server(identity.port, &url, identity.pid, &identity.bin);
                    }
                    *auth_url.lock().unwrap() = Some(url.clone());
                    let _ = app.emit("dsh://launch-url", url);
                    announced = true;
                }
            }
            if let Some(file) = log.as_mut() {
                let logged = file
                    .write_all(line.as_bytes())
                    .await
                    .and(file.write_all(b"\n").await);
                if logged.is_err() {
                    log = None;
                }
            }
        }
    });
}

fn forward_to_log<S>(stream: Option<S>, path: Option<PathBuf>)
where
    S: AsyncRead + Unpin + Send + 'static,
{
    if stream.is_none() {
        return;
    }
    let Some(path) = path else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let stream = stream.expect("checked above");
    tauri::async_runtime::spawn(async move {
        let mut log = match tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
        {
            Ok(f) => f,
            Err(_) => return,
        };
        let mut reader = tokio::io::BufReader::new(stream);
        let _ = tokio::io::copy(&mut reader, &mut log).await;
    });
}

/// Resolves the Node executable and the dsh CLI entry.
///
/// Production layout (bundled by `scripts/bundle-runtime.mjs`):
///   <resource>/runtime/node/<node>          node binary
///   <resource>/runtime/dsh/.../lib/bin.js   @deepseek-ai/dsh CLI
///
/// Dev fallback: `node` from PATH and `DSH_DESKTOP_DSH_BIN`, defaulting to
/// the repo's built `apps/cli/lib/bin.js` when present.
pub(crate) fn resolve_runtime(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource dir unavailable: {e}"))?;
    let runtime_root = resource_dir.join("runtime");

    let node_exe = if cfg!(windows) { "node.exe" } else { "node" };
    let bundled_node = runtime_root.join("node").join(node_exe);
    // pnpm deploy lays the target package out at the closure root: lib/bin.js.
    let bundled_bin = runtime_root.join("dsh").join("lib").join("bin.js");

    if bundled_node.exists() && bundled_bin.exists() {
        return Ok((plain_path(&bundled_node), plain_path(&bundled_bin)));
    }

    // A bundled closure without its Node binary is the installed-app case where
    // the runtime was incompletely deployed (an installer that dropped the
    // binary, or antivirus quarantine). Falling through to PATH silently made
    // the app depend on a Node the user happened to have installed, so record
    // the miss before falling back.
    if bundled_bin.exists() && !bundled_node.exists() {
        append_startup_log(&format!(
            "bundled node missing at {}; falling back to PATH node",
            bundled_node.display()
        ));
    }

    // Dev fallback.
    let node = std::env::var("DSH_DESKTOP_NODE").unwrap_or_else(|_| "node".into());
    let dsh_bin = std::env::var("DSH_DESKTOP_DSH_BIN").unwrap_or_else(|_| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("cli")
            .join("lib")
            .join("bin.js")
            .to_string_lossy()
            .into_owned()
    });
    if !PathBuf::from(&dsh_bin).exists() {
        return Err(format!(
            "no bundled runtime found at {bundled_bin:?} and no built dsh CLI at {dsh_bin}"
        ));
    }
    Ok((
        plain_path(&PathBuf::from(node)),
        plain_path(&PathBuf::from(dsh_bin)),
    ))
}

/// The app is a GUI process (windows_subsystem = windows); spawned children
/// otherwise create a visible console window. Suppress it.
fn no_window(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Process-relative clock for the startup log. Launches are diagnosed by
/// comparing phases — shell init, child spawn, child readiness — so every
/// record carries the elapsed milliseconds since the shell's `run` began.
static STARTUP_CLOCK: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Start the startup clock. Called once from `run`, before any phase it times.
pub(crate) fn start_startup_clock() {
    let _ = STARTUP_CLOCK.set(std::time::Instant::now());
}

/// Append one line to the Prism harness home's `desktop-startup.log`, which the shell can
/// write even when the app log dir is unavailable; never fails the caller.
pub(crate) fn append_startup_log(message: &str) {
    let startup_log = crate::setup::dsh_home().join("desktop-startup.log");
    let elapsed = STARTUP_CLOCK
        .get()
        .map(|start| start.elapsed().as_millis())
        .unwrap_or_default();
    let _ = std::fs::create_dir_all(&crate::setup::dsh_home());
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&startup_log)
        .and_then(|mut file| {
            use std::io::Write;
            writeln!(file, "+{elapsed}ms {message}")
        });
}

/// Windows verbatim paths (`\\?\C:\...`, produced by canonicalization inside
/// Tauri's resource_dir) crash node's main-script resolver with
/// `EISDIR ... lstat 'C:'`. Strip the prefix so node receives a normal path.
fn plain_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p.to_path_buf()
    }
}

#[derive(Serialize)]
pub struct DshStatus {
    pub running: bool,
    pub port: u16,
    pub url: Option<String>,
    /// Runtime-resolution failure, when the shell could not start the child at
    /// all. The shell page renders it as the startup error.
    pub error: Option<String>,
}

#[tauri::command]
pub fn dsh_status(state: tauri::State<'_, DshHandle>) -> DshStatus {
    DshStatus {
        running: port_open(state.port()),
        port: state.port(),
        url: state.auth_url.lock().unwrap().clone(),
        error: state.startup_error.lock().unwrap().clone(),
    }
}

#[tauri::command]
pub fn restart_dsh(state: tauri::State<'_, DshHandle>) {
    state.request_restart();
}

#[tauri::command]
pub fn open_ui(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn parses_the_authenticated_web_launch_url() {
        assert_eq!(
            parse_launch_url("dsh web: http://127.0.0.1:3081/?token=abc-def"),
            Some("http://127.0.0.1:3081/?token=abc-def".to_string()),
        );
    }

    #[test]
    fn parses_the_first_url_before_the_lan_suffix() {
        assert_eq!(
            parse_launch_url(
                "dsh web: http://127.0.0.1:3081/?token=abc (LAN: http://192.168.1.8:3081/?token=abc)"
            ),
            Some("http://127.0.0.1:3081/?token=abc".to_string()),
        );
    }

    #[test]
    fn ignores_lines_without_the_web_url_announcement() {
        assert_eq!(parse_launch_url("ready on 127.0.0.1:3081"), None);
    }

    #[test]
    fn select_port_returns_default_when_free() {
        if port_free(INTERNAL_PORT) {
            assert_eq!(select_port().unwrap(), INTERNAL_PORT);
        }
    }

    #[test]
    fn select_port_skips_occupied_ports() {
        // When both the default and the first fallback are occupied, the scan
        // must move past them and return a port that is actually bindable.
        let default = std::net::TcpListener::bind(("127.0.0.1", INTERNAL_PORT));
        let next = std::net::TcpListener::bind(("127.0.0.1", INTERNAL_PORT + 1));
        let (Ok(default), Ok(next)) = (default, next) else {
            return;
        };
        let port = select_port().unwrap();
        assert_ne!(port, INTERNAL_PORT);
        assert_ne!(port, INTERNAL_PORT + 1);
        assert!(port_free(port));
        drop(default);
        drop(next);
    }

    #[test]
    fn join_paths_accepts_split_inherited_path() {
        // Regression for the hub-never-spawned bug: the spawn PATH builder
        // must split the inherited PATH into elements before joining. POSIX
        // join_paths rejects an element containing ':' — and the whole PATH
        // string always does — which silently killed the hub spawn on
        // mac/linux while Windows (no ';' check) kept working.
        let Ok(existing) = std::env::var("PATH") else {
            return;
        };
        #[cfg(not(windows))]
        assert!(std::env::join_paths([&existing]).is_err());
        let elements: Vec<_> = std::env::split_paths(&existing).collect();
        assert!(std::env::join_paths(elements).is_ok());
    }

    #[test]
    fn accepts_the_launch_url_token() {
        assert_eq!(
            launch_token("http://127.0.0.1:3081/?token=abc-def", 3081),
            Some("abc-def".to_string()),
        );
    }

    #[test]
    fn rejects_urls_that_name_another_port_or_no_token() {
        assert_eq!(launch_token("http://127.0.0.1:3082/?token=abc", 3081), None);
        assert_eq!(launch_token("http://127.0.0.1:3081/", 3081), None);
        assert_eq!(launch_token("http://127.0.0.1:3081/?token=", 3081), None);
        assert_eq!(
            launch_token("http://192.168.1.8:3081/?token=abc", 3081),
            None
        );
    }

    #[test]
    fn adopts_the_recorded_server_while_its_token_is_accepted() {
        let token = "live-token";
        let port = stub_web_server(token);
        let bin = adopt_test_dir().join("adopt-live-bin.js");
        std::fs::write(&bin, b"cli entry").expect("write stub bin");
        let record = adopt_test_dir().join("adopt-live-record.json");
        write_record_file(&record, port, &bin, token, std::process::id());

        let adopted = adopt_decision(&record, &bin).expect("live server is adoptable");
        assert_eq!(adopted.port, port);
        assert_eq!(
            adopted.url,
            format!("http://127.0.0.1:{port}/?token={token}")
        );
    }

    #[test]
    fn rejects_a_record_whose_token_no_longer_authenticates() {
        let port = stub_web_server("the-live-token");
        let bin = adopt_test_dir().join("adopt-stale-token-bin.js");
        std::fs::write(&bin, b"cli entry").expect("write stub bin");
        let record = adopt_test_dir().join("adopt-stale-token-record.json");
        write_record_file(
            &record,
            port,
            &bin,
            "a-token-from-another-process",
            std::process::id(),
        );

        assert!(adopt_decision(&record, &bin).is_none());
    }

    #[test]
    fn rejects_a_record_from_a_runtime_this_shell_no_longer_runs() {
        let token = "live-token";
        let port = stub_web_server(token);
        let bin = adopt_test_dir().join("adopt-updated-bin.js");
        std::fs::write(&bin, b"cli entry").expect("write stub bin");
        let record = adopt_test_dir().join("adopt-updated-record.json");
        write_record_file(&record, port, &bin, token, std::process::id());

        // An app update replaces the bundled closure in place.
        std::fs::write(&bin, b"cli entry after the update").expect("replace stub bin");
        assert!(adopt_decision(&record, &bin).is_none());
    }

    #[test]
    fn reports_no_adoption_without_a_record() {
        let bin = adopt_test_dir().join("adopt-missing-bin.js");
        std::fs::write(&bin, b"cli entry").expect("write stub bin");
        let record = adopt_test_dir().join("adopt-missing-record.json");
        let _ = std::fs::remove_file(&record);

        assert!(adopt_decision(&record, &bin).is_none());
    }

    /// Quitting ends the hub through `end_owned_child`, so prove that primitive
    /// ends a live process rather than only the shell's pid bookkeeping. A
    /// machine without the runtime the hub runs on cannot pose the question.
    #[test]
    fn ends_a_live_child_process() {
        let Some(mut child) = spawn_sleeper() else {
            return;
        };
        assert!(
            child.try_wait().expect("probe the sleeper").is_none(),
            "the sleeper runs before the quit"
        );

        tauri::async_runtime::block_on(end_owned_child(&mut child));

        assert!(
            matches!(child.try_wait(), Ok(Some(_))),
            "the quit ended the hub"
        );
    }

    /// A live process standing in for a hub: what the quit must end.
    fn spawn_sleeper() -> Option<Child> {
        Command::new("node")
            .args(["-e", "setTimeout(() => {}, 60000)"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok()
    }

    /// Cross-process check of the adoption contract against a real `dsh web`
    /// server: the launch token of a live server is adoptable, and the same
    /// record stops being adoptable once the server is gone. Skipped unless
    /// `DSH_DESKTOP_ADOPT_E2E` names a bundled runtime as `<node>|<dsh bin>`,
    /// because it starts a server and binds a loopback port.
    #[test]
    fn adopts_a_live_dsh_web_server_and_rejects_it_once_gone() {
        let Some(runtime) = std::env::var("DSH_DESKTOP_ADOPT_E2E").ok() else {
            return;
        };
        let (node, bin) = runtime
            .split_once('|')
            .expect("DSH_DESKTOP_ADOPT_E2E is <node>|<dsh bin>");
        let bin = PathBuf::from(bin);
        let home = adopt_test_dir().join("live-home");
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).expect("create live home");
        let port = {
            let probe = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("reserve a port");
            probe.local_addr().expect("reserved address").port()
        };
        let mut child = std::process::Command::new(node)
            .arg(&bin)
            .args(["web", "--port", &port.to_string(), "--no-open"])
            .env("DSH_HOME", &home)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn dsh web");
        let stdout = child.stdout.take().expect("child stdout");
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stdout);
            for line in std::io::BufRead::lines(reader).map_while(Result::ok) {
                if parse_launch_url(&line).is_some() {
                    let _ = sender.send(line);
                    break;
                }
            }
        });
        let announcement = receiver
            .recv_timeout(Duration::from_secs(120))
            .expect("dsh web announced its launch URL");
        let url = parse_launch_url(&announcement).expect("launch URL");
        let token = launch_token(&url, port).expect("launch token");

        let child_pid = child.id();
        let record = adopt_test_dir().join("live-record.json");
        write_record_file(&record, port, &bin, &token, child_pid);
        assert!(
            adopt_decision(&record, &bin).is_some(),
            "live server is adoptable"
        );

        // Restarting while adopted ends that server by pid, which the
        // supervisor's port watch turns into a cold spawn.
        terminate_pid(child_pid);
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while port_open(port) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!port_open(port), "the adopted server released its port");
        let _ = child.wait();
        assert!(
            adopt_decision(&record, &bin).is_none(),
            "a dead server is not adoptable"
        );
    }

    /// Scratch directory for record files, kept inside the build tree instead of
    /// a shared temp directory.
    fn adopt_test_dir() -> PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("adopt-tests");
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    /// Write the record a spawn would have written for `port` and `bin`.
    fn write_record_file(path: &Path, port: u16, bin: &Path, token: &str, pid: u32) {
        let (bin_len, bin_modified_ms) = runtime_identity(bin).expect("stub bin identity");
        let record = ServerRecord {
            port,
            url: format!("http://127.0.0.1:{port}/?token={token}"),
            pid,
            bin: bin.to_string_lossy().into_owned(),
            bin_len,
            bin_modified_ms,
        };
        std::fs::write(path, serde_json::to_vec(&record).expect("serialize record"))
            .expect("write record");
    }

    /// Loopback server answering `token` with the cookie-minting 303
    /// `BrowserAuth::authorizeIndex` sends and every other token with 401. The
    /// thread outlives the test on purpose: the harness exits without joining it.
    fn stub_web_server(token: &'static str) -> u16 {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind stub server");
        let port = listener.local_addr().expect("stub address").port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut request = [0u8; 512];
                let read = stream.read(&mut request).unwrap_or(0);
                let head = String::from_utf8_lossy(&request[..read]).to_string();
                let status = if head.starts_with(&format!("GET /?token={token} ")) {
                    "HTTP/1.1 303 See Other\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                } else {
                    "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
                };
                let _ = stream.write_all(status.as_bytes());
            }
        });
        port
    }
}
