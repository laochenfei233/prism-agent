---
type: added
breaking: false
audience: internal
draft: true
---
Watch upstream dsh releases through a scheduled workflow

Upstream releases surfaced only when someone noticed them by hand, and two of
them (0.2.2-rc.2, 0.2.2-rc.3) landed undetected after the rc.1 resync. A daily
GitHub Actions workflow now diffs every upstream release tag against a
committed seen-list (`.github/dsh-upstream-seen.json`), posts the new tags to
a Feishu group bot webhook, and records them as seen only after a successful
send.
