---
kind: upgrade-guide
description: "A Windows sandbox grant that outlives `grantTimeoutMs` now fails the command with SANDBOX_UNAVAILABLE instead of blocking every conversation."
---

# Windows sandbox preparation can no longer freeze the Host

English | [中文](guide.zh.md)

## Change

On Windows, the ACL write grant that prepares a workspace for `workspace-write` (one `SetNamedSecurityInfoW` inheritance propagation over the whole tree) previously ran on the Host's main thread. A first grant over a large workspace — a monorepo with worktrees or a populated `node_modules` — blocked the event loop for as long as the propagation took, and every conversation served by that Host stopped responding while tool calls, history loads, and the web UI waited behind it.

The grant now runs in a short-lived helper process (`@deepseek-ai/dsh-sandbox-windows-acl/grant-runner`), and the Host waits for it for at most `grantTimeoutMs` (new `sandbox-local` config key, default 120000). The Host stays responsive throughout. When the wait expires, the command fails with `SANDBOX_UNAVAILABLE` while the helper keeps working in the background; the next command in the same session reuses the ACLs it is materializing, because an already-standing exact ACE skips the propagation.

## Migration

1. Nothing is required: the defaults fix the freeze. Confined commands on Windows run unchanged.
2. Raise `grantTimeoutMs` in the `sandbox-local` config (for example `120000` → `600000`) only when a single first-time grant on your largest workspace legitimately needs longer and you would rather wait than see the command fail once.
3. Lower it when you would rather fail fast and let the background grant finish: the next command reuses the finished grant.
4. Confirm the fix: run a confined command in a large workspace and, while it prepares, load another conversation's history — it must respond. If the preparation exceeded the wait, the tool result names the workspace and says the preparation is still running; run the command again after it lands.
