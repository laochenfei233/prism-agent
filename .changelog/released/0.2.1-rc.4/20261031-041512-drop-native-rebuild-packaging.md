---
type: changed
breaking: false
audience: internal
commits: 2c9222d
---
Desktop packaging no longer runs the pnpm-11-incompatible native rebuild step; the shipped closure relies on the prebuilt node-pty bindings.
