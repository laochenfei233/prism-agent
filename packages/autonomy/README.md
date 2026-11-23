---
description: "The autonomy group map: the autonomous-guarded permission preset and the approval auto-answerer behind it, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/autonomy

English | [中文](README.zh.md)

## Summary

The autonomy group hosts the autonomous tier of the permission presets. Its package engages on the `autonomous-guarded` preset (shipped in the base bundle's permission table): approval requests in such sessions are answered automatically through the approval seam, except the configured require-human matchers — shipped default: sandbox escalations. Deny rails never produce an ask and stay exactly as they are. It is host-side only: the model sees one switch notice, and the client sees no approval cards for auto-answered requests.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`prism-autonomy`](prism-autonomy/README.md) | The approval answerer, the preset mapping, and the live switch notice | service `prism-autonomy` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Autonomous approval presets feature document](../../docs/compose/spec/prism-autonomy.md) — the design, the limits, and the acceptance checks.
- [Permission presets](../interaction/permission-presets/README.md) — the preset table the engaging preset ships in.
