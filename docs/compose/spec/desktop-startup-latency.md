---
feature: desktop-startup-latency
status: delivered
updated: 2026-10-01
branch: none, see the Workspace override in S2
commits: uncommitted working tree
---

# Desktop Startup Latency

English | [中文](desktop-startup-latency.zh.md)

## Report

**What was built** — The feature has two layers. Layer 1: the shell records the hub it spawns (`$DSH_HOME/desktop-server.json`) and adopts that hub on the next start instead of booting a second one, guarded by the runtime identity of the CLI entry point, the launch URL's own port and token, and a loopback `GET /?token=…` that must still answer 303. Adoption runs before any spawn in the supervisor, publishes the same `dsh://ready` and `dsh_status` values a spawned hub does, and skips `ensure_home_node_modules`, `ensure_default_plugins`, port selection, the spawn, and about 4.1 s of `dsh web` boot. "Restart service" re-verifies the record and ends an adopted hub by pid so the supervisor replaces it, quitting ends every hub this home is serving — the spawned one together with the children it derived, and the adopted one by pid after re-verifying its record — and a record is dropped once the hub it names stops serving, or with either teardown. Layer 3: the resolver's prefix tables canonicalize through the carrier's realpath (`realModuleDirectory`) instead of the JavaScript `realpathSync`, and `packageDirFromAnchor` lists each searched `node_modules` directory at most once per resolution build, rejecting a candidate only against what that listing proves — a directory that is not there holds nothing, and a readable directory's names are matched case-folded — while the `package.json` probe stays the authority. On the packaged runtime the pair of edits moves `dsh web --help` from 3346 ms to 3039 ms and the cold start to the launch URL from 4269 ms to 3903 ms (interleaved minima over three rounds).

**Verification** — `node ./node_modules/typescript/bin/tsc -p packages/boot/app-boot/tsconfig.json --noEmit` passes. `node ./node_modules/vitest/vitest.mjs run packages/boot/app-boot`, re-run on 2026-10-01 after the divergence markers and the ACL-test fix, passes 19 files, 5575 tests, 2 skipped; both skips are platform conditions this host cannot create — the POSIX-only mode test, and `package-meta.spec.ts`'s case-sensitive-filesystem case — while a focused run of `profile.spec.ts` reads 37 passed | 1 skipped and `-t "probes a search path"` over the whole package reports the Windows ACL test as its single pass, so the unreadable-directory fix is exercised here; that test also constrains the fix, since making `isMissingDirectory` return `true` unconditionally fails it. The same suite under `--coverage` reports uncovered locations only in the pre-existing baseline (`compatibility-preflight.ts:57`, `profile-context.ts:67-68`, and one upward-walk branch in `resolver.ts` — PRE-EXISTING), with no uncovered line in this feature's code. `run-oxlint` over the three changed files is clean. The packaged-runtime A/B reads 3346/3391/3527 ms before against 3039/3150/3165 ms after for `dsh web --help`, and 4269/4301/4356 ms against 3903/3987/4018 ms for the cold start, with an identical activation log on both sides. `cargo fmt --check` is clean and `cargo test` in `apps/desktop/src-tauri` passes 14 tests; the gated cross-process test `DSH_DESKTOP_ADOPT_E2E="<node>|<bin>" cargo test adopts_a_live -- --nocapture` passed in a separate run against the packaged runtime, because it returns early without that variable. `verify-md-wrap` checks 2245 files and `verify-translation-pairing` reports this document's pair consistent. Three independent reviews ran — two on the main change, one on the post-review additions — and all three critical findings are fixed with tests: the case-folded comparison the gate first lacked, the unreadable `node_modules` a listing must not read as empty, and a Windows regression test that first proved nothing because its deny named an account instead of the Everyone SID.

**Journey log**

- Measured before designing: the hub boot is 4081/4086 ms against 718 ms of client work, so the renderer was never the target and Electron was ruled out on that basis; `NODE_COMPILE_CACHE` and `--preserve-symlinks` were rejected on measurement rather than on principle.
- Adoption needs a proof of ownership, and the per-process launch token answering 303 is that proof; the runtime-identity check exists because an app update replaces the bundled closure in place.
- Review caught two consequences of owning a hub with no child: forgetting the record as the shell parked and exited would orphan a live hub beyond any future adoption, and a pid cached at adoption goes stale the moment the hub is replaced in place. Both now key on the record — forget only what stopped serving, kill only what still authenticates.
- The directory-listing gate failed twice in review before it held: it first compared names case-sensitively, so a case-insensitive filesystem could turn an installed package into a missing one, and then it read a directory it could not list as empty, which drops a package the probe would have resolved. A listing now only ever proves absence; everything else goes to the `package.json` probe. Its Windows regression test was itself caught proving nothing — `icacls` does not deny a name-derived account — and now denies the well-known Everyone SID.
- This checkout imports upstream as one baseline commit, so an upstream update is a re-import rather than a merge; every divergence carries a `PRISM-DIVERGENCE` marker listed in S5, so a replay finds the sites without reading the design.

## [S1] Problem

The shell holds its splash for about five seconds on a cold launch, and the interface behind it is not what costs that time. Measured in a real browser against a running hub, the client takes 718 ms from document load to its first mounted frame. The hub the shell spawns needs about 4.1 s before it prints its launch URL, and while it boots the window shows nothing but the splash. A launch that finds a hub from an earlier shell start still listening pays the same 4.1 s again, on the next free port, and leaves the earlier hub running unused.

## [S2] Design

### Measured phases

Measurements below come from this checkout on Windows, using the packaged runtime (`apps/desktop/runtime`, Node 22.23.3) and a Playwright browser against the running hub.

| Phase | Measured | Instrument |
| --- | --- | --- |
| `dsh --version`, the CLI floor | 269 ms | packaged runtime |
| `dsh web --help`, compose without serving | 3453 ms | packaged runtime |
| `dsh web` to launch URL, fresh home | 4086 ms | packaged runtime |
| `dsh web` to launch URL, warm home | 4081 ms | packaged runtime |
| scripts loaded by one composed-and-imported hub | 1261 scripts, 9.0 MiB | V8 coverage |
| sampled hub boot spent in resolution filesystem calls | 1634 ms of 3277 ms | `--cpu-prof` |
| document load to first client frame, cold | 718 ms | Playwright |
| document load to first client frame, reload | 431 ms | Playwright |

Each row is one session's reading of the pre-change runtime: absolute times move with machine load, so Layer 3 quotes both sides of every run it compares.

The hub boot is the wait: roughly 85% of the time the user spends looking at the splash. Its cost is file-system work over the profile's plugin graph. A 5.2 s CPU profile of one boot attributes about 2.7 s of self time to leaf file calls (`lstat` 839 ms, `internalModuleStat` 509 ms, `readFileUtf8` 372 ms, `existsSync` 219 ms, `readlink` 214 ms, `realpath` 157 ms), and `dsh web --help` makes 3856 file-system calls (`realpathSync` 2499, `readFileSync` 1350) where `dsh --version` makes 177. Composing and importing that graph is the boot.

### Workspace override

This feature has no worktree, no branch, and no commits. The checkout carries another change in progress, the sandbox profile denies writes to `.git`, and the session reserves commits for an explicit request. The work is delivered as working-tree edits, and this document records that in place of a branch and a commit range.

### Layer 1 — adopt the hub an earlier shell start left running

The shell records the hub it spawns in `$DSH_HOME/desktop-server.json` — port, launch URL, pid, and the resolved CLI entry point with its length and modification time — at the moment the launch URL is parsed from the child's stdout. Before spawning anything, the next start reads that record and adopts the hub when all three checks hold:

1. The record names the CLI entry point this shell would run, by path, length, and modification time, so an app update never adopts a hub started from the previous closure.
2. The recorded URL is this port's loopback launch URL and carries its token.
3. A loopback `GET /?token=…` on that port answers 303, which only the process that printed the URL does: the token is per process, so a recycled port or a foreign listener cannot answer it.

An adopted hub is otherwise indistinguishable from a spawned one. The supervisor publishes `dsh://ready` with the adopted port, `dsh_status` reports the same port and URL, and the frontend loads the same authenticated URL, so the client contract does not change. Adoption skips `ensure_home_node_modules`, `ensure_default_plugins`, port selection, the spawn, and the 4.1 s boot. "Restart service" re-reads the record, re-verifies it, and only then ends the adopted hub by pid (`taskkill` on Windows, `kill` elsewhere), so the supervisor's port watch turns the request into a cold spawn; a hub whose record no longer authenticates is left alone and replaced on a free port, because a pid from a replaced server may have been recycled. Quitting ends every hub this home is serving: the one it spawned together with the children that hub derived, and the one it only adopted by pid after re-verifying its record, so no hub outlives the window. The record is forgotten once the hub it names has stopped serving, or with either teardown, but never while an adopted hub still listens — the hub an earlier shell's abrupt exit left behind is exactly what the next start adopts. It is not written for a URL that does not name the port and token of the spawn that printed it, and the recording does not depend on the app log directory being writable.

### Layer 2 — keep the hub warm across app exit (rejected)

Adoption pays only while a hub outlives the shell that started it, which today means a crash, a force-quit, or a second launch while the first is still running. Letting the hub outlive the window would turn every later launch into an adoption and remove the wait entirely; the price is a Node process and a bound loopback port that survive the window.

The product decision is no: nothing this application runs may outlive its window. Quitting the app still ends the hub, so every launch after a quit is a cold boot, and Layer 1 stays as the only reuse — it adopts a hub that is already running, which costs nothing when none is.

### Layer 3 — compress the hub boot itself

The first launch of every session pays the whole boot, so the boot is the wait. One boot composes the profile and imports its entire plugin closure before it serves anything: in the interleaved run measured below, `dsh web --help`, which composes and imports but never serves, is 3346 ms of the 4269 ms cold start, and that run loads 1261 scripts totalling 9.0 MiB. Reading and compiling them is not the cost — `compileSourceTextModule` is 152 ms of the 3277 ms profile — while half the sampled time is filesystem work inside module resolution.

Two of those calls belong to this repository, both in `dsh-app-boot`:

| Filesystem work | Sampled | Why it cost that |
| --- | --- | --- |
| `canonicalPath` called `fs.realpathSync` | 351 ms | the JavaScript realpath `lstat`s every path component, and one resolution canonicalizes a directory for every installed package, so ~400 paths cost ~4800 calls |
| `packageDirFromAnchor` probed `existsSync(<candidate>/package.json)` for every candidate | 129 ms | one probe per declared dependency, and most candidates name a `node_modules` directory that does not exist |

The prefix tables now canonicalize through `realModuleDirectory` — the carrier's realpath, which is `fs.realpathSync.native` outside a packaged executable and asks the filesystem once for the whole path — and `packageDirFromAnchor` lists each searched `node_modules` directory once per resolution build and rejects a candidate only against what that listing proves: a directory that is not there holds nothing, and a readable directory's names are matched case-folded. Every other candidate — a name the listing does hold, and any candidate in a directory the process could not list — still reaches the `package.json` probe, which stays the authority on whether the entry is a package. A build constructs its own listing map, so a later build re-reads the filesystem; `loadProfileDirectory` resolves its bundles one at a time and so lists per bundle, a cost the cold start never pays because it composes through `createRuntimeResolution`.

Measured on the packaged runtime as three interleaved pairs — the two builds alternating, so machine load cancels — quoting the minimum of each side:

| Command | Before | After |
| --- | --- | --- |
| `dsh web --help` | 3346 ms | 3039 ms |
| `dsh web` to launch URL | 4269 ms | 3903 ms |

Three rounds of each build alternate, so machine load cancels, and no round reverses: `dsh web --help` read 3346/3391/3527 ms before against 3039/3150/3165 ms after, and the cold start 4269/4301/4356 ms against 3903/3987/4018 ms. Absolute values still track machine load, which moves both sides together. Both rows come from the packaged `dsh-app-boot` copy with these two edits applied by hand, because this checkout cannot run `apps/desktop/scripts/bundle-runtime.mjs` (it deploys through pnpm); that copy is gitignored and was restored byte-identical afterwards (sha256 `0ab71e0d…`), so reproducing these numbers means rebuilding the runtime from this source. Both builds print the same activation log — ten lines with ports, tokens, paths, and numbers masked, equal on both sides.

What remains is Node's own resolution of the closure's 1261 modules — internal `stat`, `realpath`, and package-scope lookups for every import — which only a prebuilt bundle of the closure removes, and that changes how a profile's rows resolve by package name. It is out of scope here (see S3).

### Rejected approaches

| Approach | Measurement | Verdict |
| --- | --- | --- |
| Electron or Chromium instead of the WebView | client work is 718 ms of about 4800 ms | the wait is the hub, not the renderer |
| `NODE_COMPILE_CACHE` for the hub | 4066/4060/4051 ms against 4184/4174/4174 ms | no gain; the cost is resolution, not compilation |
| `--preserve-symlinks` for the hub | 2846 ms against 3104 ms for `dsh web --help` | rejected despite the 260 ms: the router and Node's loader would name the same module by two URLs under a profile whose `node_modules` is a junction |
| bundling the closure with the hub's own resolver untouched | not attempted | the remaining cost is Node's per-module resolution, which the resolver does not own |

## [S3] Scope

- In scope: recording the spawned hub; the adopt decision with its runtime-identity and token checks; adoption in the supervisor; restart-by-pid for an adopted hub; ending the spawned hub's process tree and any re-verified adopted hub on quit; unit tests and one gated cross-process test; canonicalizing the resolver's prefix paths through the carrier's filesystem; listing each searched `node_modules` directory once per resolution build; this document.
- Out of scope: keeping the hub alive after app exit (Layer 2, rejected: nothing of this application outlives its window); prebundling the plugin closure, which is Node's per-module resolution and a change to how a profile's rows resolve by package name; adopting a hub this shell did not start, which no stored token could authenticate; the client payload, which is measured and not on the critical path.

## Tasks

- [x] T1: record the spawned hub and adopt it on the next start — acceptance: `cargo test` in `apps/desktop/src-tauri` passes 14 tests, including the adopt-decision cases (covers: S2 Layer 1)
- [x] T2: prove the contract against a real hub — acceptance: `DSH_DESKTOP_ADOPT_E2E="<node>|<bin>" cargo test adopts_a_live -- --nocapture` adopts a live packaged server, ends it by pid, and stops adopting it (covers: S2 Layer 1)
- [x] T3: reject Layer 2 — acceptance: quitting ends the spawned hub's process tree and any re-verified adopted hub (test: `ends_a_live_child_process`), and S2 Layer 2 records the decision (covers: S2 Layer 2)
- [x] T4: canonicalize the resolver's prefix paths through the carrier's realpath — acceptance: `profile.spec.ts`, `profile-resolution.spec.ts`, and `linked-resolution-matrix.spec.ts` pass, and the packaged `dsh web --help` A/B falls from 3346 ms to 3039 ms over three interleaved rounds (covers: S2 Layer 3)
- [x] T5: list each searched `node_modules` directory once per resolution build — acceptance: `skips a declared dependency whose node_modules entry holds no manifest` passes and the whole `packages/boot/app-boot` suite passes 5575 tests with 2 skipped (covers: S2 Layer 3)

## [S4] Acceptance

- [x] A hub recorded by this build, still serving with its launch token, is adopted without spawning a child (tests: `adopts_the_recorded_server_while_its_token_is_accepted`, `adopts_a_live_dsh_web_server_and_rejects_it_once_gone`)
- [x] A record whose URL, token, runtime identity, or server no longer matches is not adopted (tests: `rejects_urls_that_name_another_port_or_no_token`, `rejects_a_record_whose_token_no_longer_authenticates`, `rejects_a_record_from_a_runtime_this_shell_no_longer_runs`, `reports_no_adoption_without_a_record`)
- [x] Restarting while adopted ends the adopted hub by pid and releases its port (test: `adopts_a_live_dsh_web_server_and_rejects_it_once_gone`, `terminate_pid`)
- [x] Quitting ends every hub this home serves: the spawned one together with the children it derived, and the adopted one by pid after re-verifying its record (test: `ends_a_live_child_process`; `dsh_runner.rs`: `stop`)
- [x] The record is dropped once the hub it names stops serving, and not while an adopted hub still listens (`dsh_runner.rs`: the adopt park forgets only under `!port_open(port)`)
- [x] A restart request never kills a pid whose recorded server no longer authenticates its token (`dsh_runner.rs`: `request_restart` re-runs `adopt_decision` before `terminate_pid`)
- [x] Only a hub that is already running is reused; nothing is still serving after a quit, adopted hubs included (`dsh_runner.rs`: `stop`; S2 Layer 2)
- [x] The prefix tables canonicalize through the carrier's filesystem, so one path costs one filesystem call and not one per component (`resolver.ts`: `canonicalPath` calls `realModuleDirectory`)
- [x] A declared dependency whose `node_modules` directory holds no `package.json` is still skipped, not reported as installed (test: `skips a declared dependency whose node_modules entry holds no manifest`)
- [x] A requested name that differs in case from the directory on disk is answered the way the filesystem answers it, so listing a directory never turns an installed package into a missing one (test: `answers a requested name that differs in case from the installed directory as the filesystem does`)
- [x] A search path the process may search but not list is left to the `package.json` probe instead of being reported as holding no package (tests: `probes a search path whose entries cannot be read rather than reporting the package as missing` on POSIX and `probes a search path whose entries an ACL hides rather than reporting the package as missing` on Windows; the Windows case runs on this host — `-t "probes a search path"` over the package reports it as the one pass — and either case skips only where its platform cannot express the condition)
- [x] One resolution build lists a searched `node_modules` directory at most once (`profile.ts`: the `DirectoryListings` map created in `createRuntimeResolution`, read through `listingOf`)
- [x] A cold start reaches the launch URL faster with identical activation output: 4269 ms before, 3903 ms after (interleaved minima), same activation log (packaged runtime A/B)
- [ ] Launching the shell twice shows the second window on the first hub's port without a second boot, and either exit ends that hub (manual: needs the GUI shell)

## [S5] Upstream divergence

This checkout imports upstream `deepseek-harness/deepseek-harness` as one baseline commit, so a later upstream import replaces these files wholesale instead of merging with them. The sites below are this feature's divergences, and each carries a `PRISM-DIVERGENCE` comment, so `rg PRISM-DIVERGENCE` lists them without reading this section.

Fork-wide index: `fork-upstream-divergence.md` names every area a re-import must replay.

| File | Divergent site | What a replay must keep |
| --- | --- | --- |
| `packages/boot/app-boot/src/profile-resolution/resolver.ts` | `canonicalPath` returns `realModuleDirectory(path)` where upstream calls `fs.realpathSync` | the carrier realpath, one line |
| `packages/boot/app-boot/src/profile.ts` | the listing block (`DirectoryListings`, `DirectoryListing`, `ABSENT_DIRECTORY`, `isMissingDirectory`, `listingOf`, `listedDirectory`, `listingHolds`) and the gate inside `packageDirFromAnchor` | the block and the gate; the `listings` argument threaded through `collectInstallationScopePackages`, `dependencyClosure`, `collectProfileScopePackages`, `createRuntimeResolution`, and `resolveBundleDir` follows from them, and the compiler rejects a dropped argument |
| `packages/boot/app-boot/tests/profile.spec.ts` | the manifest-less test, the case-folded name test, and the two search-path tests (POSIX mode and Windows ACL) | all four; together they are the gate's regression coverage — a name the listing holds is still probed, a differently cased name still resolves, and an unreadable directory still resolves through the probe |
| `apps/desktop/src-tauri/src/dsh_runner.rs` | Layer 1: `ServerRecord` and the adopt, park, restart, forget, and stop paths | the whole file feature; its tests are the replay check, and [desktop-single-hub-sweep.md](desktop-single-hub-sweep.md) S5 lists the rival sweep beside it |
| `docs/compose/spec/desktop-startup-latency.*` | this document | nothing, since upstream has no such file |

`vendor/` is untouched, so its local-modification log needs no entry. A replay holds when `node ./node_modules/typescript/bin/tsc -p packages/boot/app-boot/tsconfig.json --noEmit` and `node ./node_modules/vitest/vitest.mjs run packages/boot/app-boot` pass in the repository root and `cargo test` passes in `apps/desktop/src-tauri`.
