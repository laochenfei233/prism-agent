---
feature: desktop-cookie-self-heal
status: delivered
updated: 2026-11-05
branch: feat/desktop-cookie-self-heal
commits: ee497b0bc4..5d6bd12029
---

# Desktop cookie self-heal

English | [中文](desktop-cookie-self-heal.zh.md)

## Report

**What was built** — The desktop web-authentication wedge is fixed at both ends of the failure chain. `BrowserAuth` now expires every other `dsh-auth-` cookie the request still carries whenever it mints (`authorizeIndex` token exchange, `authorizeConnect`), so one domain keeps at most the mint cookie per surface no matter how the desktop's loopback port churns across launches. The web listener (`dsh-host-webserver`, HTTP and HTTPS) binds a fixed 64 KiB `maxHeaderSize` above Node's 16 KiB default, so an install already wedged past the old default delivers its next token-bearing request to the mint path and prunes itself back to one cookie on the first launch after upgrading — no manual deletion of the browser profile's Cookies store.

`ConnectionIndexResponse.writeHead` widened its headers record to accept `string[]` values (mutable arrays, so node's `ServerResponse` stays structurally compatible). Regression coverage: prune assertions in `browser-auth.host.spec.ts` (HTTP and TLS, browser and API cookies), oversized-Cookie-header requests served by the real webserver over HTTP and TLS, and an end-to-end heal through the real frontend-static composition (80 stale cookies → 303 with 81 Set-Cookie headers → next request authenticates with only the mint cookie).

**Verification** — Focused suites in the worktree: `pnpm vitest run` over browser-auth.host.spec, node-half.host.spec, webserver.spec, frontend-static.spec, gateway.host.spec, operator-connect.host.spec — 6 files, 115 tests, 0 failures. The end-to-end heal test fails on unfixed master at the 431 (failing-first). `pnpm run typecheck` — 5/5 gates pass. Doc gates: the two edited README pairs (en+zh) pass every summary/model-experience/concrete-terms check; the remaining `test:docs` failures reproduce identically on master (pre-existing). Pre-commit lefthook died with the sandbox msys `0xc0000142` limitation; oxlint (staged config), `git diff --cached --check`, and the vendor manifest guard were run by hand — all clean.

**Journey log** —
- A server-side prune alone cannot recover a wedged install: once the header crosses the parser bound, Node answers 431 before any handler runs. Prevention and the raised listener bound have to ship together.
- Widening the response headers with `readonly string[]` broke `ServerResponse` compatibility — `OutgoingHttpHeaders` accepts only mutable arrays.
- `gen-cordis-catalog` was broken at this fork's baseline (24 pre-existing cron type-link coverage violations, reproducible on master), so the generated catalog entry for the changed declaration was hand-projected in the generator's format (member JSDoc is never recorded). Resolved 2026-11-05: the cron and speech-to-text types were classified in the generator's policy maps and the generator now runs end-to-end, regenerating this entry with full member JSDoc.
- The desktop's port churn comes from `select_port()`'s occupied-default fallback scan, not truly random ports; the cookie mechanism accumulates either way, so the Rust side was correctly left untouched.
- The reviewer's cross-instance note: on a shared public hostname, authenticating to instance B expires instance A's cookie in that browser — token-gated, self-inflicted, and the accepted "one cookie per domain" design.

## [S1] Problem

After enough desktop restarts, the shell permanently fails its welcome flow with a web-authentication error; reinstalling and disabling plugins do not help.

Root cause: `BrowserAuth` names its session cookie `dsh-auth-` + sha256 of the request authority, and HTTP authorities include the port. The desktop picks its port at every spawn (default port, first free fallback when occupied), so each launch on a churned port mints a new cookie name while the old ones — domain-scoped, 30-day lifetime — keep accumulating for `127.0.0.1`. Around 70 cookies the `Cookie` request header crosses Node's 16 KiB `maxHeaderSize` default; the listener rejects every request with 431 in the parser, before any handler — including the launch-token exchange that could mint and prune — can run. Deleting the browser profile's Cookies store is the only recovery.

## [S2] Design

### S2.1 Prune stale session cookies at mint

`BrowserAuth` parses the request's `Cookie` header whenever it mints (`authorizeIndex` token branch, `authorizeConnect`), collects every `dsh-auth-` cookie name that is not the name it is minting, and answers with one expired `Set-Cookie` per stale name (same attributes as the mint, empty value, `Max-Age=0`, epoch `Expires`). The browser deletes those cookies, so one domain keeps at most one browser cookie plus one API cookie no matter how ports churn. Deleting never touches the signing secret, so it also clears cookies from older secrets and versions.

`ConnectionIndexResponse.writeHead` widens its headers record to accept array values — mutable `string[]`, because `OutgoingHttpHeaders` rejects readonly arrays and node's `ServerResponse` must keep satisfying the interface — so the mint responses can carry several `Set-Cookie` values.

### S2.2 Listener header bound above the legacy bloat

`WebServer` creates its HTTP and HTTPS listeners with a fixed 64 KiB `maxHeaderSize`. A wedged install therefore delivers its next token-bearing request to the mint path, S2.1 prunes the store back to one cookie, and the shell heals on the first launch after upgrading — no manual Cookies-store deletion. The bound stays a fixed constant: a request-parsing safety bound, not a deployment choice.

Rejected: wiping webview browsing data from the Rust shell at startup (platform cookie APIs, destroys unrelated webview state); a stable-port-only fix (port conflicts remain, wedged installs do not heal, `dsh web` browser users gain nothing).

## Scope

- In scope: `dsh-client-connection` prune-at-mint; `dsh-host-webserver` header bound; regression tests; README/JSDoc updates for both packages; changelog entry.
- Out of scope: desktop Rust port selection; cookie-secret rotation; the API gateway's own admission checks (same listener, already covered by S2.2).

## Tasks

- [x] T1: widen `ConnectionIndexResponse.writeHead` headers type (depends: none)
- [x] T2: prune stale `dsh-auth-` cookies in `authorizeIndex` mint branch and `authorizeConnect` (depends: T1)
- [x] T3: fixed 64 KiB `maxHeaderSize` on the WebServer HTTP and HTTPS listeners (depends: none)
- [x] T4: regression tests — prune behavior (browser-auth spec), oversized-cookie request reaches the mint path (webserver spec) (depends: T2, T3)
- [x] T5: package README + changelog entry (depends: T2, T3)

## [S4] Acceptance

- [x] Minting after requests carried cookies for other ports answers with expired `Set-Cookie` headers exactly for the stale names, and the mint cookie for the current authority.
- [x] A request whose `Cookie` header exceeds Node's 16 KiB default still reaches the route handler on a real `WebServer` listener (no 431), over HTTP and TLS.
- [x] A wedged cookie store heals end-to-end: oversized header → token exchange → 303 + prune headers → next request carries one `dsh-auth-` cookie and authenticates.
- [x] Existing suites for both packages stay green.
