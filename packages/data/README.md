---
description: "The data group map: hosting the 数据 settings page and moving the harness home to another directory, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/data

English | [中文](README.zh.md)

## Summary

The data group hosts one settings page, 数据. Its package shows the current harness home, copies that directory to a place the operator chooses, and records the choice in a launch pointer beside the default home; the CLI and the desktop shell read that pointer on the next launch. The same package provides the three-tab shell of the page: 数据存储路径 lives here, while 备份 and 导入导出 register into it and stay with their own packages. It is host-side and browser-facing: no prompt, tool, or session event reaches the model.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`prism-data`](prism-data/README.md) | The 数据 settings page, its storage tab, and the relocation route | registers `/api/prism.data` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Data settings feature document](../../docs/compose/spec/data-settings.md) — why the feature exists, how the tabs are composed, the relocation rules, and the launch pointer.
- [Prism backup](../backup/README.md) — the owner of the 备份 tab.
- [Prism transfer](../transfer/README.md) — the archive half of the 导入导出 tab.
- [Cross-agent import](../session-query/session-import/README.md) — the conversation half of the 导入导出 tab.
