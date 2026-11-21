---
type: fixed
breaking: false
audience: user
draft: true
---
Move the desktop shell's hub off the shared 3081 port

Sibling dsh-fork desktop shells share the upstream 3081 default, so whichever
product boots second loses the port and lands on a fallback port every launch.
The port is part of the browser session's cookie authority, and each move
invalidated every existing session cookie into the
"authentication required; reopen the URL printed by dsh web" page. The shell
now defaults to the private port 38081; the scan fallback and the README port
contract move with it.
