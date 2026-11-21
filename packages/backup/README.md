---
description: "The backup group map: archiving the Harness home and registered project folders to a remote server, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/backup

English | [中文](README.zh.md)

## Summary

The backup group copies user data off the machine that holds it. Its one package archives the configuration layers, the long-term memory store, the workspace registry, and every registered project folder into one zip and uploads it to a WebDAV, SMB, or S3 destination, then prunes older archives. It is host-side and browser-facing: no prompt, tool, or session event reaches the model, and session logs stay out of the archive because they have their own export.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`prism-backup`](prism-backup/README.md) | Archives configuration, memory, and project folders, uploads the zip, and keeps run history | registers `POST /api/prism.backup` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Prism backup feature document](../../docs/compose/spec/prism-backup.md) — why the feature exists, its archive layout, and the transport choices.
- [Configuration catalog](../../docs/config-catalog.md#prismprism-backup) — every accepted field with its JSDoc.
