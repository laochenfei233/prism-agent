---
type: fixed
breaking: false
audience: user
draft: true
---
Show a visible crash face when the client render fails

The renderer mounted the assembled application without a top-level error
boundary. A React render error after the boot page handed off unmounted the
whole root: the kernel's failure page was already detached, the desktop shell
hid its splash, and the window stayed blank until a restart. The renderer now
mounts the application under `RenderFailureBoundary`, which logs the error
through the host logger and replaces the tree with a self-contained crash face
showing the error message and a reload action. The root slot's entry boundary
and its dry registration state render the same face instead of leaving the
empty crash marker.
