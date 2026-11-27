---
type: fixed
breaking: false
audience: user
commits: 
---
The Intel (x64) macOS build no longer fails at startup with a missing native addon: the release bundle compiles the macOS flock binding for the target architecture when the workspace only built the host's.
