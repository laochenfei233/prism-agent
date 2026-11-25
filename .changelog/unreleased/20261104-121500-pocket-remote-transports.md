---
type: added
breaking: false
audience: user
draft: true
---
The Pocket page now exposes this workspace three ways. It starts on the local network: it finds the machine's private IPv4 address (192.168 first), and a server bound to it gives the phone a direct `http://192.168.x.y:port` link with no trust entry, since the fence already admits the listener's own bind address. When the server listens on loopback only, the page says so and prints the `prism web --host <address> --port <port>` step instead of a link; the desktop app always starts on loopback. Tailscale and a stable Cloudflare tunnel hostname remain one click away as fallbacks: the page reports both probes, prints the steps they need, and measures an advertised address before calling it ready. The choice is stored in the DSH home's `pocket/remote.json` and survives restarts. The plugin still starts no daemon and changes no trust policy.
