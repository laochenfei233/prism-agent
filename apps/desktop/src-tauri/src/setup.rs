//! Desktop profile seeding: preinstall the bundled default plugins into the
//! web profile through the official patch and bundle layers before the dsh
//! process spawns.

use std::fs;
use std::path::{Path, PathBuf};

use serde_yaml::Value as Yaml;
use tauri::{AppHandle, Manager};

// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2), area A17.
/// Prism's harness home: `$PRISM_HOME` when set, otherwise the home the
/// Settings page recorded in `~/.prism-data-home`, otherwise the fork's default
/// `~/.prism` — the same root this fork's `prism` CLI defaults to — never a
/// deepseek-harness build's `~/.dsh`.
///
/// Resolved once per shell process: the shell seeds profiles, spawns the child
/// with `DSH_HOME`, and later reads its server record at this path, so a
/// Settings-page relocation must not move those calls mid-run.
pub fn dsh_home() -> PathBuf {
    static HOME: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    HOME.get_or_init(|| {
        let base = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        resolve_home(std::env::var("PRISM_HOME").ok(), Path::new(&base))
    })
    .clone()
}

/// Read the launch pointer a Settings-page relocation writes.
///
/// The pointer is read once per launch, before any service captures the home;
/// the child receives this value as `DSH_HOME`. A blank or relative record is
/// ignored, so a damaged file never moves the home somewhere unexpected.
fn resolve_home(override_home: Option<String>, base: &Path) -> PathBuf {
    if let Some(home) = override_home {
        return PathBuf::from(home);
    }
    if let Ok(raw) = fs::read_to_string(base.join(".prism-data-home")) {
        let recorded = PathBuf::from(raw.trim());
        if recorded.is_absolute() {
            return recorded;
        }
    }
    base.join(".prism")
}

#[cfg(test)]
mod home_tests {
    use super::resolve_home;
    use std::fs;
    use std::path::PathBuf;

    /// A scratch operating-system home for one case, under the crate's build directory.
    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("home-tests").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch home");
        dir
    }

    #[test]
    fn explicit_override_wins_over_the_pointer() {
        let base = scratch("override");
        fs::write(base.join(".prism-data-home"), "/ignored/pointer\n").expect("pointer");
        let resolved = resolve_home(Some("/explicit/home".to_string()), &base);
        assert_eq!(resolved, PathBuf::from("/explicit/home"));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn an_absolute_pointer_selects_the_home() {
        let base = scratch("pointer");
        let recorded = base.join("elsewhere");
        fs::write(base.join(".prism-data-home"), format!("{}\n", recorded.display())).expect("pointer");
        assert_eq!(resolve_home(None, &base), recorded);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_missing_blank_or_relative_pointer_keeps_the_default() {
        let base = scratch("default");
        assert_eq!(resolve_home(None, &base), base.join(".prism"));
        fs::write(base.join(".prism-data-home"), "   \n").expect("blank pointer");
        assert_eq!(resolve_home(None, &base), base.join(".prism"));
        fs::write(base.join(".prism-data-home"), "relative/home\n").expect("relative pointer");
        assert_eq!(resolve_home(None, &base), base.join(".prism"));
        let _ = fs::remove_dir_all(&base);
    }
}

fn profile_web_dir(home: &Path) -> PathBuf {
    home.join("profiles").join("web")
}

/// Drop non-mapping rows from a profile patch. Early shell builds wrote
/// `- insert:` fragments that parsed as sequences; the loader rejects any
/// non-mapping overlay entry, so self-heal on read.
fn sanitize_rows(rows: Vec<Yaml>) -> Vec<Yaml> {
    rows.into_iter().filter(|row| row.is_mapping()).collect()
}

/// Preinstalled default plugins (plugin market + Windows terminal
/// inspector). The shell copies them from the bundled runtime into the web
/// profile on every launch before the dsh process spawns. The
/// win-terminal-inspector copy AND its patch row are gated on the plugin
/// being present in the runtime: mac/linux bundles do not ship it, and an
/// entry the loader cannot resolve crashes the hub on every startup.
pub(crate) fn ensure_default_plugins(app: &AppHandle) -> Result<(), String> {
    let home = dsh_home();
    let profile = profile_web_dir(&home);
    // The patch layer below writes into the profile directory. Windows used
    // to create it as a side effect of the win-terminal copy; POSIX never
    // did, so a fresh profile left the patch write failing with ENOENT and
    // the hub never spawning (blank shell window, no logs).
    fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let runtime_plugins = match runtime_plugins_dir(app) {
        Ok(dir) => dir,
        Err(_) => return Ok(()), // dev without bundled plugins: nothing to preinstall
    };

    // A copy that mirrors an older installation keeps its old manifest and
    // build, and the loader skips the bundle when that manifest names peers
    // the running dsh no longer satisfies. Every launcher-owned copy is
    // therefore reconciled with the installation that is running now.
    let refresh_all = installation_changed(&home, &runtime_plugins);
    // dsh-plugin is an npm-distributed bundle (dsh.bundle.patch + dsh.client).
    // Copy it into the launcher-maintained flat module fallback so the bare
    // name resolves from the profile ("bundles come from the installation"),
    // and insert it under that name: the client module registry resolves the
    // entry name to serve the plugin-center tab. A path-based row loads the
    // server half but leaves the entry unresolvable by the registry.
    let mut copies_current = ensure_market_bundle(&home, &runtime_plugins, refresh_all)?;
    let (mut bundle_layers, local_current) =
        ensure_local_bundles(&home, &runtime_plugins, refresh_all)?;
    copies_current &= local_current;
    for bundle in ["@deepseek-ai/dsh-experimental-voice-input-bundle"] {
        if runtime_bundle_present(&runtime_plugins, bundle) {
            bundle_layers.push(bundle.to_string());
        }
    }
    bundle_layers.sort();
    bundle_layers.dedup();

    // dsh-win-terminal-inspector has no npm distribution; it ships as a local
    // copy inside the profile's plugins directory.
    let win_src = runtime_plugins.join("dsh-win-terminal-inspector");
    let win_present = win_src.exists();
    if win_present {
        let dest = profile.join("plugins").join("dsh-win-terminal-inspector");
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        copies_current &= place_launcher_copy(&win_src, &dest, refresh_all)?;
    }
    // The installation version is recorded only once every copy matches it, so
    // a copy this pass could not replace keeps the next launch retrying.
    if copies_current {
        record_installation(&home, &runtime_plugins);
    }

    let patch_path = profile.join("cordis.patch.yml");
    let mut rows: Vec<Yaml> = fs::read_to_string(&patch_path)
        .ok()
        .and_then(|raw| serde_yaml::from_str(&raw).ok())
        .map(sanitize_rows)
        .unwrap_or_default();
    // The plugin manager (`dsh plugin` / the market) records dsh-plugin in
    // the profile's `dsh.profile.bundles` on add/update; the loader composes
    // bundle layers before the patch layer, so inserting the same entry here
    // makes it fail with "duplicate loader entry id" and the hub crashes on
    // every launch. Only the patch layer owns dsh-plugin when the bundle
    // layer does not list it; a stale patch row an older shell wrote
    // unconditionally is dropped instead.
    if profile_bundles(&profile)
        .iter()
        .any(|bundle| bundle == "dsh-plugin")
    {
        remove_patch_row(&mut rows, "dsh-plugin");
    } else {
        upsert_patch_row(
            &mut rows,
            "dsh-plugin",
            "insert:\n  - id: dsh-plugin\n    name: dsh-plugin\n",
        )?;
    }
    if !bundle_layers.is_empty() || profile_bundles(&profile).iter().any(|bundle| is_retired_local_bundle(bundle)) {
        ensure_profile_bundles(&profile, &bundle_layers)?;
    }
    if win_present {
        if !has_patch_row(&rows, "win-terminal-inspector") {
            rows.push(serde_yaml::from_str(
                "insert:\n  - id: win-terminal-inspector\n    name: ./plugins/dsh-win-terminal-inspector/index.js\n",
            ).map_err(|e| format!("build patch row: {e}"))?);
        }
    } else {
        // Self-heal: older builds wrote the row unconditionally, and the
        // loader fails hard on the missing entry — drop it where the plugin
        // is not shipped.
        remove_patch_row(&mut rows, "win-terminal-inspector");
    }
    // MCP servers are per-instance config rows on the built-in mcp-client
    // bridge (already shipped in the runtime closure); a commented template
    // in the user patch layer makes local MCP support discoverable.
    let mut patch_text = serde_yaml::to_string(&rows).map_err(|e| e.to_string())?;
    if !patch_text.contains("dsh-mcp-client") {
        patch_text.push_str(MCP_TEMPLATE);
    }
    fs::write(&patch_path, patch_text).map_err(|e| e.to_string())?;
    Ok(())
}

/// Commented mcp-client template appended to the profile patch layer. MCP
/// servers are one config row per server (serverName/transport/command/args);
/// uncommenting and editing enables a server, hot-reloaded by the loader.
const MCP_TEMPLATE: &str = r#"
# MCP 服务器接入：内置 dsh-mcp-client，工具名形如 mcp__<server>__<tool>。
# 取消注释并填入你的服务器即启用（自动热重载）：
# - insert:
#     - id: mcp-my-server
#       name: '@deepseek-ai/dsh-mcp-client'
#       config:
#         serverName: my-server
#         transport: stdio
#         command: npx
#         args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir']
"#;

/// Copy the bundled dsh-plugin package into the profile module fallback
/// (`$DSH_HOME/profiles/node_modules`) so bare `dsh-plugin` resolves from the
/// profile through the ordinary parent-walk, exactly like an in-box bundle.
///
/// Returns whether the copy matches the installation.
fn ensure_market_bundle(
    home: &Path,
    runtime_plugins: &Path,
    refresh_all: bool,
) -> Result<bool, String> {
    let src = runtime_plugins
        .join("dsh-plugin")
        .join("node_modules")
        .join("dsh-plugin");
    if !src.exists() {
        return Ok(true);
    }
    let dest = home
        .join("profiles")
        .join("node_modules")
        .join("dsh-plugin");
    place_launcher_copy(&src, &dest, refresh_all)
}

/// Copy every local bundle shipped under the runtime's `plugins/` directory
/// into the profile-level module fallback and return the package names that
/// must be selected as bundle layers, plus whether every copy matches the
/// installation.
fn ensure_local_bundles(
    home: &Path,
    runtime_plugins: &Path,
    refresh_all: bool,
) -> Result<(Vec<String>, bool), String> {
    let mut names = Vec::new();
    let mut copies_current = true;
    for entry in fs::read_dir(runtime_plugins).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let directory_name = entry.file_name().to_string_lossy().into_owned();
        if directory_name == "dsh-plugin" || directory_name == "dsh-win-terminal-inspector" {
            continue;
        }
        let package_path = entry.path().join("package.json");
        let raw = match fs::read_to_string(&package_path) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let package: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|e| format!("parse {}: {e}", package_path.display()))?;
        let Some(package_name) = package.get("name").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let has_bundle = package
            .get("dsh")
            .and_then(|dsh| dsh.get("bundle"))
            .is_some();
        if !has_bundle {
            continue;
        }
        let destination = home
            .join("profiles")
            .join("node_modules")
            .join(package_name);
        copies_current &= place_launcher_copy(&entry.path(), &destination, refresh_all)?;
        names.push(package_name.to_string());
    }
    names.sort();
    names.dedup();
    Ok((names, copies_current))
}

/// Local bundles this shell seeded into profiles and no longer ships.
///
/// Removing a plugin from the runtime also has to remove the profile bundle
/// entry that names it, because the loader fails hard on a name it cannot
/// resolve. Only retired local bundles are listed here: plugin-center installs
/// write their own names into the same array.
const RETIRED_LOCAL_BUNDLES: &[&str] = &["dsh-tauri", "dsh-agent-progress"];

/// Whether one profile bundle entry names a retired local bundle.
fn is_retired_local_bundle(name: &str) -> bool {
    RETIRED_LOCAL_BUNDLES.contains(&name)
}

/// Select bundled local packages as profile bundle layers without disturbing
/// the profile's existing bundle order.
fn ensure_profile_bundles(profile: &Path, names: &[String]) -> Result<(), String> {
    let path = profile.join("package.json");
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
    let root = manifest
        .as_object_mut()
        .ok_or_else(|| format!("{} is not a JSON object", path.display()))?;
    let dsh = root
        .entry("dsh")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("{} dsh field is not an object", path.display()))?;
    let profile_value = dsh
        .entry("profile")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| format!("{} dsh.profile field is not an object", path.display()))?;
    let bundles = profile_value
        .entry("bundles")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
        .ok_or_else(|| format!("{} dsh.profile.bundles is not an array", path.display()))?;
    for name in names {
        if !bundles.iter().any(|entry| entry.as_str() == Some(name)) {
            bundles.push(serde_json::Value::String(name.clone()));
        }
    }
    // A bundle this shell seeded earlier and no longer ships has to leave the
    // list: the loader fails hard on a name it cannot resolve, and nothing else
    // prunes the array because plugin-center installs write their own names
    // here.
    bundles.retain(|entry| match entry.as_str() {
        Some(name) => !is_retired_local_bundle(name),
        None => true,
    });
    let rendered = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(&path, format!("{rendered}\n")).map_err(|e| e.to_string())
}

/// Insert a patch row unless a row with the same id exists, replacing it when
/// it does — the dsh-plugin row used to carry a path-based name and must
/// migrate to the bare package name.
fn upsert_patch_row(rows: &mut Vec<Yaml>, id: &str, row_yaml: &str) -> Result<(), String> {
    let row: Yaml = serde_yaml::from_str(row_yaml).map_err(|e| format!("build patch row: {e}"))?;
    let position = rows.iter().position(|row| {
        row.get("insert")
            .and_then(|ins| ins.as_sequence())
            .is_some_and(|seq| {
                seq.iter()
                    .any(|e| e.get("id").and_then(Yaml::as_str) == Some(id))
            })
    });
    match position {
        Some(index) => rows[index] = row,
        None => rows.push(row),
    }
    Ok(())
}

/// Drop every patch row whose insert list contains `id`.
fn remove_patch_row(rows: &mut Vec<Yaml>, id: &str) {
    rows.retain(|row| {
        !row.get("insert")
            .and_then(|ins| ins.as_sequence())
            .is_some_and(|seq| {
                seq.iter()
                    .any(|e| e.get("id").and_then(Yaml::as_str) == Some(id))
            })
    });
}

/// The profile's `dsh.profile.bundles` layer list from `package.json` — the
/// rows the plugin manager records there. The loader composes bundle layers
/// before the patch layer, so a bundle-listed plugin must not be re-inserted
/// by the patch below.
fn profile_bundles(profile: &Path) -> Vec<String> {
    fs::read_to_string(profile.join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value["dsh"]["profile"]["bundles"].as_array().cloned())
        .map(|rows| {
            rows.into_iter()
                .filter_map(|row| row.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn has_patch_row(rows: &[Yaml], id: &str) -> bool {
    rows.iter().any(|row| {
        row.get("insert")
            .and_then(|ins| ins.as_sequence())
            .is_some_and(|seq| {
                seq.iter()
                    .any(|e| e.get("id").and_then(Yaml::as_str) == Some(id))
            })
    })
}

fn runtime_plugins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource dir unavailable: {e}"))?;
    let bundled = resource_dir.join("runtime").join("plugins");
    if bundled.exists() {
        return Ok(bundled);
    }
    std::env::var("DSH_DESKTOP_PLUGINS_DIR")
        .map(PathBuf::from)
        .map_err(|_| "no bundled plugins dir; set DSH_DESKTOP_PLUGINS_DIR in dev".to_string())
}

/// Whether a bundle package is present in the deployed dsh closure beside the
/// bundled plugins directory.
fn runtime_bundle_present(runtime_plugins: &Path, package_name: &str) -> bool {
    runtime_plugins
        .parent()
        .map(|runtime| runtime.join("dsh").join("node_modules").join(package_name))
        .is_some_and(|path| path.exists())
}

fn copy_dir(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dest.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// The file a package declares as its entry (`main`, else Node's `index.js`),
/// resolved inside the package directory. A launcher-owned copy without it
/// cannot be imported, so it is never mistaken for a usable copy.
fn declared_entry(package_dir: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(package_dir.join("package.json")).ok()?;
    let manifest: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let main = manifest
        .get("main")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("index.js");
    Some(package_dir.join(main))
}

/// Whether `path` is a link rather than a directory of its own: a pnpm `link:`
/// projection or a junction a developer made. Writing through one would land in
/// another checkout, so such a path is never replaced.
fn is_link(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT: junctions are reparse points that
        // `is_symlink` does not report.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    false
}

/// Whether a launcher-owned copy must be rebuilt from the installation.
///
/// A build without its declared entry has nothing to place: it neither creates
/// a copy nor replaces one, so an unbuilt package cannot mask a usable copy or
/// seed a directory the loader cannot import. Everything else reconciles with
/// what the installation ships.
fn copy_is_stale(source: &Path, dest: &Path, refresh_all: bool) -> bool {
    if !declared_entry(source).is_some_and(|entry| entry.exists()) {
        return false;
    }
    // A link is checked before existence: `exists` follows the link, so a
    // dangling projection would otherwise look like a fresh destination and be
    // written through.
    if is_link(dest) {
        return false;
    }
    if !dest.exists() {
        return true;
    }
    if !declared_entry(dest).is_some_and(|entry| entry.exists()) {
        return true;
    }
    if refresh_all {
        return true;
    }
    fs::read(source.join("package.json")).ok() != fs::read(dest.join("package.json")).ok()
}

/// Replace a directory with the installation's build: copy into a sibling
/// directory first, move the old copy aside, then put the new one in place. One
/// rename follows the copy, and a failed swap restores the old copy, so no
/// failure leaves a partially deleted or missing bundle.
fn replace_dir(source: &Path, dest: &Path) -> Result<(), String> {
    let name = dest
        .file_name()
        .ok_or_else(|| format!("{} has no directory name", dest.display()))?;
    let sibling = |suffix: &str| dest.with_file_name(format!("{}.{suffix}", name.to_string_lossy()));
    let staging = sibling("incoming");
    let displaced = sibling("previous");
    fs::remove_dir_all(&staging).ok();
    copy_dir(source, &staging)?;
    fs::remove_dir_all(&displaced).ok();
    fs::rename(dest, &displaced).map_err(|e| e.to_string())?;
    if let Err(error) = fs::rename(&staging, dest) {
        fs::rename(&displaced, dest).ok();
        return Err(error.to_string());
    }
    fs::remove_dir_all(&displaced).ok();
    Ok(())
}

/// Seed or refresh one launcher-owned copy from the installation.
///
/// A copy that is not there yet must be created, so its failure stops startup:
/// the profile selects the bundle and cannot run without it. Replacing an
/// existing copy is best-effort, because another process may hold a file; the
/// old copy then stays loadable and the returned `false` keeps the installation
/// unrecorded, so the next launch retries.
fn place_launcher_copy(source: &Path, dest: &Path, refresh_all: bool) -> Result<bool, String> {
    if !copy_is_stale(source, dest, refresh_all) {
        return Ok(true);
    }
    if !dest.exists() {
        return copy_dir(source, dest).map(|()| true);
    }
    Ok(replace_dir(source, dest).is_ok())
}

/// The version of the installation this launch runs from. Every packaged
/// runtime that ships new plugin builds carries a different one.
fn installation_version(runtime_plugins: &Path) -> Option<String> {
    let manifest = runtime_plugins.parent()?.join("prism").join("package.json");
    let raw = fs::read_to_string(manifest).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("version")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
}

/// Where the installation of the last complete reconciliation is recorded.
fn installation_record(home: &Path) -> PathBuf {
    home.join("profiles").join(".seeded-runtime")
}

/// Whether this launch runs an installation the copies have not seen: every
/// launcher-owned copy is then refreshed, including one whose manifest and
/// build happen to match an older release.
fn installation_changed(home: &Path, runtime_plugins: &Path) -> bool {
    let Some(version) = installation_version(runtime_plugins) else {
        return false;
    };
    fs::read_to_string(installation_record(home))
        .ok()
        .as_deref()
        .map(str::trim)
        != Some(version.as_str())
}

/// Record the installation whose copies all match, so the next launch of the
/// same installation only compares manifests and entries.
fn record_installation(home: &Path, runtime_plugins: &Path) {
    let Some(version) = installation_version(runtime_plugins) else {
        return;
    };
    let record = installation_record(home);
    if let Some(parent) = record.parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::write(record, format!("{version}\n")).ok();
}

#[cfg(test)]
mod seed_tests {
    use super::{
        copy_is_stale, ensure_local_bundles, installation_changed, place_launcher_copy,
        record_installation,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    /// A scratch directory for one case, emptied so a rerun starts clean. It
    /// lives under the crate's build directory: the harness denies the system
    /// temporary directory to the test binary on some hosts.
    fn scratch(name: &str) -> PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("seed-tests")
            .join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir)
            .unwrap_or_else(|error| panic!("scratch dir {}: {error}", dir.display()));
        dir
    }

    /// Write a plugin package whose manifest names `peers` as its dsh peers,
    /// with its declared entry present only when `built`.
    fn plugin(dir: &Path, peers: &str, built: bool) {
        fs::create_dir_all(dir).expect("plugin dir");
        fs::write(
            dir.join("package.json"),
            format!(
                "{{\"name\":\"@prism/example\",\"version\":\"0.1.0\",\"main\":\"lib/index.js\",\"peerDependencies\":{peers}}}"
            ),
        )
        .expect("manifest");
        if built {
            fs::create_dir_all(dir.join("lib")).expect("lib dir");
            fs::write(dir.join("lib").join("index.js"), "export {}\n").expect("entry");
        }
    }

    /// The manifest bytes of a package.
    fn manifest(dir: &Path) -> String {
        fs::read_to_string(dir.join("package.json")).expect("manifest readable")
    }

    #[test]
    fn a_missing_copy_is_seeded_from_the_installation() {
        let root = scratch("seed");
        let source = root.join("plugins").join("example");
        plugin(&source, r#"{"@deepseek-ai/dsh-llm":"0.2.1-rc.4"}"#, true);
        let dest = root.join("profiles").join("node_modules").join("@prism").join("example");

        assert!(place_launcher_copy(&source, &dest, false).expect("seeded"));
        assert!(dest.join("lib").join("index.js").exists());
    }

    #[test]
    fn a_stale_manifest_replaces_the_copy_wholesale() {
        let root = scratch("stale");
        let source = root.join("plugins").join("example");
        plugin(&source, r#"{"@deepseek-ai/dsh-llm":"0.2.1-rc.4"}"#, true);
        let dest = root.join("profiles").join("node_modules").join("@prism").join("example");
        plugin(&dest, r#"{"@deepseek-ai/dsh-llm":"0.1.7-rc.1"}"#, true);
        fs::write(dest.join("lib").join("removed.js"), "export {}\n").expect("dropped file");

        assert!(copy_is_stale(&source, &dest, false));
        assert!(place_launcher_copy(&source, &dest, false).expect("refreshed"));
        assert_eq!(manifest(&dest), manifest(&source));
        assert!(!dest.join("lib").join("removed.js").exists());
    }

    #[test]
    fn an_unbuilt_installation_keeps_the_working_copy() {
        let root = scratch("unbuilt");
        let source = root.join("plugins").join("example");
        plugin(&source, r#"{"@deepseek-ai/dsh-llm":"0.2.1-rc.4"}"#, false);
        let dest = root.join("profiles").join("node_modules").join("@prism").join("example");
        plugin(&dest, r#"{"@deepseek-ai/dsh-llm":"0.1.7-rc.1"}"#, true);

        assert!(!copy_is_stale(&source, &dest, false));
        assert!(place_launcher_copy(&source, &dest, false).expect("kept"));
        assert!(manifest(&dest).contains("0.1.7-rc.1"));
        assert!(dest.join("lib").join("index.js").exists());
    }

    #[test]
    fn an_unbuilt_installation_seeds_nothing() {
        let root = scratch("unbuilt-fresh");
        let source = root.join("plugins").join("example");
        plugin(&source, r#"{"@deepseek-ai/dsh-llm":"0.2.1-rc.4"}"#, false);
        let dest = root.join("profiles").join("node_modules").join("@prism").join("example");

        assert!(place_launcher_copy(&source, &dest, true).expect("skipped"));
        assert!(!dest.exists());
    }

    #[test]
    fn a_bundle_this_installation_cannot_build_is_still_selected() {
        let root = scratch("selected");
        let runtime_plugins = root.join("runtime").join("plugins");
        let source = runtime_plugins.join("example");
        fs::create_dir_all(&source).expect("plugin dir");
        fs::write(
            source.join("package.json"),
            "{\"name\":\"@prism/example\",\"version\":\"0.1.0\",\"main\":\"lib/index.js\",\
             \"dsh\":{\"bundle\":{\"patch\":\"./cordis.patch.yml\"}}}",
        )
        .expect("manifest");

        let (names, current) = ensure_local_bundles(&root, &runtime_plugins, false).expect("selected");
        assert_eq!(names, vec!["@prism/example".to_string()]);
        assert!(current);
        assert!(!root
            .join("profiles")
            .join("node_modules")
            .join("@prism")
            .join("example")
            .exists());
    }

    #[test]
    fn a_dangling_link_is_never_written_through() {
        let root = scratch("dangling");
        let source = root.join("plugins").join("example");
        plugin(&source, r#"{"@deepseek-ai/dsh-llm":"0.2.1-rc.4"}"#, true);
        let target = root.join("checkout").join("example");
        plugin(&target, r#"{"@deepseek-ai/dsh-llm":"0.1.7-rc.1"}"#, true);
        let dest = root.join("profiles").join("node_modules").join("@prism").join("example");
        fs::create_dir_all(dest.parent().expect("parent")).expect("parent dir");
        make_dir_link(&target, &dest).expect("junction");
        fs::remove_dir_all(&target).expect("target removed");

        assert!(!copy_is_stale(&source, &dest, true));
        assert!(place_launcher_copy(&source, &dest, true).expect("kept"));
        assert!(!dest.join("lib").join("index.js").exists());
    }

    #[test]
    fn a_copy_without_its_entry_is_replaced() {
        let root = scratch("entryless");
        let source = root.join("plugins").join("example");
        plugin(&source, r#"{"@deepseek-ai/dsh-llm":"0.2.1-rc.4"}"#, true);
        let dest = root.join("profiles").join("node_modules").join("@prism").join("example");
        plugin(&dest, r#"{"@deepseek-ai/dsh-llm":"0.1.7-rc.1"}"#, false);

        assert!(copy_is_stale(&source, &dest, false));
        assert!(place_launcher_copy(&source, &dest, false).expect("repaired"));
        assert!(dest.join("lib").join("index.js").exists());
    }

    #[test]
    fn a_link_is_never_replaced() {
        let root = scratch("linked");
        let source = root.join("plugins").join("example");
        plugin(&source, r#"{"@deepseek-ai/dsh-llm":"0.2.1-rc.4"}"#, true);
        let target = root.join("checkout").join("example");
        plugin(&target, r#"{"@deepseek-ai/dsh-llm":"0.1.7-rc.1"}"#, true);
        let dest = root.join("profiles").join("node_modules").join("@prism").join("example");
        fs::create_dir_all(dest.parent().expect("parent")).expect("parent dir");
        // A junction is the link pnpm projects into the profile, and NTFS
        // creates one without a privilege.
        make_dir_link(&target, &dest).expect("junction");

        assert!(!copy_is_stale(&source, &dest, true));
        assert!(place_launcher_copy(&source, &dest, true).expect("kept"));
        assert!(manifest(&dest).contains("0.1.7-rc.1"));
    }

    #[test]
    fn a_new_installation_refreshes_every_copy_once() {
        let root = scratch("upgrade");
        let runtime = root.join("runtime");
        let runtime_plugins = runtime.join("plugins");
        fs::create_dir_all(&runtime.join("prism")).expect("runtime");
        fs::write(
            runtime.join("prism").join("package.json"),
            "{\"name\":\"prism-agent\",\"version\":\"0.2.1-rc.4\"}\n",
        )
        .expect("runtime manifest");
        plugin(&runtime_plugins.join("example"), r#"{"@deepseek-ai/dsh-llm":"0.2.1-rc.4"}"#, true);

        assert!(installation_changed(&root, &runtime_plugins));
        record_installation(&root, &runtime_plugins);
        assert!(!installation_changed(&root, &runtime_plugins));

        fs::write(
            runtime.join("prism").join("package.json"),
            "{\"name\":\"prism-agent\",\"version\":\"0.2.1-rc.5\"}\n",
        )
        .expect("runtime manifest");
        assert!(installation_changed(&root, &runtime_plugins));
        let identical = root.join("profiles").join("node_modules").join("@prism").join("example");
        plugin(&identical, r#"{"@deepseek-ai/dsh-llm":"0.2.1-rc.4"}"#, true);
        assert!(copy_is_stale(&runtime_plugins.join("example"), &identical, true));
        record_installation(&root, &runtime_plugins);
        assert!(!installation_changed(&root, &runtime_plugins));
    }

    /// A directory link for the guard case. A junction needs no privilege, and
    /// pnpm's link projections are the same kind of reparse point.
    fn make_dir_link(target: &Path, link: &Path) -> std::io::Result<()> {
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args([
                    "/c",
                    "mklink",
                    "/J",
                    &link.display().to_string(),
                    &target.display().to_string(),
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()?;
            if status.success() {
                Ok(())
            } else {
                Err(std::io::Error::other("mklink /J failed"))
            }
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link)
        }
    }
}
