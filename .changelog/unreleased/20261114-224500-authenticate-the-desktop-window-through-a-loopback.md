---
type: fixed
breaking: false
audience: user
draft: true
---
Authenticate the desktop window through a loopback proxy

The desktop window used to authenticate with the webview's own cookie jar.
Inside the frame that jar is a third-party store, and because cookies ignore
ports, a session minted for an earlier loopback port survived every port change
and left the window on the "authentication required" page with no way to
recover short of clearing the store by hand. The window now loads a loopback
proxy that attaches the signed session to every request and WebSocket
handshake and rewrites Host, Origin, and Referer; the webview's cookie jar is
no longer involved. The proxy keeps its port for the app's lifetime, so a
restarted server only replaces the session behind an origin that never changes.
