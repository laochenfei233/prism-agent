---
type: changed
breaking: false
audience: user
commits: 7ac0410a41
draft: true
---
The desktop installer is rebuilt on Tauri 2.12.6 with a re-synced NSIS template: upgrades keep offering the in-place upgrade first, downgrades are now also blocked in passive and update installs, and a successful upgrade uninstall no longer leaves the old uninstaller behind.
