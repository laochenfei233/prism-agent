---
description: "The 数据 settings page: where the harness home is, the copy that moves it, and the tabs that host backup, import/export, and cross-agent import."
kind: "package-reference"
---

# @prism/prism-data

English | [中文](README.zh.md)

## Summary

`prism-data` owns one Settings page, 数据, and the three tabs under it: 数据存储路径, 备份, and 导入导出. The first tab is this package's work — it shows the absolute harness home, copies that directory to a place the operator chooses, and records the choice in a launch pointer beside the default home. The other two are shells: the backup page (`@prism/prism-backup`), the archive transfer page (`@prism/prism-transfer`), and the cross-agent import page (`@prism/prism-session-import`) register into `settings.data.page` and keep their own packages, dictionaries, and Host routes. Nothing here is model-visible: no prompt, tool, or session event is registered.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package in a Web or desktop bundle that already provides Connection, the locale service, and a directory-picker backend. The plugin registers one authenticated Host route and one browser settings section.

### Composition

```yaml
- id: prism-data
  name: '@prism/prism-data'
```

The browser half loads through the same row because the manifest declares `dsh.client`.

### Route contract

| Route | Body | Result |
|---|---|---|
| `POST /api/prism.data` | `{ "action": "state" }` | `{ root, pointerPath, storedRoot?, pendingRoot? }` for the running home and the recorded choice. |
| `POST /api/prism.data` | `{ "action": "relocate", "target": "/absolute/dir" }` | `{ target, previousRoot, files, bytes, skippedLinks }` after the copy, or a typed refusal. |
| `POST /api/prism.data` | `{ "action": "reset" }` | The state after the pointer is removed. |

Refusals carry `prism-data/bad-request` (400), `prism-data/target-invalid` (400), `prism-data/busy` (409), `prism-data/target-not-empty` (409), `prism-data/copy-failed` (500), and `prism-data/pointer-failed` (500).

### What to expect

A relocation copies the home — regular files and directory links — into an absent or empty destination, skipping the top-level `cache` directory because it holds rebuildable spools and model caches. It then writes `~/.prism-data-home`, the launch pointer that the CLI and the desktop shell read before falling back to `~/.prism`. The home being copied is never modified or deleted. The next launch runs from the new directory; nothing moves while a process is running, because every service resolves the home at construction.

### Failures

A destination that already holds anything, sits inside the home, contains the home, or is relative is refused before any byte is copied. A copy that fails removes its partial destination so a retry is not blocked by a tree nobody can explain, and a pointer that cannot be written leaves the finished copy in place and says so. A second relocation while one runs answers `busy`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design split

The Host half ([`src/index.ts`](src/index.ts)) owns the route, the busy guard, and the pointer write; [`src/relocate.ts`](src/relocate.ts) owns destination validation and the copy walk. The browser half ([`src/client/index.ts`](src/client/index.ts)) registers the section and the `settings.data.page` slot; [`src/client/DataSection.tsx`](src/client/DataSection.tsx) renders the three fixed tabs, and [`src/client/StoragePage.tsx`](src/client/StoragePage.tsx) renders the location card and the change dialog.

### Tabs are fixed, pages are not

The three tab ids are literals of this package, so a contributing page cannot rename or reorder a tab: `backup` renders the backup page, `transfer` renders the archive transfer page and then the cross-agent import page under it, and `storage` renders this package's own tab. A visited tab stays mounted while hidden, which keeps staged backup forms and import previews across tab switches.

### Launch pointer

`@deepseek-ai/dsh-home-paths` owns `dataHomePointerPath`, `readDataHomePointer`, `writeDataHomePointer`, and `clearDataHomePointer`. The CLI applies the pointer when `$DSH_HOME` is blank; the desktop shell prefers `$PRISM_HOME`, then the pointer, then `~/.prism`, and hands the result to its child as `DSH_HOME`. The pointer lives beside the default home, never inside the home it selects.

### Test coverage

`pnpm vitest run packages/data/prism-data` covers destination validation, the copy walk (including skipped links and the `cache` skip), the pointer round trip, the route's request validation and busy guard, and the section's tab behavior.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Data package map](../README.md) — the group this package belongs to.
- [Prism backup](../../backup/prism-backup/README.md) — the 备份 tab's owner.
- [Prism transfer](../../transfer/prism-transfer/README.md) — the archive half of the 导入导出 tab.
- [Cross-agent import](../../session-query/session-import/README.md) — the conversation half of the 导入导出 tab.
- [Harness home paths](../../util/home-paths/README.md) — the resolver and pointer helpers the launch reads.

-----

<a id="model-experience"></a>
## Model Experience

None, as the feature registers no prompt, tool, or session event and no file path or byte reaches a model request.

#### KV Cache effect

None; moving the home changes where the next process reads its session logs, not what any request contains.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A restart applies the change** — the running process keeps its home until it exits, because services capture the home at construction.
- **The old directory is kept** — a relocation never deletes or merges the source; the operator removes it after checking the copy.
- **Links may be skipped** — a link whose target is gone, or that the platform refuses to recreate in the destination, is reported and not copied; on Windows a link to a file is always reported this way. The desktop recreates its own `node_modules` link on the next launch; a profile's pnpm-linked plugins may need reinstalling.
- **A failed copy removes its destination** — the empty directory the operator picked goes with the partial copy, so a retry starts clean instead of meeting a tree nobody can explain.
- **No progress or cancellation** — the copy is one sequential walk; the page shows a busy state until it settles, and interrupting the app leaves a partial destination that the next attempt refuses because it is no longer empty.
- **An environment variable still wins** — a launch that names the home through `$DSH_HOME` (CLI) or `$PRISM_HOME` (desktop) ignores the pointer, so the copy alone does not move that launch.

### Dev Note

<details>
<summary>Implementation notes for maintainers — click to expand</summary>

The pointer file is one line naming the real home directory; every home-path consumer resolves through it, and the copy walks the source tree in one sequential pass, recreating links only when the platform allows, so a partial copy is always a plain directory the next attempt can replace.

</details>
