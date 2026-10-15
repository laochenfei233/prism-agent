//! Desktop profile seeding: preinstall the bundled default plugins into the
//! web profile through the official patch and bundle layers before the dsh
//! process spawns.

use std::fs;
use std::path::{Path, PathBuf};

use serde_yaml::Value as Yaml;
use tauri::{AppHandle, Manager};

// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2), area A9.
/// Prism's harness home: `$PRISM_HOME` when set, otherwise the fork's default
/// `~/.prism` — the same root this fork's `prism` CLI defaults to — never a
/// deepseek-harness build's `~/.dsh`.
pub fn dsh_home() -> PathBuf {
    std::env::var("PRISM_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            let base = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_default();
            PathBuf::from(base).join(".prism")
        })
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

    // dsh-plugin is an npm-distributed bundle (dsh.bundle.patch + dsh.client).
    // Copy it into the launcher-maintained flat module fallback so the bare
    // name resolves from the profile ("bundles come from the installation"),
    // and insert it under that name: the client module registry resolves the
    // entry name to serve the plugin-center tab. A path-based row loads the
    // server half but leaves the entry unresolvable by the registry.
    ensure_market_bundle(&home, &runtime_plugins)?;
    let mut bundle_layers = ensure_local_bundles(&home, &runtime_plugins)?;
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
        if !dest.exists() {
            fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
            copy_dir(&win_src, &dest)?;
        }
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
    if !bundle_layers.is_empty() {
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
fn ensure_market_bundle(home: &Path, runtime_plugins: &Path) -> Result<(), String> {
    let src = runtime_plugins
        .join("dsh-plugin")
        .join("node_modules")
        .join("dsh-plugin");
    if !src.exists() {
        return Ok(());
    }
    let dest = home
        .join("profiles")
        .join("node_modules")
        .join("dsh-plugin");
    if dest.exists() {
        return Ok(());
    }
    fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
    copy_dir(&src, &dest)
}

/// Copy every local bundle shipped under the runtime's `plugins/` directory
/// into the profile-level module fallback and return the package names that
/// must be selected as bundle layers.
fn ensure_local_bundles(home: &Path, runtime_plugins: &Path) -> Result<Vec<String>, String> {
    let mut names = Vec::new();
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
        if !destination.exists() {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            copy_dir(&entry.path(), &destination)?;
        }
        names.push(package_name.to_string());
    }
    names.sort();
    names.dedup();
    Ok(names)
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
