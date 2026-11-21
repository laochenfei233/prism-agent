---
description: "The transfer group map: moving projects and settings between installs as archive files, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/transfer

English | [中文](README.zh.md)

## Summary

The transfer group moves user data between machines as files. Its one package exports selected projects (the workspace folder plus every attached session) and the settings page's editable values into self-describing archive files, and imports such archives back: extracting the folder, restoring the sessions with their titles, media, and files, registering the workspace, and reapplying the settings values. Import never overwrites existing data. It is host-side and browser-facing: no prompt, tool, or session event reaches the model.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`prism-transfer`](prism-transfer/README.md) | Exports and imports project and settings archives through the settings page | registers `/api/prism.transfer/*` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Prism transfer feature document](../../docs/compose/spec/prism-transfer.md) — why the feature exists, the three archive formats, and the safety guards.
- [Session log export](../session-query/session-log-export/README.md) — the session-entry producer the export reuses.
- [Prism backup](../backup/README.md) — the whole-machine remote backup this group deliberately does not replace.
