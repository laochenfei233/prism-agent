// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
//! Graceful shutdown for the Windows installer.
//!
//! A tray icon stays in the notification area when its process is terminated;
//! only its owner deleting it removes it. The installer therefore runs
//! `<install dir>\prism-agent.exe --quit` instead of terminating the shell
//! first. That process signals the running shell's named event and waits for
//! its named mutex to be abandoned, so the installer's poll finishes only
//! after the shell has gone through Tauri's exit path: the tray icon is
//! deleted and the hub is stopped before the process leaves.
//!
//! The event and mutex names include a hash of the executable's directory, so
//! the installer in one directory cannot signal a shell installed elsewhere.
//! `--quit` exits without opening a window or creating a tray icon of its own.

use std::ffi::OsStr;
#[cfg(any(windows, test))]
use std::path::Path;

/// Whether this process was started with `--quit`.
pub fn requested() -> bool {
    requested_in(std::env::args_os().skip(1))
}

fn requested_in<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .any(|arg| arg.as_ref() == OsStr::new("--quit"))
}

/// On Windows, signal the shell installed in this executable's directory and
/// wait up to 15 seconds for it to exit. Other platforms have no installer
/// hook to serve, so the call returns and the process exits without a window.
///
/// Called instead of starting the GUI. With no running shell this returns
/// immediately, leaving the installer nothing to kill.
pub fn request_running_instance_to_exit() {
    #[cfg(windows)]
    windows::request_running_instance_to_exit();
}

/// Register this shell's quit event and start the thread that exits the app
/// when an installer signals it. Windows only; other platforms have no
/// notification-area cache to clean up.
pub fn install(app: &tauri::AppHandle) {
    #[cfg(windows)]
    windows::install(app);
    #[cfg(not(windows))]
    let _ = app;
}

/// Named object scoped to one install directory.
#[cfg(any(windows, test))]
fn object_name(dir: &Path, suffix: &str) -> String {
    let raw = dir.to_string_lossy().replace('/', "\\");
    let raw = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    let dir = raw.trim_end_matches('\\').to_lowercase();
    format!(
        "Local\\PrismAgent.{:016x}.{suffix}",
        fnv1a64(dir.as_bytes())
    )
}

/// FNV-1a 64-bit. Stable across processes and releases, unlike `DefaultHasher`.
#[cfg(any(windows, test))]
fn fnv1a64(bytes: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    bytes.iter().fold(OFFSET, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(PRIME)
    })
}

#[cfg(windows)]
mod windows {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::ptr;
    use std::time::Duration;

    use tauri::AppHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Storage::FileSystem::SYNCHRONIZE;
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateMutexW, OpenEventW, OpenMutexW, SetEvent, WaitForSingleObject,
        EVENT_MODIFY_STATE, INFINITE,
    };

    use super::object_name;

    /// Longest wait for the running shell to finish exiting. The hub kill
    /// bound is 3 s; the rest covers WebView2 and window teardown.
    const EXIT_WAIT: Duration = Duration::from_secs(15);

    pub fn request_running_instance_to_exit() {
        let Some(dir) = install_dir() else { return };
        request_exit_for_dir(&dir);
    }

    fn request_exit_for_dir(dir: &Path) {
        let event_name = wide(&object_name(dir, "Quit"));
        // OpenEventW only sees an event a running shell already created; a
        // --quit process never creates one, so no shell means no new icon.
        // SAFETY: `event_name` is NUL-terminated and outlives the call.
        let event = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, event_name.as_ptr()) };
        if event.is_null() {
            return;
        }
        let mutex_name = wide(&object_name(dir, "Instance"));
        // SAFETY: `mutex_name` is NUL-terminated and outlives the call.
        let mutex = unsafe { OpenMutexW(SYNCHRONIZE, 0, mutex_name.as_ptr()) };
        // SAFETY: `event` is a live handle returned by OpenEventW above.
        unsafe { SetEvent(event) };
        if !mutex.is_null() {
            // The shell owns this mutex for its whole life. The wait returns
            // WAIT_ABANDONED when that process exits, which is what lets the
            // installer's poll finish only after the tray icon is gone.
            // SAFETY: `mutex` is a live handle returned by OpenMutexW above.
            unsafe { WaitForSingleObject(mutex, EXIT_WAIT.as_millis() as u32) };
        }
        // SAFETY: both handles came from the Open* calls above and are closed
        // exactly once here.
        unsafe {
            CloseHandle(event);
            if !mutex.is_null() {
                CloseHandle(mutex);
            }
        }
    }

    pub fn install(app: &AppHandle) {
        let Some(dir) = install_dir() else { return };
        // Create the mutex before the event: a helper that can open the event
        // then always finds the object whose abandonment marks this exit.
        let mutex_name = wide(&object_name(&dir, "Instance"));
        // The first shell in this directory owns the mutex; a second instance
        // gets a handle to the same object without ownership.
        // SAFETY: `mutex_name` is NUL-terminated and outlives the call.
        let mutex = unsafe { CreateMutexW(ptr::null(), 1, mutex_name.as_ptr()) };
        if mutex.is_null() {
            crate::dsh_runner::append_startup_log("quit: instance mutex unavailable");
        }
        let event_name = wide(&object_name(&dir, "Quit"));
        // SAFETY: `event_name` is NUL-terminated and outlives the call.
        let event = unsafe { CreateEventW(ptr::null(), 1, 0, event_name.as_ptr()) };
        if event.is_null() {
            crate::dsh_runner::append_startup_log("quit: named event unavailable");
            if !mutex.is_null() {
                // SAFETY: the handle came from CreateMutexW above.
                unsafe { CloseHandle(mutex) };
            }
            return;
        }
        let app = app.clone();
        // Raw handles are not Send; carry them as usize and rebuild the owner
        // inside the thread that keeps them open.
        let event = event as usize;
        let mutex = mutex as usize;
        std::thread::spawn(move || {
            let _event = OwnedHandle(event as HANDLE);
            let _mutex = OwnedHandle(mutex as HANDLE);
            // SAFETY: `_event` keeps the handle open for the whole wait.
            unsafe { WaitForSingleObject(_event.0, INFINITE) };
            app.exit(0);
        });
    }

    fn install_dir() -> Option<PathBuf> {
        std::env::current_exe()
            .ok()?
            .parent()
            .map(Path::to_path_buf)
    }

    fn wide(value: &str) -> Vec<u16> {
        OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: this handle came from CreateEventW/CreateMutexW and
                // is closed exactly once, when the owner is dropped.
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use std::sync::mpsc;
        use std::time::Instant;

        use super::*;

        #[test]
        fn wait_returns_after_the_owning_thread_exits() {
            let dir = PathBuf::from(format!(r"C:\prism-quit-test-{}", std::process::id()));
            let event_name = wide(&object_name(&dir, "Quit"));
            let mutex_name = wide(&object_name(&dir, "Instance"));
            let (ready, ready_rx) = mpsc::channel();
            let shell = std::thread::spawn(move || {
                // SAFETY: both names are NUL-terminated and outlive the calls;
                // the handles stay open through the OwnedHandle wrappers.
                let event = unsafe { CreateEventW(ptr::null(), 1, 0, event_name.as_ptr()) };
                let mutex = unsafe { CreateMutexW(ptr::null(), 1, mutex_name.as_ptr()) };
                let event = OwnedHandle(event);
                let _mutex = OwnedHandle(mutex);
                ready.send(()).unwrap();
                // SAFETY: `event` keeps the handle open for this wait.
                unsafe { WaitForSingleObject(event.0, INFINITE) };
                // Let the helper observe the mutex ownership before this
                // thread exits and abandons it.
                std::thread::sleep(Duration::from_millis(300));
            });
            ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            let started = Instant::now();
            request_exit_for_dir(&dir);
            let elapsed = started.elapsed();
            assert!(elapsed >= Duration::from_millis(250), "{elapsed:?}");
            assert!(elapsed < Duration::from_secs(5), "{elapsed:?}");
            shell.join().unwrap();
        }

        #[test]
        fn no_running_shell_returns_without_waiting() {
            let dir = PathBuf::from(format!(r"C:\prism-quit-test-absent-{}", std::process::id()));
            let started = Instant::now();
            request_exit_for_dir(&dir);
            assert!(started.elapsed() < Duration::from_secs(1));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a64_matches_reference_vectors() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a64(b"foobar"), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn object_names_follow_the_install_directory() {
        let a = object_name(Path::new(r"C:\Program Files\Prism Agent"), "Quit");
        let b = object_name(Path::new(r"c:/program files/prism agent/"), "Quit");
        let verbatim = object_name(Path::new(r"\\?\C:\Program Files\Prism Agent"), "Quit");
        assert_eq!(a, b);
        assert_eq!(a, verbatim);
        assert_eq!(a, "Local\\PrismAgent.706b116101abfd9f.Quit");
        assert_ne!(a, object_name(Path::new(r"D:\Prism Agent"), "Quit"));
        assert_eq!(
            object_name(Path::new(r"C:\Program Files\Prism Agent"), "Instance"),
            "Local\\PrismAgent.706b116101abfd9f.Instance"
        );
    }

    #[test]
    fn quit_flag_is_an_exact_argument() {
        assert!(requested_in(["--quit"]));
        assert!(requested_in(["--no-open", "--quit"]));
        assert!(!requested_in(["--quit-later"]));
        assert!(!requested_in(std::iter::empty::<&str>()));
    }
}
