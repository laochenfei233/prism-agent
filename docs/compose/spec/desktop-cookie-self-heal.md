---
feature: desktop-cookie-self-heal
status: in-progress
updated: 2026-11-03
branch: feat/desktop-cookie-self-heal
commits: ee497b0bc4..(pending)
---

# Desktop cookie self-heal

## Report

## [S1] Problem

After enough desktop restarts, the shell permanently fails its welcome flow with a
web-authentication error; reinstalling and disabling plugins do not help.

Root cause: `BrowserAuth` names its session cookie `dsh-auth-` + sha256 of the
request authority, and HTTP authorities include the port. The desktop picks its
port at every spawn (default port, first free fallback when occupied), so each
launch on a churned port mints a new cookie name while the old ones — domain-scoped,
30-day lifetime — keep accumulating for `127.0.0.1`. Around 70 cookies the `Cookie`
request header crosses Node's 16 KiB `maxHeaderSize` default; the listener rejects
every request with 431 in the parser, before any handler — including the
launch-token exchange that could mint and prune — can run. Deleting the browser
profile's Cookies store is the only recovery.

## [S2] Design

### S2.1 Prune stale session cookies at mint

`BrowserAuth` parses the request's `Cookie` header whenever it mints (`authorizeIndex`
token branch, `authorizeConnect`), collects every `dsh-auth-` cookie name that is not
the name it is minting, and answers with one expired `Set-Cookie` per stale name
(same attributes as the mint, empty value, `Max-Age=0`, epoch `Expires`). The browser
deletes those cookies, so one domain keeps at most one browser cookie plus one API
cookie no matter how ports churn. Deleting never touches the signing secret, so it
also clears cookies from older secrets and versions.

`ConnectionIndexResponse.writeHead` widens its headers value to the same
`string | readonly string[]` form `ConnectionTrustRequest` already uses, so the mint
responses can carry several `Set-Cookie` values.

### S2.2 Listener header bound above the legacy bloat

`WebServer` creates its HTTP and HTTPS listeners with a fixed 64 KiB `maxHeaderSize`.
A wedged install therefore delivers its next token-bearing request to the mint path,
S2.1 prunes the store back to one cookie, and the shell heals on the first launch
after upgrading — no manual Cookies-store deletion. The bound stays a fixed constant:
a request-parsing safety bound, not a deployment choice.

Rejected: wiping webview browsing data from the Rust shell at startup (platform cookie
APIs, destroys unrelated webview state); a stable-port-only fix (port conflicts remain,
wedged installs do not heal, `dsh web` browser users gain nothing).

## Scope

- In scope: `dsh-client-connection` prune-at-mint; `dsh-host-webserver` header bound; regression tests; README/JSDoc updates for both packages; changelog entry.
- Out of scope: desktop Rust port selection; cookie-secret rotation; the API gateway's own admission checks (same listener, already covered by S2.2).

## Tasks

- [ ] T1: widen `ConnectionIndexResponse.writeHead` headers type (depends: none)
- [ ] T2: prune stale `dsh-auth-` cookies in `authorizeIndex` mint branch and `authorizeConnect` (depends: T1)
- [ ] T3: fixed 64 KiB `maxHeaderSize` on the WebServer HTTP and HTTPS listeners (depends: none)
- [ ] T4: regression tests — prune behavior (browser-auth spec), oversized-cookie request reaches the mint path (webserver spec) (depends: T2, T3)
- [ ] T5: package README + changelog entry (depends: T2, T3)

## [S4] Acceptance

- [ ] Minting after requests carried cookies for other ports answers with expired `Set-Cookie` headers exactly for the stale names, and the mint cookie for the current authority.
- [ ] A request whose `Cookie` header exceeds Node's 16 KiB default still reaches the route handler on a real `WebServer` listener (no 431), over HTTP and TLS.
- [ ] A wedged cookie store heals end-to-end: oversized header → token exchange → 303 + prune headers → next request carries one `dsh-auth-` cookie and authenticates.
- [ ] Existing suites for both packages stay green.
