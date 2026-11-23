# Auto-archive

English | [中文](auto-archive.zh.md)

## Summary

Auto-archive is the scheduled hygiene that moves unused conversations and unused projects out of the sidebar without deleting anything. A bundled plugin, `prism-session-autoarchive`, runs one sweep per interval: every top-level conversation whose last write is older than the conversation window joins the archive set, and every project that holds no visible conversation and has been quiet past the project window joins the project archive set. Both sets are the same durable, reversible state the sidebar's own Archive actions write, so everything can be restored.

The feature is **off by default**. Turn it on with the plugin's `enabled` switch in Settings (the switch is under the plugin's generated settings page); a deployment can also state `enabled: true` in its `cordis.patch.yml` row. When enabled with the defaults, a conversation archives after 30 idle days and a project after 14 quiet days.

## Table of Contents

- [What the sweep touches](#what-the-sweep-touches)
- [Projects and the default Workspace](#projects-and-the-default-workspace)
- [Restoring conversations and projects](#restoring)
- [Configuration reference](#configuration-reference)

<a id="what-the-sweep-touches"></a>
## What the sweep touches

Only top-level conversations qualify: pinned sessions, subagent children, and forks are left alone, and a session whose turn is still running is refused by the archive set and skipped — automatic hygiene never cancels running work. The activity clock is the session's last write, so an imported conversation ages by its own log.

A project (Workspace) is evaluated in the same pass. It hides only when it accounts no visible top-level conversation and its newest write — or, for a never-used project, its registration — is older than `projectIdleDays`. A hidden project that regains a visible conversation, for example because a scheduled reminder delivered into it, is restored by the next sweep automatically.

With the conversation window at 7 days, the shipped project window of 14 days reads as 7+7: the conversation archives on day 7, and the project, now holding no visible conversation, archives 7 days later.

<a id="projects-and-the-default-workspace"></a>
## Projects and the default Workspace

The default Workspace — the first folder the application registered at first use — is exempt: the sweep never hides it unless the deployment sets `includeDefaultWorkspace: true`. Every other project idles into the archive set by the same rule.

<a id="restoring"></a>
## Restoring conversations and projects

- **Conversations:** open Settings → Archived conversations and restore one, or use the sidebar's own archive controls. A restored conversation returns to its project.
- **Projects:** open Settings → Archived projects and restore the project row; the project returns with its title, order, and conversations. Re-adding the same folder through the normal add-project flow also restores the original registration — the folder path is the project's identity, so no duplicate project is created.

<a id="configuration-reference"></a>
## Configuration reference

| Field | Default | Range | Effect |
|---|---|---|---|
| `enabled` | `false` | boolean | Master switch; `false` keeps the plugin mounted with no sweep at all |
| `idleDays` | `30` | 1–3650 | Days without dialogue before a conversation joins the archive set |
| `projectIdleDays` | `14` | 1–3650 | Days without any conversation write before an idle project joins the project archive set |
| `includeDefaultWorkspace` | `false` | boolean | Whether the default Workspace may be archived when it idles |
| `sweepIntervalMinutes` | `1440` | 5–10080 | Minutes between sweeps |

Every field is live-editable from the Settings page generated for the plugin; an edit takes effect on the next sweep without a restart.
