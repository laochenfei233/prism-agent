---
type: fixed
breaking: false
audience: user
commits: efc184f
---
A first sandboxed command in a large Windows workspace no longer freezes every conversation: the workspace's ACL preparation runs in a background helper, the interface stays responsive, and a preparation that takes longer than two minutes reports a retryable error instead of hanging.
