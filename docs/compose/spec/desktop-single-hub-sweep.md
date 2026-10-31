---
feature: desktop-single-hub-sweep
status: delivered
updated: 2026-10-29
branch: feat/desktop-single-hub-sweep
commits: c64d35c4..5be9dc96
---

# Desktop Single-Hub Sweep

English | [中文](desktop-single-hub-sweep.zh.md)

## Report

**What was built** — The shell now ends rival hubs before deciding which hub serves it. `is_our_dsh_web_server` recognizes a hub by the installed closure path (`runtime/prism/lib/bin.js`, the Windows install and the macOS app bundle) or by this checkout's built CLI (`prism-agent/apps/cli/lib/bin.js`, linked worktrees included), after lowercasing and normalizing separators; `rival_pids` is the pure decision core; the enumeration reads `Get-CimInstance` on Windows with UTF-8 output and `ps` on macOS/Linux, under a 3 s budget; and `sweep_rival_servers` ends every match except the adopted pid at adoption and before every cold spawn, skipping debug builds. Stock dsh, Easel, manually launched `prism web`, and the sibling `deepseek-harness` checkout are never matched; the two-release-install and POSIX-signal limits are stated in S3. The desktop README's hub contract, the port-resilience scope note, the startup-latency S5 row, and the divergence index record the change beside this document.

**Verification** — All run in the worktree at 5be9dc96 (base c64d35c4):

- `cargo fmt --check` in `apps/desktop/src-tauri` — PASS.
- `cargo test` in `apps/desktop/src-tauri` — PASS, 17 passed, 0 failed. The two sweep tests and the CIM parser test run on Windows; `ps_sample_parser_accepts_ps_output` compiles out here and runs on macOS/Linux CI.
- PowerShell encoding probe against a `node.exe` command line naming `C:/Users/陈/...` — the prefixed query emitted valid UTF-8 with the full line; the unprefixed query emitted invalid UTF-8, so the fix is load-bearing.
- `pnpm run verify-translation-pairing` on the five changed pairs — PASS.
- `pnpm run verify-md-wrap` — PASS, 2074 files.
- `pnpm run verify-md-links` — PASS, 2034 files.
- `git diff --cached --check` — clean on every commit.
- Wiring check — `sweep_rival_servers(None)` at `dsh_runner.rs:140` precedes `spawn_child` at 141, and `sweep_rival_servers(Some(record.pid))` at 236 precedes `self.port.store` at 237.
- Independent review — round 1 found the encoding bug, the unbounded enumeration, and four scope questions; a focused re-review passed the encoding fix, the 3 s budget, and every S3 ruling, with this finalization as its only remaining item.

**Journey log**

- The review's byte probe caught what no unit test could: PowerShell 5.1 writes redirected output in the console code page, so a Chinese user name made `ConvertTo-Json`'s bytes invalid UTF-8 and the sweep silently did nothing. The query now sets `[Console]::OutputEncoding` first, and a non-ASCII path is part of the CIM parser test.
- The sweep sits on the startup path, so the enumeration is a 3 s `kill_on_drop` child. An abandoned enumeration cannot end a hub the shell just booted, because the kill loop consumes only a completed enumeration's targets.
- Scope is per product, not per install or per home: matching a generic `deepseek-harness/apps/cli` would end stock-dsh users' servers, and two release installs at different closure paths are recorded as an unsupported concurrency instead of a kill-back fight.
- One sweep cannot durably stop a rival supervised shell from restarting its hub: each start re-establishes one hub, a running dev shell can still recreate its hub, and two installs at different closure paths are the limit S3 records.

## [S1] Problem

Every shell start either adopts the hub named by `$DSH_HOME/desktop-server.json` or boots a new `dsh web` on the first free port in 3081..=3131. The record is the only evidence the decision consults, so a hub that is alive but not adoptable is invisible: a dead shell's orphan whose record was overwritten, a hub started from a replaced runtime closure, a parallel launch, or a dev shell's hub beside the installed one. Each of them serves the same `~/.prism` session store, and the session writer lock admits one writer per session, so the window that loses the race reports `session/writer-held` — the "occupied by another dsh" failure the Easel shell hit and fixed by ending its own rival servers at every decision point.

Port fallback hides the split instead of failing it: `select_port` moves the new hub to 3082, the shell shows a working interface, and both hubs keep running against one home. The desktop README's port contract already lets the 3081..=3131 scan absorb a foreign listener; it has no answer for a second Prism hub.

## [S2] Design

### S2.1 Product-scoped process signature

`is_our_dsh_web_server(command_line)` accepts a command line only when all three conditions hold:

- It contains `bin.js`.
- It contains the contiguous argument pair ` web --port`, the form `spawn_child` builds (`<bin> web --port <port> --no-open`).
- It names one of the two paths this product boots its hub from: `/runtime/prism/` (the installed closure — `<install>/runtime/prism/lib/bin.js` on Windows and `Prism Agent.app/Contents/Resources/runtime/prism/...` on macOS), or `prism-agent/` together with `/apps/cli/` (this checkout and its linked worktrees, where `resolve_runtime`'s dev fallback resolves the built CLI).

The command line is lowercased and its backslashes are normalized to `/`; Windows (`CIM`) and macOS (`ps`) then match under one rule. CIM returns the quoted image path verbatim (`"C:\...\bin.js" web --port ...`), so the markers are matched as separate substrings rather than the contiguous `bin.js web` a naive check would require.

The three conditions keep another harness build out of the sweep by construction: a stock `deepseek-harness` hub (`.../runtime/dsh/lib/bin.js`), an Easel hub (`.../easel-dsh/runtime/dsh/lib/bin.js`), and an unrelated Node server share neither path marker. A CLI server the user starts by hand (`prism web`, `pnpm dsh web` — `apps/cli/src/bin.ts`, often relative and without `--port`) does not match either; the shell keeps 3080 free for it by contract, so that boundary is deliberate and recorded in S3.

### S2.2 Decision core

`rival_pids(samples, keep)` is the whole decision, kept free of process I/O so it is testable: every sampled pid whose command line matches S2.1, except `keep`. The supervisor passes `Some(record.pid)` when it is about to adopt a verified hub and `None` when it is about to cold-spawn. A `keep` that names no live process only loses the exemption; every other rival is still ended.

### S2.3 Process enumeration

Windows enumerates through `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` and selects `ProcessId, CommandLine` (`wmic` is deprecated on current Windows). `ConvertTo-Json` renders a single match as a bare object and several as an array, so both forms are accepted. PowerShell 5.1 encodes redirected output in the console code page, so the query sets `[Console]::OutputEncoding` to UTF-8 before it runs; a non-ASCII install path would otherwise make the JSON invalid UTF-8 and silently disable the sweep. The enumeration runs under a 3 s budget: an overrun kills the enumerator and yields an empty sweep, so a stuck shell cannot hold the splash. An enumeration that fails yields an empty list: missing rivals cost a conflict the next start sweeps again, while a failed launch costs the window. macOS and Linux parse `ps -axo pid=,command= -ww`; `-ww` disables the terminal-width truncation that would cut off the ` web --port` tail, and the pid column is right-aligned, so leading spaces are trimmed; `ps` lists every process and the signature alone decides, so an unrelated process would have to spell the product path and the CLI form out in its own arguments to match, and would then be ended.

### S2.4 Wiring and timing

- `adopt_running_server` sweeps with `Some(record.pid)` after the record's launch token authenticates and before the adopted port is published.
- `supervise` sweeps with `None` on the cold path, before `spawn_child`, so `select_port` sees the ports the sweep just released and the new hub takes 3081 instead of a fallback; on Windows `taskkill /F` completes before selection, while on POSIX the released port is seen only if the rival exits promptly after SIGTERM.
- `sweep_rival_servers` enumerates asynchronously and runs the kills on the blocking pool, then appends `rival dsh web sweep targets: [..]` to `desktop-startup.log` when it had targets.
- Debug builds skip the sweep (`cfg!(debug_assertions)`), so `pnpm run dev:desktop` never ends the installed app's hub while a developer compares the two.
- There is no resident watcher: the sweep runs at the two moments the shell already decides which hub serves it. A shell that starts while another shell's hub is live but unadoptable ends that hub at its own start; a shell already running is not revisited until its next decision point.

## [S3] Scope

- In scope: the signature matcher, decision core, process enumeration, sweep, and the adopt/cold-spawn wiring in `apps/desktop/src-tauri/src/dsh_runner.rs`; their unit tests; the desktop README's hub contract in both languages; the divergence records this change adds.
- Out of scope: a resident monitor that kills servers while the shell runs; the simultaneous-first-launch race (two shells that start together can each boot a hub — the next start sweeps the loser); hubs of other harness builds (they must keep running); manually launched `prism web` / `pnpm dsh web` servers, which the 3080 contract leaves alone; other checkouts of this fork's lineage, such as the sibling `deepseek-harness` tree, because matching a generic `deepseek-harness/apps/cli` path would end stock-dsh users' servers and break install isolation; per-home scoping — the sweep is machine-wide per product, so two release instances separated only by `PRISM_HOME`, or two release installs at different closure paths sharing one home, are not supported as concurrent hubs (each sweeps the other's hub at its next decision point, and one may exhaust its restart budget); POSIX kill escalation — the sweep sends SIGTERM and neither waits nor escalates to SIGKILL, so a hub that ignores SIGTERM survives that spawn; Windows process-tree semantics beyond the existing `terminate_pid`. The single-instance registration added after this spec covers sequential relaunches on every platform and in dev builds; the simultaneous-first-launch race remains out of scope.

## Tasks

- [x] T1: signature matcher, decision core, enumeration, sweep, and the two wiring points (covers: S2.1, S2.2, S2.3, S2.4)
- [x] T2: unit tests — installed and dev paths matched (quoted and case variants, macOS separators), stock dsh/Easel/manual CLI excluded, `keep` three-state semantics, `ps` sample parser, and the CIM JSON parser's bare-object/array forms (covers: S2.1, S2.2, S2.3)
- [x] T3: desktop README port/hub contract and the port-resilience scope note, both languages (covers: S2.4)
- [x] T4: divergence records — `PRISM-DIVERGENCE` marker at the sweep site, this document's S5, the related-documents list in `fork-upstream-divergence.md`, and the stale test-count claim in `desktop-startup-latency.md` S5 (covers: S2.1, S2.4)
- [x] T5: verification — record every command and result under [S4] (depends: T1, T2, T3, T4)

## [S4] Acceptance

- [x] A1: a quoted, differently cased installed command line (`"C:\...\Prism Agent\runtime\prism\lib\bin.js" web --port 3081 --no-open`), a worktree dev line (`.../prism-agent/.worktrees/<name>/apps/cli/lib/bin.js web --port ...`), and a macOS app-bundle line match the signature; stock-dsh, Easel, and unrelated Node servers do not; a manual `apps/cli/src/bin.ts web` line does not (test: `rival_sweep_*`).
- [x] A2: `rival_pids` returns every matching pid except `keep`; `keep: None` returns all matches; a `keep` naming a sampled rival spares only that pid (test: `rival_sweep_kills_orphans_and_dev_hubs_but_spares_the_kept_hub`).
- [x] A3: `adopt_running_server` sweeps with the verified record's pid, and `supervise` sweeps with `None` before `spawn_child` (`dsh_runner.rs` line references in the report).
- [x] A4: debug builds return before enumeration (`cfg!(debug_assertions)`), so a dev shell cannot end the installed hub.
- [x] A5: `cargo fmt --check` and `cargo test` pass under `apps/desktop/src-tauri`, and the changed bilingual pairs pass `verify-translation-pairing` and `verify-md-wrap`.

## [S5] Upstream divergence

This checkout imports upstream `deepseek-harness/deepseek-harness` as one baseline commit, so a later upstream import replaces `apps/desktop/**` wholesale instead of merging with it. The sweep is one of the shell edits that area A1 of [fork-upstream-divergence.md](fork-upstream-divergence.md) carries; the marker above `is_our_dsh_web_server` names this section.

| File | Divergent site | What a replay must keep |
| --- | --- | --- |
| `apps/desktop/src-tauri/src/dsh_runner.rs` | `is_our_dsh_web_server`, `rival_pids`, `list_process_samples`, `parse_cim_samples`, `parse_ps_samples`, `sweep_rival_servers` (including the 3 s enumeration budget), and the two call sites in `adopt_running_server` and `supervise` | the block and both call sites; the `rival_sweep_*`, `cim_sample_parser_*`, and `ps_sample_parser_*` tests are its decision coverage, and `cargo test` in `apps/desktop/src-tauri` is the replay check |
| `docs/compose/spec/desktop-single-hub-sweep.*` | this document | nothing, since upstream has no such file |
