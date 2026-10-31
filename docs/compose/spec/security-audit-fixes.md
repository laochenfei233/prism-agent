---
feature: security-audit-fixes
status: delivered
updated: 2026-10-31
branch: fix/security-audit-run1
commits: 724259145a..814654e53d
---

# Security Audit Fixes

English | [中文](security-audit-fixes.zh.md)

## Report

**What was built** — Model filesystem writes and edits now refuse any target under the harness home in `workspace-write`, while reads and an approved `danger-full-access` retry keep working, so a prompt-injected write can no longer reach the `!!js` patch layer or the installed bundle sources. Native session import validates a foreign log with the stored reader's own event grammar before writing anything, so an unknown required type or a retired shape fails the row instead of creating an unopenable session. Stored image reads re-check the configured byte, pixel, and dimension limits, so an attachment object copied in by import cannot reach a decode above admission.

Release builds now receive the documented updater signing key and upload `.sig`, `latest.json`, and `.app.tar.gz`; the static server authenticates every HTML entry, including the worker preview; and the desktop popup fallback refuses cmd metacharacters before `cmd /C start`.

Residuals recorded in [S2] and [S3]: shell sandbox backends still derive writable roots from the workspace alone; attachment copies still skip the staged publication mode (digest and read limits govern); imported events carry no provenance marker; and the `latest.json` upload location still needs one real release run to confirm.

**Verification** — `pnpm exec vitest run` over the four affected specs: 54 passed. The full `attachment-local` suite plus host `session-import` specs: 123 passed, 1 skipped. `pnpm run typecheck`: 5/5 gates passed. `cargo test --lib`: 30 passed before the review round; targeted `cargo test --lib cmd_start`: 3 passed, including a direct `open_with_os` refusal. Named translation pairs are consistent; the corpus-wide check belongs to `doc-sync`. `verify-md-wrap` and `verify-md-links`: pass. `verify-package-dependencies`: the pre-fix run reported exactly the two unclassified imports, and the policy now classifies the reader validator; the full rerun hangs in this worktree's tsx/esbuild environment, so no green rerun is claimed. Repo-wide `pnpm run lint` is red on untouched baseline files (verified on two untouched files in the main checkout); linting only the changed TypeScript paths reports 0 errors. The client `ImportSection` spec fails only under this worktree's local hoisted install and passes on the unmodified checkout; no client code changed.

**Journey log** — The audit's reader has two independent refusals; the first fix mirrored only the vocabulary one, and review caught the retired `request/header` shape, so the import now delegates to `validateStoredEvents` instead of restating the grammar. A fresh worktree's pnpm junctions break Node ESM resolution, so verification used a local hoisted install (not committed), and that install's jsdom/React gaps explain the client-only failures. Read-time attachment limits change the documented "tightening limits keeps history readable" promise; the README now states the new behavior. The shell backends remain outside this fence because closing them needs a deny rule in every dialect.

## [S1] Problem

`security-audit-skill/prism-agent/run-1` audited commit `724259145a` with a source-only policy, so none of its six leads is a confirmed vulnerability. Each lead still describes a real crossing between content arriving under a trusted carrier and a consumer that assumes the carrier's trust:

1. A model filesystem write reaches `$DSH_HOME/cordis.patch.yml`, which the host live-evaluates through the loader's `!!js` dialect.
2. A received DSH-format folder is appended verbatim as session events; the reader later refuses unknown event types with a wrong "newer harness" cause and the import cannot be repaired.
3. Imported attachment objects merge into the live store past admission, then reach image re-encoding.
4. No committed workflow maps the updater signing key that `apps/desktop/README.md` documents, and the upload globs omit updater artifacts.
5. An unauthenticated `/preview.html` boots a worker tunnel that answers as the owner Peer.
6. The desktop popup fallback passes a web-content URL to `cmd /C start`, where metacharacters split the command.

## [S2] Design

### [S2.1] Harness-home fence for tool filesystem writes

The sandbox-enforcing filesystem backend refuses every write and edit whose canonical target lies under the harness home while the per-call mode is `workspace-write`. The home is resolved once per backend instance from `resolveDshHome()` (`$DSH_HOME`, then `~/.prism`), which is the same resolution `app-boot` exposes as `dshHomePath` and every home-rooted store uses. The refusal is `FS_SANDBOX_DENIED`, so the model sees the standard `[sandbox: …]` marker and can request a wider mode; an approved `danger-full-access` call returns before the guard, which is exactly the owner-consent escape hatch the rest of the fence uses. Reads through the fence are unchanged.

This closes the model tool path into composition-consumed files: the home patch, profile patches, and the bundle sources under `$DSH_HOME/node_modules` that the loader imports and the HMR watcher reloads.

The shell backends keep their own grant spellings and still derive writable roots from the workspace alone, so a sandboxed command in a workspace that contains `$DSH_HOME` can still write there. Closing that needs a deny rule in every dialect (Landlock cannot express a subpath exclusion at all), which is a separate change; the audit traced the tool filesystem path, and that path is now fenced.

### [S2.2] Foreign-record validation before a native import is written

`SessionImportEngine.writeNative` validates the foreign log with the stored reader's own `validateStoredEvents` before it creates the session: an unknown required type, the retired `request/header` fallback, or an invalid envelope fails the row before anything is written. A refused log becomes a `failed` import row with the reader's reason and writes nothing, so no bricked session is created, no wrong refusal cause is stored, and the duplicate check cannot block a later repair.

Attribution is unchanged: imported events still carry the source's provider and model, just as the normalized path labels foreign user text with `source.kind: 'user'`. The event vocabulary has no imported-content provenance marker on any path, so whether preserved foreign attribution needs one is a product decision recorded here as deferred.

### [S2.3] Admission limits enforced when a stored image is read

`LocalAttachmentStore.readImage` re-checks the verified reference against the store's admission limits before returning bytes: encoded bytes, total pixels, and per-side dimension, in the same order admission applies. The verified reference already matches the stored header's media type, so type membership needs no separate check. Every consumer reads images through that method, including `readImageRequest`, which re-encodes from the same verified bytes. A foreign attachment object copied into the store by the import can therefore no longer feed a decoded image past the configured pixel and dimension caps into sharp or into a provider request.

The copy still skips the staged `0400` publication; that mode is not what protects the bytes inside the owner-private store, because every read re-verifies the digest and the reference fields. Bytes and metadata are authoritative; file mode is not.

### [S2.4] Updater signing in the release workflow

`desktop-release.yml` maps `secrets.TAURI_SIGNING_PRIVATE_KEY` and `secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD` into both the `tauri-action` step and the macOS `pnpm tauri build` step, and the artifact upload globs include `.sig`, `latest.json`, and `.app.tar.gz` under both bundle spellings. This matches the release prerequisite `apps/desktop/README.md` already documents; the repository secret and its custody stay account state.

### [S2.5] Authentication for every HTML entry

`serveStatic` sends every `.html` target through the browser-authentication gate: the dist root and configured index still render through the index taps, and any additional page the build emits, including `preview.html`, is served only to an authenticated browser. Non-HTML assets stay public by design, because the authenticated page loads them without a cookie round-trip on each request. An unauthenticated preview request now receives the same 401 body as the index, so the owner-Peer worker tunnel cannot be booted from an unauthenticated peer.

### [S2.6] Metacharacter refusal in the desktop popup fallback

`open_with_os` on Windows refuses a URL containing whitespace, control characters, or any of `& | < > ^ % " ( ) !` before it builds the `cmd /C start` argv; the opener plugin remains the primary path and macOS/Linux are unchanged. A refused URL is reported through the existing `opened=false` log line instead of starting a second command.

## [S3] Scope

- In scope: the six leads above, each with the smallest change that removes the crossing and a focused test.
- Out of scope: the shell sandbox home exclusion, imported-content provenance markers, attachment copy publication modes, the account-state parts of the release secret, and every other hardening note in the audit's section 6.

## Tasks

- [x] T1: deny tool writes under the harness home in `fs-sandbox` with coverage (depends: none, covers: S2.1)
- [x] T2: validate foreign events before a native import writes (depends: none, covers: S2.2)
- [x] T3: enforce admission limits when a stored image is read (depends: none, covers: S2.3)
- [x] T4: map the updater signing key and upload updater artifacts (depends: none, covers: S2.4)
- [x] T5: authenticate every HTML entry in `frontend-static` (depends: none, covers: S2.5)
- [x] T6: refuse cmd metacharacters in the popup fallback (depends: none, covers: S2.6)
- [x] T7: run the affected tests, typecheck, and lint (depends: T1, T2, T3, T4, T5, T6)
- [x] T8: record delivery evidence in this document (depends: T7)

## [S4] Acceptance

- [x] `workspace-write` writes and edits under `$DSH_HOME` are refused with `FS_SANDBOX_DENIED`, no file is created, and a `danger-full-access` call still writes.
- [x] A native import whose log carries an unknown required event type returns a `failed` row and creates no session; a known log still imports natively.
- [x] `readImage` refuses a stored image above a configured byte, pixel, or dimension cap with an admission error code, and still returns an admitted image.
- [x] The release workflow passes the signing key to both build steps and uploads `.sig`, `latest.json`, and `.app.tar.gz`.
- [x] An unauthenticated `/preview.html` request receives the index 401 response, while an authenticated one serves the page.
- [x] `open_with_os` refuses a URL with shell metacharacters on Windows and accepts a plain `https` URL.
