// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
//! Prism Agent desktop shell.
//!
//! The shell embeds the dsh web UI (served by the bundled `dsh` process on the
//! loopback `INTERNAL_PORT`) inside a native window. It owns the dsh child
//! process lifecycle (spawn, health probe, crash restart) and a tray icon that
//! keeps the app resident when the window closes.

mod dsh_runner;
mod quit;
mod setup;
mod tray;
mod update;

use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

use dsh_runner::DshHandle;

/// Default loopback port for the bundled `dsh web` process. When occupied, the
/// shell scans upward for a free port and delivers the authenticated launch
/// URL through `dsh://ready`. CLI users who run their own `dsh web` keep the
/// default 3080.
pub const INTERNAL_PORT: u16 = 3081;

/// The main window is declared in `tauri.conf.json` with `"create": false`
/// and built here instead: the `on_new_window` handler that routes popup
/// requests to the system browser is only reachable through the builder, and
/// the main window needs it as much as any window the app creates later.
fn build_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window_config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or_else(|| "No \"main\" window in the Tauri config".to_string())?;

    let handle = app.clone();
    let window = tauri::WebviewWindowBuilder::from_config(app, &window_config)
        .map_err(|e| e.to_string())?
        .on_new_window(move |url, _features: NewWindowFeatures| {
            open_new_window_externally(&handle, &url)
        })
        .build()
        .map_err(|e| e.to_string())?;
    // Windows can keep the previous taskbar icon under the same executable
    // identity. Set the window icon from the generated asset on every launch
    // so the taskbar and Alt-Tab surfaces converge on the current artwork.
    if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png")) {
        let _ = window.set_icon(icon);
    }
    allow_embedded_permissions(&window);
    Ok(())
}

/// Answer WebView2's permission requests for the embedded dsh UI.
///
/// WebView2 denies every kind it is not told about, and it never prompts on its
/// own, so the microphone failed with "Permission denied" before any user
/// decision. Wry installs a handler of its own for clipboard reads. This one
/// grants the kinds the desktop client can use — microphone, camera, screen
/// capture, geolocation, notifications, media playback, and file read/write —
/// and leaves the rest (MIDI, sensors, window management) unanswered.
#[cfg(windows)]
fn allow_embedded_permissions(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
        COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE, COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
        COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let attached = window.with_webview(|webview| unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(core) => core,
            Err(_) => return,
        };
        let mut token = 0;
        let _ = core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                let granted = [
                    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
                    COREWEBVIEW2_PERMISSION_KIND_CAMERA,
                    COREWEBVIEW2_PERMISSION_KIND_GEOLOCATION,
                    COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
                    COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ,
                    COREWEBVIEW2_PERMISSION_KIND_AUTOPLAY,
                    COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE,
                ];
                if granted.contains(&kind) {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            })),
            &mut token,
        );
        // Screen capture has no permission kind in this WebView2 SDK: the
        // frame's `display-capture` delegation in `ui/dist/index.html` is the
        // whole grant, and `getDisplayMedia` picks through WebView2's own UI.
    });
    if let Err(error) = attached {
        // The window still runs without the handlers; recording and the other
        // capabilities are what break, so the shell logs instead of refusing to
        // start.
        eprintln!("WebView2 permission handlers not attached: {error}");
    }
}

#[cfg(not(windows))]
fn allow_embedded_permissions(_window: &tauri::WebviewWindow) {}

/// Schemes we hand to the OS opener. The URL comes from web content, so only
/// the well-known link schemes pass; anything else is refused outright.
fn is_externally_openable(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto" | "tel")
}

/// Send every popup request — `window.open` and `target="_blank"` alike, from
/// the shell or from inside the dsh iframe — to the user's browser and refuse
/// the popup itself.
///
/// Without a handler the platform webview drops these requests on the floor,
/// which is what made `target="_blank"` links dead in the app: WebView2 marks
/// the request handled with nothing to show, so the click does nothing at all.
fn open_new_window_externally(
    app: &tauri::AppHandle,
    url: &tauri::Url,
) -> NewWindowResponse<tauri::Wry> {
    let openable = is_externally_openable(url);
    if openable {
        let opened = app.opener().open_url(url.as_str(), None::<&str>).is_ok()
            || open_with_os(url.as_str()).is_ok();
        log_new_window(app, url, openable, opened);
    }
    NewWindowResponse::Deny
}

/// Whether `cmd /C start` may receive this URL. The URL comes from web content
/// and cmd.exe parses the rest of its command line as text, so a metacharacter
/// would end the `start` command and run the remainder as a second command.
#[cfg(windows)]
fn is_cmd_startable(url: &str) -> bool {
    !url.is_empty()
        && url.chars().all(|c| {
            c.is_ascii_graphic()
                && !matches!(c, '&' | '|' | '<' | '>' | '^' | '%' | '"' | '(' | ')' | '!')
        })
}

/// OS-level fallback for the opener plugin: the shell runs without a console,
/// so an opener failure is invisible; `cmd start` / `open` / `xdg-open` are
/// the same calls the plugin wraps.
fn open_with_os(url: &str) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if !is_cmd_startable(url) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "URL contains characters cmd.exe would read as command text",
            ));
        }
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|_| ())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .status()
            .map(|_| ())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .status()
            .map(|_| ())
    }
}

/// Append one popup-routing record to the shell's debug log. The request is
/// denied by design, so this file is the only place a dead link leaves a trace.
fn log_new_window(app: &tauri::AppHandle, url: &tauri::Url, openable: bool, opened: bool) {
    if let Ok(log_dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&log_dir);
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("new-window.log"))
        {
            use std::io::Write;
            use std::time::{SystemTime, UNIX_EPOCH};
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let _ = writeln!(file, "{ts} {url} openable={openable} opened={opened}");
        }
    }
}

/// The app is a GUI process, so every console child (cmd.exe from pnpm's
/// .cmd shims, the market's netstat/taskkill probes, git, node-gyp, …) would
/// otherwise create its own visible console window — Node's windowsHide
/// defaults to false and CREATE_NO_WINDOW does not propagate. Giving the app
/// a hidden console makes every descendant attach to it instead.
#[cfg(windows)]
fn hide_child_consoles() {
    unsafe extern "system" {
        fn AllocConsole() -> i32;
        fn GetConsoleWindow() -> *mut core::ffi::c_void;
        fn ShowWindow(hwnd: *mut core::ffi::c_void, n_cmd_show: i32) -> i32;
    }
    unsafe {
        if AllocConsole() != 0 {
            ShowWindow(GetConsoleWindow(), 0); // SW_HIDE
        }
    }
}

#[cfg(not(windows))]
fn hide_child_consoles() {}

pub fn run() {
    // The installer runs this executable with `--quit` to remove the tray icon
    // through the same path as the tray menu. Never start a second shell.
    if quit::requested() {
        quit::request_running_instance_to_exit();
        return;
    }
    dsh_runner::start_startup_clock();
    hide_child_consoles();

    let builder = tauri::Builder::default();
    // A second launch must focus the running window instead of spawning
    // another shell, tray icon, and hub — in dev builds too, so a stray
    // `tauri dev` cannot open a second agent against the running app.
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        dsh_runner::append_startup_log("single-instance: focus window");
        tray::show_main_window(app);
    }));

    builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // Register the quit signal before the child and tray exist, so an
            // installer that signals during startup still exits through the
            // cleanup path.
            quit::install(app.handle());
            // Spawn the dsh child before the window exists. WebView2 environment
            // creation costs seconds on a cold start and the child's Node boot
            // costs seconds more; running them in sequence spent both. The child
            // publishes readiness through `dsh_status`, which the shell page
            // polls, so no window has to exist while the child starts, and the
            // managed state is registered before any page script can invoke it.
            // A runtime that cannot be resolved is carried as state instead of
            // aborting the launch, so the window still opens to report it.
            let handle = DshHandle::spawn(app.handle());
            app.manage(handle);
            // The updater state must exist before any page script can invoke
            // its commands; the delayed auto-check rides on the same state.
            app.manage(update::UpdateState::new(app.handle()));
            update::schedule_auto_check(app.handle());
            build_main_window(app.handle())?;
            dsh_runner::append_startup_log("window ready");
            tray::build(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides the app to the tray; the dsh process
            // keeps serving. Only the tray "Quit" action exits for real.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            dsh_runner::dsh_status,
            dsh_runner::authenticate_webview,
            dsh_runner::restart_dsh,
            dsh_runner::open_ui,
            update::prism_update_state,
            update::prism_check_update,
            update::prism_install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(dsh) = app_handle.try_state::<DshHandle>() {
                    dsh.stop();
                }
            }
        });
}

#[cfg(all(test, windows))]
mod cmd_start_tests {
    use super::is_cmd_startable;

    #[test]
    fn accepts_plain_link_urls() {
        assert!(is_cmd_startable("https://example.test/path?q=1#frag"));
        assert!(is_cmd_startable("mailto:user@example.test"));
        assert!(is_cmd_startable("tel:+10000000000"));
    }

    #[test]
    fn refuses_every_cmd_metacharacter() {
        for url in [
            "https://example.test/?a=1&calc",
            "mailto:user@example.test|calc",
            "https://example.test/<calc>",
            "https://example.test/^calc",
            "https://example.test/%PATH%",
            "https://example.test/\"calc\"",
            "https://example.test/(calc)",
            "https://example.test/!calc",
            "https://example.test/a b",
        ] {
            assert!(!is_cmd_startable(url), "{url}");
        }
    }

    #[test]
    fn open_with_os_refuses_a_metacharacter_url() {
        let error = super::open_with_os("https://example.test/?a=1&calc")
            .expect_err("the cmd fallback must refuse a metacharacter URL");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
    }
}
