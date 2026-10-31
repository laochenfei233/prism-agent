// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
//! Shell-owned updater state machine.
//!
//! tauri-plugin-updater owns endpoint fetching, signature verification, and the
//! installer handoff; this module owns what clients see. A snapshot is a
//! superset of the Web client's `DesktopUpdatePresentation` (`phase`,
//! `version`, `percent`, `failure`) plus the About-page facts (current
//! version, last check, last error, and the update source derived from the
//! configured endpoint — GitHub Releases only, no override seam). Every
//! transition emits [`STATE_EVENT`]; the shell page relays it into the
//! embedded UI, where the compact indicator, the sidebar badge, and the
//! About section all render from it.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};

use crate::dsh_runner::DshHandle;

/// Delay before the launch-time silent check, staggered off the startup burst.
const AUTO_CHECK_DELAY: Duration = Duration::from_secs(30);
/// Durable state file under the app data directory.
const STATE_FILE: &str = "update-state.json";
/// Update-state event; the shell page relays it into the embedded UI.
pub const STATE_EVENT: &str = "prism://update-state";

/// Update lifecycle phase; wire values follow the client presentation contract.
/// The contract's `verifying` phase never occurs here: signature verification
/// happens inside the plugin's download step.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Idle,
    Checking,
    Available,
    Downloading,
    Installing,
    Ready,
    Error,
}

/// Classified failure family; wire values match `DesktopUpdateFailureKind`.
/// The Electron-heritage `tasks-*` kinds cannot occur in this shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum FailureKind {
    Check,
    CheckNetwork,
    Download,
    DownloadNetwork,
    Install,
    InstallNetwork,
    StopFailed,
}

/// The updater operation a failure happened in; picks the base failure kind
/// and whether a transport-level error upgrades it to the `-network` variant.
enum Operation {
    Check,
    Download,
    Install,
}

/// Where updates come from, parsed from the configured updater endpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSource {
    /// `owner/name` of the GitHub repository serving updates; empty when the
    /// endpoint is not a GitHub releases URL (the About section then hides
    /// the repository line; the plugin-side checks still fail loudly).
    repo: String,
    /// Human-facing releases page used by the About section's links.
    release_url: String,
}

/// Wire snapshot handed to commands and the [`STATE_EVENT`] payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    phase: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<FailureKind>,
    current_version: String,
    /// Unix epoch milliseconds of the last completed check.
    #[serde(skip_serializing_if = "Option::is_none")]
    last_check: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    source: UpdateSource,
}

/// Fields that survive restarts; everything else is rebuilt on boot.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PersistedState {
    last_check: Option<u64>,
    last_error: Option<String>,
    known_latest: Option<String>,
}

/// Mutable fields behind the managed state.
struct Fields {
    phase: Phase,
    version: Option<String>,
    percent: Option<u8>,
    failure: Option<FailureKind>,
    last_check: Option<u64>,
    last_error: Option<String>,
    known_latest: Option<String>,
    current_version: String,
    source: UpdateSource,
}

/// Managed updater state: the fields plus one-shot guards so double clicks
/// join the running operation instead of racing it.
pub struct UpdateState {
    fields: Mutex<Fields>,
    checking: AtomicBool,
    installing: AtomicBool,
}

impl UpdateState {
    /// Builds the initial state: current version from the package, the update
    /// source from the configured endpoint, and the durable fields from disk.
    pub fn new(app: &AppHandle) -> Self {
        let fields = Fields {
            phase: Phase::Idle,
            version: None,
            percent: None,
            failure: None,
            last_check: None,
            last_error: None,
            known_latest: None,
            current_version: app.package_info().version.to_string(),
            source: source_from_endpoint(endpoint_from_config(app)),
        };
        let persisted = load_persisted(&state_path(app));
        Self {
            fields: Mutex::new(Fields {
                last_check: persisted.last_check,
                last_error: persisted.last_error,
                known_latest: persisted.known_latest,
                ..fields
            }),
            checking: AtomicBool::new(false),
            installing: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Fields> {
        self.fields.lock().expect("update state mutex poisoned")
    }
}

/// Classifies an updater error by the operation it happened in.
fn classify_failure(operation: Operation, error: &UpdaterError) -> FailureKind {
    let network = matches!(error, UpdaterError::Reqwest(_) | UpdaterError::Network(_));
    match (operation, network) {
        (Operation::Check, true) => FailureKind::CheckNetwork,
        (Operation::Check, false) => FailureKind::Check,
        (Operation::Download, true) => FailureKind::DownloadNetwork,
        (Operation::Download, false) => FailureKind::Download,
        (Operation::Install, true) => FailureKind::InstallNetwork,
        (Operation::Install, false) => FailureKind::Install,
    }
}

/// Whole percent for a download, or `None` when the value must not render:
/// unknown total (indeterminate), empty body, or no change since the last
/// emission (the progress event is throttled to percent steps).
fn progress_percent(downloaded: u64, total: Option<u64>, previous: Option<u8>) -> Option<u8> {
    let total = total?;
    if total == 0 {
        return None;
    }
    let percent = ((downloaded * 100) / total).min(100) as u8;
    (Some(percent) != previous).then_some(percent)
}

/// Maps the configured updater endpoint to the human-facing source facts.
/// Anything that is not a GitHub releases URL yields an empty source, which
/// the About section renders as "source unavailable" while checks fail loudly.
fn source_from_endpoint(endpoint: Option<&str>) -> UpdateSource {
    let parsed = endpoint.and_then(|value| tauri::Url::parse(value).ok());
    let segments = parsed
        .filter(|url| url.host_str() == Some("github.com"))
        .map(|url| {
            url.path_segments()
                .map(|segments| segments.map(str::to_string).collect::<Vec<_>>())
        })
        .unwrap_or_default();
    match segments {
        Some(segments) if segments.len() >= 2 => {
            let repo = format!("{}/{}", segments[0], segments[1]);
            UpdateSource {
                release_url: format!("https://github.com/{repo}/releases"),
                repo,
            }
        }
        _ => UpdateSource {
            repo: String::new(),
            release_url: String::new(),
        },
    }
}

/// First endpoint of `plugins.updater.endpoints` from the Tauri config.
fn endpoint_from_config(app: &AppHandle) -> Option<&str> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .and_then(|endpoints| endpoints.first())
        .and_then(|endpoint| endpoint.as_str())
}

fn state_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(STATE_FILE))
}

/// Reads the durable fields; unreadable or malformed content resets to the
/// defaults and says so — a corrupt state file must never block updates.
fn load_persisted(path: &Option<PathBuf>) -> PersistedState {
    let Some(path) = path else {
        return PersistedState::default();
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return PersistedState::default();
    };
    match serde_json::from_str(&raw) {
        Ok(state) => state,
        Err(error) => {
            eprintln!("update: ignoring malformed {STATE_FILE}: {error}");
            PersistedState::default()
        }
    }
}

/// Writes the durable fields; failures are logged and otherwise ignored — the
/// state file is a convenience, not a correctness dependency.
fn persist(path: &Option<PathBuf>, fields: &Fields) {
    let Some(path) = path else { return };
    let persisted = PersistedState {
        last_check: fields.last_check,
        last_error: fields.last_error.clone(),
        known_latest: fields.known_latest.clone(),
    };
    let Ok(raw) = serde_json::to_string_pretty(&persisted) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(error) = std::fs::write(path, raw + "\n") {
        eprintln!("update: could not write {STATE_FILE}: {error}");
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Snapshots the current fields for the wire.
fn snapshot_from(fields: &Fields) -> UpdateSnapshot {
    UpdateSnapshot {
        phase: fields.phase,
        version: fields.version.clone(),
        percent: fields.percent,
        failure: fields.failure,
        current_version: fields.current_version.clone(),
        last_check: fields.last_check,
        last_error: fields.last_error.clone(),
        source: fields.source.clone(),
    }
}

/// Emits the current snapshot and returns it.
fn emit_state(app: &AppHandle) -> UpdateSnapshot {
    let state = app.state::<UpdateState>();
    let snapshot = snapshot_from(&state.lock());
    let _ = app.emit(STATE_EVENT, snapshot.clone());
    snapshot
}

/// Applies one transition, emits it, and optionally persists the durable
/// fields. Percent ticks pass `persist = false` so a 126 MB download does not
/// rewrite the state file a hundred times.
fn commit_state<F>(app: &AppHandle, persist_fields: bool, mutate: F) -> UpdateSnapshot
where
    F: FnOnce(&mut Fields),
{
    {
        let state = app.state::<UpdateState>();
        let mut fields = state.lock();
        mutate(&mut fields);
        if persist_fields {
            persist(&state_path(app), &fields);
        }
    }
    emit_state(app)
}

/// One endpoint check; shared by the manual command and the launch-time
/// silent check.
async fn check_once(app: &AppHandle) -> Result<Option<Update>, UpdaterError> {
    app.updater()?.check().await
}

/// Runs a check to completion: transitions, persistence, event, snapshot.
/// A concurrent check or install joins by returning the current snapshot.
async fn run_check(app: &AppHandle) -> UpdateSnapshot {
    {
        let state = app.state::<UpdateState>();
        if state.installing.load(Ordering::SeqCst) || state.checking.swap(true, Ordering::SeqCst) {
            return snapshot_from(&state.lock());
        }
    }
    commit_state(app, false, |fields| {
        fields.phase = Phase::Checking;
        fields.percent = None;
    });
    let outcome = check_once(app).await;
    let snapshot = commit_state(app, true, |fields| {
        fields.last_check = Some(now_millis());
        match &outcome {
            Ok(Some(update)) => {
                fields.phase = Phase::Available;
                fields.version = Some(update.version.clone());
                fields.percent = None;
                fields.failure = None;
                fields.last_error = None;
                fields.known_latest = Some(update.version.clone());
            }
            Ok(None) => {
                fields.phase = Phase::Idle;
                fields.version = None;
                fields.percent = None;
                fields.failure = None;
                fields.last_error = None;
                fields.known_latest = Some(fields.current_version.clone());
            }
            Err(error) => {
                fields.phase = Phase::Error;
                fields.version = None;
                fields.percent = None;
                fields.failure = Some(classify_failure(Operation::Check, error));
                fields.last_error = Some(error.to_string());
            }
        }
    });
    app.state::<UpdateState>()
        .checking
        .store(false, Ordering::SeqCst);
    snapshot
}

/// Runs the install to completion: re-check for an `Update` handle, download
/// with percent-throttled progress, stop the dsh runtime, then hand off to the
/// installer. On Windows the plugin exits the process after launching the
/// installer — `RunEvent::Exit` never fires, which is why the runtime is
/// stopped explicitly — and the installer restarts the app by default.
async fn run_install(app: &AppHandle) -> UpdateSnapshot {
    let update = match check_once(app).await {
        Ok(Some(update)) => update,
        Ok(None) => {
            return commit_state(app, true, |fields| {
                fields.phase = Phase::Idle;
                fields.version = None;
                fields.percent = None;
                fields.failure = None;
                fields.last_error = None;
                fields.known_latest = Some(fields.current_version.clone());
                fields.last_check = Some(now_millis());
            });
        }
        Err(error) => {
            return commit_state(app, true, |fields| {
                fields.phase = Phase::Error;
                fields.failure = Some(classify_failure(Operation::Check, &error));
                fields.last_error = Some(error.to_string());
                fields.last_check = Some(now_millis());
            });
        }
    };

    commit_state(app, false, |fields| {
        fields.phase = Phase::Downloading;
        fields.version = Some(update.version.clone());
        fields.percent = None;
        fields.failure = None;
    });

    let app_for_progress = app.clone();
    // The download closures run on the async runtime and must be Sync, so the
    // accumulators are atomics: the percent sentinel 255 encodes "no previous
    // emission" for the throttle.
    const NO_PREVIOUS_PERCENT: u8 = u8::MAX;
    let downloaded = AtomicU64::new(0);
    let last_percent = AtomicU8::new(NO_PREVIOUS_PERCENT);
    let bytes = match update
        .download(
            |chunk: usize, total: Option<u64>| {
                let seen = downloaded.fetch_add(chunk as u64, Ordering::SeqCst) + chunk as u64;
                let previous = last_percent.load(Ordering::SeqCst);
                let previous_option = (previous != NO_PREVIOUS_PERCENT).then_some(previous);
                if let Some(percent) = progress_percent(seen, total, previous_option) {
                    last_percent.store(percent, Ordering::SeqCst);
                    commit_state(&app_for_progress, false, |fields| {
                        fields.percent = Some(percent);
                    });
                }
            },
            || {},
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            return commit_state(app, true, |fields| {
                fields.phase = Phase::Error;
                fields.percent = None;
                fields.failure = Some(classify_failure(Operation::Download, &error));
                fields.last_error = Some(error.to_string());
            });
        }
    };

    // The installer is about to replace the binary and prune everything under
    // the runtime directory, so the child must be down first. `stop()` is
    // synchronous and idempotent.
    let Some(dsh) = app.try_state::<DshHandle>() else {
        return commit_state(app, true, |fields| {
            fields.phase = Phase::Error;
            fields.percent = None;
            fields.failure = Some(FailureKind::StopFailed);
            fields.last_error = Some("dsh runtime handle is not registered".to_string());
        });
    };
    dsh.stop();

    commit_state(app, false, |fields| {
        fields.phase = Phase::Installing;
        fields.percent = None;
    });
    match update.install(bytes) {
        // On Windows the plugin exits the process during install; the ready
        // state is what other platforms (which require a manual relaunch) see.
        Ok(()) => commit_state(app, true, |fields| {
            fields.phase = Phase::Ready;
            fields.failure = None;
            fields.last_error = None;
            fields.known_latest = Some(update.version.clone());
        }),
        Err(error) => commit_state(app, true, |fields| {
            fields.phase = Phase::Error;
            fields.percent = None;
            fields.failure = Some(classify_failure(Operation::Install, &error));
            fields.last_error = Some(error.to_string());
        }),
    }
}

/// Launch-time silent check: one delayed round whose failures only land in
/// the state file and the About section, never in the user's face.
pub fn schedule_auto_check(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(AUTO_CHECK_DELAY).await;
        let _ = run_check(&handle).await;
    });
}

/// Current update state; the client's first question after subscribing.
#[tauri::command]
pub fn prism_update_state(app: AppHandle) -> UpdateSnapshot {
    snapshot_from(&app.state::<UpdateState>().lock())
}

/// Manual check from the About section; also the indicator's retry path.
#[tauri::command]
pub async fn prism_check_update(app: AppHandle) -> UpdateSnapshot {
    run_check(&app).await
}

/// Install handoff; the shell decides the sequence, the client only asks.
#[tauri::command]
pub async fn prism_install_update(app: AppHandle) -> UpdateSnapshot {
    let state = app.state::<UpdateState>();
    if state.checking.load(Ordering::SeqCst) || state.installing.swap(true, Ordering::SeqCst) {
        return snapshot_from(&state.lock());
    }
    let snapshot = run_install(&app).await;
    state.installing.store(false, Ordering::SeqCst);
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_state_path(name: &str) -> Option<PathBuf> {
        // The temp directory is not writable in every sandboxed environment;
        // the crate's own target directory always is, and is not committed.
        Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target/update-state-tests")
                .join(format!("{name}-{STATE_FILE}")),
        )
    }

    #[test]
    fn progress_percent_tracks_whole_percent_and_throttles() {
        let total = Some(1000);
        assert_eq!(progress_percent(0, total, None), Some(0));
        assert_eq!(progress_percent(400, total, Some(0)), Some(40));
        assert_eq!(progress_percent(404, total, Some(40)), None);
        assert_eq!(progress_percent(1000, total, Some(40)), Some(100));
        assert_eq!(progress_percent(1000, total, Some(100)), None);
        assert_eq!(progress_percent(500, None, None), None);
        assert_eq!(progress_percent(500, Some(0), None), None);
        // Oversized totals or hostile content lengths cannot exceed 100.
        assert_eq!(progress_percent(9999, total, None), Some(100));
    }

    #[test]
    fn classify_splits_base_kinds_from_transport_failures() {
        use tauri_plugin_updater::Error as UpdaterError;
        let network = UpdaterError::Network("status 503".to_string());
        let local = UpdaterError::ReleaseNotFound;
        let io = UpdaterError::Io(std::io::Error::other("disk"));

        assert_eq!(
            classify_failure(Operation::Check, &network),
            FailureKind::CheckNetwork
        );
        assert_eq!(
            classify_failure(Operation::Check, &local),
            FailureKind::Check
        );
        assert_eq!(
            classify_failure(Operation::Download, &network),
            FailureKind::DownloadNetwork
        );
        assert_eq!(
            classify_failure(Operation::Download, &io),
            FailureKind::Download
        );
        assert_eq!(
            classify_failure(Operation::Install, &network),
            FailureKind::InstallNetwork
        );
        assert_eq!(
            classify_failure(Operation::Install, &io),
            FailureKind::Install
        );
    }

    #[test]
    fn snapshot_wire_keys_match_the_client_contract() {
        let fields = Fields {
            phase: Phase::Error,
            version: Some("0.2.2".to_string()),
            percent: Some(58),
            failure: Some(FailureKind::DownloadNetwork),
            last_check: Some(1_760_000_000_000),
            last_error: Some("download failed".to_string()),
            known_latest: Some("0.2.2".to_string()),
            current_version: "0.2.1-rc.4".to_string(),
            source: UpdateSource {
                repo: "laochenfei233/prism-agent".to_string(),
                release_url: "https://github.com/laochenfei233/prism-agent/releases".to_string(),
            },
        };
        let wire = serde_json::to_value(snapshot_from(&fields)).expect("snapshot serializes");
        let object = wire.as_object().expect("snapshot is an object");
        // The map is orderless on the wire; the lock is on the key set.
        let mut keys = object.keys().collect::<Vec<_>>();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "currentVersion",
                "failure",
                "lastCheck",
                "lastError",
                "percent",
                "phase",
                "source",
                "version",
            ]
        );
        assert_eq!(object["phase"], "error");
        assert_eq!(object["failure"], "download-network");
        assert_eq!(object["currentVersion"], "0.2.1-rc.4");
        assert_eq!(object["source"]["repo"], "laochenfei233/prism-agent");
        assert_eq!(
            object["source"]["releaseUrl"],
            "https://github.com/laochenfei233/prism-agent/releases"
        );

        // Optional facts are omitted rather than nulled, and the busy phases
        // stay lowercase exactly like the client's presentation union.
        let idle = Fields {
            phase: Phase::Idle,
            version: None,
            percent: None,
            failure: None,
            last_check: None,
            last_error: None,
            known_latest: None,
            current_version: "0.2.1-rc.4".to_string(),
            source: UpdateSource {
                repo: String::new(),
                release_url: String::new(),
            },
        };
        let wire = serde_json::to_value(snapshot_from(&idle)).expect("snapshot serializes");
        let object = wire.as_object().expect("snapshot is an object");
        assert_eq!(object.len(), 3);
        assert!(
            object.contains_key("phase")
                && object.contains_key("currentVersion")
                && object.contains_key("source")
        );
    }

    #[test]
    fn persisted_state_round_trips() {
        let path = temp_state_path("round-trip").expect("temp path");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &path,
            r#"{"lastCheck":123,"lastError":"boom","knownLatest":"0.3.0"}"#,
        )
        .expect("write");
        let persisted = load_persisted(&Some(path));
        assert_eq!(persisted.last_check, Some(123));
        assert_eq!(persisted.last_error.as_deref(), Some("boom"));
        assert_eq!(persisted.known_latest.as_deref(), Some("0.3.0"));
    }

    #[test]
    fn persisted_state_self_heals_from_missing_and_garbage() {
        assert_eq!(load_persisted(&None), PersistedState::default());
        let path = temp_state_path("garbage").expect("temp path");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, "{not json").expect("write");
        assert_eq!(load_persisted(&Some(path)), PersistedState::default());
    }

    #[test]
    fn source_parses_from_github_release_endpoints_only() {
        let github = source_from_endpoint(Some(
            "https://github.com/laochenfei233/prism-agent/releases/latest/download/latest.json",
        ));
        assert_eq!(github.repo, "laochenfei233/prism-agent");
        assert_eq!(
            github.release_url,
            "https://github.com/laochenfei233/prism-agent/releases"
        );

        let bare = source_from_endpoint(None);
        assert_eq!(
            bare,
            UpdateSource {
                repo: String::new(),
                release_url: String::new()
            }
        );
        let foreign = source_from_endpoint(Some(
            "https://example.com/a/b/releases/latest/download/latest.json",
        ));
        assert_eq!(foreign.repo, String::new());
        let shallow = source_from_endpoint(Some("https://github.com/releases"));
        assert_eq!(shallow.repo, String::new());
    }
}
