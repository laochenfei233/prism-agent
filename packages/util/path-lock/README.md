---
description: "Cross-process exclusive kernel lock on one filesystem path, released by the kernel when the holder's process ends — for capabilities that must serialize writers across processes."
kind: "package-library"
---

# @deepseek-ai/dsh-util-path-lock

English | [中文](README.zh.md)

## Summary

Use `PathLock` when two processes must exclude each other over one path and the filesystem is the only shared state they trust. The lock is held by the kernel rather than by a file's contents: POSIX takes a non-blocking `flock(2)`, and Windows holds a named kernel semaphore derived from the path. A holder that crashes releases the lock, so no expiry or stale-lock recovery exists. Contention is reported as `PathLockedError`. This library registers no plugin, event, or service.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Acquire a lock around the read-modify-write cycle that must not interleave with another process, and release it in a `finally`:

```ts ignore-check
import { PathLock, PathLockedError } from '@deepseek-ai/dsh-util-path-lock'

declare const lockPath: string

let lock: PathLock | undefined
try {
  lock = await PathLock.acquire(lockPath)
} catch (error: unknown) {
  if (error instanceof PathLockedError) return
  throw error
}
try {
  // exclusive work here
} finally {
  await lock.release()
}
```

`acquire` creates the lock path when it is absent; its parent directory must already exist, so the caller owns provisioning the directory and its permissions. `PathLockedError` means a live holder owns the path and says nothing about how long it will hold it. `release` is idempotent.

### Two locks, two problems

This package locks a path. [`dsh-atomic-write`](../atomic-write/README.md) locks a file it also replaces, and backs off with a deadline where a contender eventually fails. Choose this package when the lock must outlive a single replacement cycle, when a crashed holder must not block a successor, or when a contender should be told "held" immediately rather than after waiting.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `PathLock`, `PathLockedError`, and the Win32 semaphore binding — the package's whole surface |
| — | No invariant companion is published; the package owns no event stream or mutable runtime data, and its exclusion contract is enforced by unit tests plus the session backend's two-process end-to-end coverage. |

### The kernel is the arbiter

Holding a lock means holding an open descriptor or handle, never holding a file's contents. That choice is what makes crash release free: the kernel drops the lock when the process ends, so a successor never has to distinguish a crashed holder from a live one.

A POSIX lock names an inode rather than a path, so after locking, the holder verifies that the locked inode is still the file at the lock path and retries otherwise. An unlinked-and-recreated lock file carries a fresh inode, and a lock on the orphaned one would prove nothing. Windows holds a count-1 semaphore in the login-session namespace, whose name is the SHA-256 of the case-folded resolved path, so the lock leaves no filesystem footprint there.

</details>

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the package is not the right tool. They are current package constraints, not a task backlog.

- **No expiry, so a wedged holder blocks its successors** — a live but stalled holder keeps the lock until its process exits. Expiry would admit a second writer whose writes interleave with the stalled one, so recovery is an operator action.
- **Removing a live holder's lock file forfeits exclusion on POSIX** — the lock names an inode, and the surviving file is what later lockers verify against. Nothing in the harness removes it.
- **The caller owns the directory and its permissions** — `acquire` creates the lock file but not its parent, and it never changes an existing directory's mode.
- **Locking is not a transaction** — the package orders writers over a path; it does not make the work inside the lock durable, atomic, or recoverable.
- **Same-process reuse is excluded too** — the kernel arbitrates descriptors, so a second acquisition anywhere, including in the same process, reports contention rather than reentering.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
