---
type: fixed
breaking: false
audience: user
---
Seed the web profile before the desktop's first boot

A fresh Prism home has no `profiles/web/package.json` — the CLI writes it on
its first `dsh web` boot, and the shell seeded its bundled bundle layers before
that boot. The merge failed with ENOENT, `spawn_child` returned before spawning
anything, and the window stayed on "starting local service" with no hub to
connect to. Seeding now asks the installed CLI's own `initProfile` for the web
template (manifest, patch layer, pnpm settings) when the manifest is missing,
then merges the bundled layers into it as before.
