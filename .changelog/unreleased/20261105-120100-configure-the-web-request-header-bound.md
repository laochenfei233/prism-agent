---
type: added
breaking: false
audience: user
commits: c4ed844a21
draft: true
---
The web listener's request-header byte bound is configurable as `maxRequestHeaderBytes` in the `dsh-host-webserver` config, defaulting to 64 KiB with a 1 KiB minimum, instead of a fixed constant.
