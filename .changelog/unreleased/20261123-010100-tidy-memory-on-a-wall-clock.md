---
type: added
breaking: false
audience: user
commits:
---
The memory hygiene pass now also runs on a wall clock: every `scheduledMaintainMinutes` (default 360) and once shortly after load, the plugin applies expiry archiving, near-duplicate merging, and capacity eviction with no turn and no operator command, so a quiet workspace stays tidy. `scheduledMaintain: false` keeps tidying on the turn path and operator command alone.
