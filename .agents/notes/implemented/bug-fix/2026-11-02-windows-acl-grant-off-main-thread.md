# Agent Note: Windows ACL grants run in a helper child

Status: implemented

English | [中文](2026-11-02-windows-acl-grant-off-main-thread.zh.md)

## Problem

On 2026-11-02 a Prism desktop Host stopped serving every conversation at once: history loads, tool calls, and the web UI all hung while the server process answered TCP connections but never completed a request, and the debugger could not evaluate an expression on the main thread.

The trigger was the first confined command in a workspace that had never been granted. `LocalSandboxProvider.materializeAclGrant` called `AclWriteGrant.add` in-process, and `grantWrite` reaches `SetNamedSecurityInfoW` through koffi's synchronous stdio table. Windows propagates the inheritable capability ACE through the whole tree inside that call; the workspace held about 167k directories (four worktrees and a populated pnpm store) and the call blocked the event loop for over half an hour. Two application restarts reproduced it, because killing the Host mid-propagation leaves the directory without the matching Low label, so the next provision re-enters the propagation instead of taking the exact-entry skip.

Every other conversation shared that event loop, which is why four unrelated projects appeared to break together. Workspaces that had already been granted (the recurring ones) never reproduced it: their standing ACE made the call O(1). Only the first command in a freshly opened large workspace could trigger it, which is why the defect survived until a large new workspace appeared.

## Decision

Grant materialization moves into a helper child process, `packages/sandbox/sandbox-windows-acl/src/grant-runner.ts`, spawned by the seam through a new `./grant-runner` package entry resolved the same way the confinement `./runner` entry is (built `lib/` entry in production, package source through tsx in development). One invocation applies the standing workspace ACE, the harness-home denies, and the pair's revocable temp ACE; a `--revoke` mode removes one directory's capability ACEs for teardown.

The seam waits for the child at most `grantTimeoutMs` (new config, default 120000) and never kills it. An expired or aborted wait abandons the child: the ACEs land in the background and the current command fails with `SANDBOX_UNAVAILABLE` naming the workspace and the continuing preparation. The next command in that session reuses the landed grant through the existing exact-entry skip, so a timed-out wait costs one retry and no repeated propagation. The child is spawned outside this process's job object and `unref`ed, so a Host exit no longer aborts a propagation mid-way — the state that made restarts reproduce the freeze.

## Alternatives considered

**Keep the grant in-process and add an abort/timeout.** Rejected: koffi calls are not cancellable, so a timeout cannot interrupt `SetNamedSecurityInfoW`; the only lever would be killing the Host.

**Run the grant on a worker thread.** Rejected: the same synchronous FFI would run there, but a worker holds a process-wide security-descriptor edit behind its own teardown, and the failure mode after a timeout stays indistinguishable from a half-applied grant. A child process gives the kernel a clean abandonment boundary and matches the package's existing helper-process shape for `./runner`.

**Pre-grant workspaces when they are opened.** Rejected as the fix: it moves the same blocking work earlier, and a workspace opened while another conversation is answering would still freeze that conversation. It remains a reasonable later optimization on top of this change, because the grant would then happen off the critical path already.

**Gate on workspace size and warn instead of running the grant.** Rejected: the grant is required for confinement, and refusing large workspaces removes the sandbox exactly where it matters most.

## Consequences

The Host's event loop never performs security-descriptor work, so an in-progress grant cannot stall unrelated conversations. The tradeoff is one short-lived Node process per session/workspace pair's first confined command and one per temp teardown; both do the same Win32 calls the Host used to do.

A timed-out grant now reports a retryable error instead of hanging. Operators who prefer to wait can raise `grantTimeoutMs`; lowering it makes preparation failures arrive sooner while the background child finishes.

`AclWriteGrant` stays exported and in-process for callers that own their thread (the `./runner` child still manages its own DACLs when the seam passes no SIDs). The seam no longer holds FFI handles: `tempCapabilities` memoizes promises, and `tempRecords` holds the plain `{ dir, writeSid }` pairs teardown revokes.

## Testing

`packages/sandbox/sandbox-local/tests/acl-grants.spec.ts` drives the provider against a fake grant runner on any platform and pins the spawn argv contract, one memo per session/workspace pair, failure recovery (the rejected memo drops and the retry respawns), the fast timeout with the abandoned child still recording its work, the event loop staying responsive during that wait, and teardown revoking each temp capability before removing its directory.

`packages/sandbox/sandbox-windows-acl/tests/grant-runner.spec.ts` runs the real Win32 path on Windows: grant mode's standing ACE and Low label, idempotent re-grant, the harness-home deny, the paired temp capability, revoke removing the capability and clearing the label, and every malformed input failing with `windows-acl-grant: ` and exit 127.

The provider's own suite (`packages/sandbox/sandbox-local/tests/local.spec.ts`) is excluded on Windows by the root vitest config, so its grant coverage runs on the Linux lane where the package's other rungs do.
