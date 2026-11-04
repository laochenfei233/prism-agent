type: added
breaking: false
audience: user
draft: true
---
The Pocket page can now expose this workspace over a stable Cloudflare tunnel as well as Tailscale. Pick the route at the top of the phone panel; a tunnel hostname you enter (the address your named `cloudflared` tunnel serves) becomes the phone link once the trust list admits it, and the page reports whether `cloudflared` is installed. The choice is stored in the DSH home's `pocket/remote.json` and survives restarts. The plugin still starts no daemon and changes no trust policy: it prints the `cloudflared tunnel run` step and the `trustedHosts` entry, then measures the address before calling it ready.
