---
type: fixed
breaking: false
audience: user
commits: TBD
---
The session-header cost pill now prices its billing tier at the latest logged settlement instant instead of the render-time wall clock, so the same session log always renders the same estimate. The token-usage projection carries that instant as `lastSettledAt`.
