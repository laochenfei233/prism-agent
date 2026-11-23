# prism-session-autoarchive

English | [中文](README.zh.md)

Scheduled hygiene for the sidebar: once per interval the plugin adds every top-level Session whose last write is older than `idleDays` (30 by default) to the Workspace archive set, and every project that holds no visible conversation and has been quiet past `projectIdleDays` (14 by default) to the project archive set. Archiving here is the same durable, reversible state the sidebar's own Archive actions write — nothing is deleted, and everything can be restored.

**The feature is off by default.** The plugin mounts idle until you turn the `enabled` switch on in the Settings page generated from this plugin's schema, or state `enabled: true` in the bundle's `cordis.patch.yml` row. The user guide documents the behavior end to end (`docs/user/guide/auto-archive.md`, projected into the website's Automation section).

## Summary

- **Reversible and idle-only.** A Session joins the archive set only when its stored log has not changed inside the window; opening it again is one unarchive away. A project joins only when it accounts no visible conversation and its newest write (or registration) is past the project window.
- **Only top-level conversations.** Subagent children and forks are left alone: the archive set blocks resumed steps for the Sessions it names, and a delegating parent may still continue its child. Pinned Sessions are left alone too, because archiving drops the pin.
- **Running work is never cancelled.** The archive set refuses a Session with an active turn; the sweep records the refusal and moves on.
- **The default Workspace is exempt.** The first-use Workspace is never archived unless the deployment sets `includeDefaultWorkspace: true`.
- **Re-adding a folder restores its project.** The canonical folder path is the project's identity: adding a hidden project's folder again unhides the original registration instead of creating a second one.
- **Configured in Settings.** Every field is a live-editable Config field, so the Settings page generated for this plugin changes the windows without editing `cordis.yml`. The same plugin registers the Settings section that lists hidden projects with per-row restore.

## Install

The plugin is a profile bundle. Add it to the profile's bundle list and it contributes one `cordis.patch.yml` row:

```yaml
- id: prism-session-autoarchive
  name: 'prism-session-autoarchive'
  config:
    enabled: false
    idleDays: 30
    projectIdleDays: 14
    includeDefaultWorkspace: false
    sweepIntervalMinutes: 1440
```

A checkout that has not installed the package can point the row at the built entry instead: `name: 'file:///absolute/path/to/plugins/prism-session-autoarchive/lib/index.js'`.

## Configuration

| Field | Default | Range | Effect |
|---|---|---|---|
| `enabled` | `false` | boolean | Master switch; `false` keeps the plugin mounted with no sweep at all |
| `idleDays` | `30` | 1–3650 | Days without dialogue before a conversation joins the archive set |
| `projectIdleDays` | `14` | 1–3650 | Days without any conversation write before an idle project joins the project archive set |
| `includeDefaultWorkspace` | `false` | boolean | Whether the default Workspace may be archived when it idles |
| `sweepIntervalMinutes` | `1440` | 5–10080 | Minutes between sweeps |

All five are `volatile`: the Settings page writes the value into the Config reference the Loader already handed the plugin, and the next sweep reads it. Any volatile edit re-arms the interval, so the periodic pass after an edit lands a full `sweepIntervalMinutes` later; no restart and no plugin remount is involved.

## How one sweep decides

1. Read every stored Session plus the ones this process created and has not materialized yet.
2. Skip Sessions already archived, pinned, marked `origin: 'subagent'`, or carrying a `parentSession`.
3. Age each remaining Session by `max(createdAt, updatedAt)` — the header's creation time, raised by the stored artifact's last-write time when the backend reports it.
4. Archive every Session older than the cutoff, one at a time, skipping the ones the archive set refuses because their work is running.
5. Evaluate every Workspace over the same listing: a Workspace with no visible top-level Session whose newest accounted write (archived and subagent writes included) or registration is past `projectIdleDays` joins the project archive set; a hidden Workspace that regained a visible Session is restored on the spot. The default Workspace is skipped unless `includeDefaultWorkspace` is on.

The first sweep runs 60 seconds after the plugin loads and the rest follow `sweepIntervalMinutes`. One sweep runs at a time: a tick that arrives during a pass returns immediately. A pass that fails logs a warning and leaves the next tick armed.

## Known Limitations and Deferred Work

- **Blank conversations are not classified.** A Session that never received a user message has no special treatment: it is archived once it is old enough, like any other idle Session.
- **The activity clock is the log's last write.** A backend that rewrites a log for maintenance (a format migration, a checkpoint) makes that Session look active, so it waits another window. The archive is late rather than wrong.
- **No manual "archive now".** The sweep is the only trigger; a user who wants a conversation or project archived immediately uses the sidebar or Settings actions.
- **The suite has no Loader composition case.** The specs resolve the plugin's own schema (so a volatile reference cannot pass as a plain value) and drive the sweep through recorded dependencies, but nothing boots the Loader, the Workspace registry, and the timer together: the entry's composition is checked with `prism --profile web --dump-config`, and its first pass runs in the app after the next launch.
