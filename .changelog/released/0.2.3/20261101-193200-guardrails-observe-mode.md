---
type: added
breaking: false
audience: internal
commits: b5f6e1cc62
---
The guardrails bundle gains an observe mode: every rail still decides, but a `deny` or `ask` is recorded instead of applied, so a deployment can read a rail's reach before arming it. `/guardrails` now leads with the mode and the configuration hash a decision was made under, and lists the calls the observing run would have stopped.
