---
feature: upstream-watch
status: in-progress
updated: 2026-11-17
branch: feat/upstream-watch (worktree .worktrees/upstream-watch)
commits: eac9d844da (github/master)..delivery
---

# Upstream dsh release watch

English | [中文](upstream-watch.zh.md)

## [S1] Problem

This fork reconciles upstream `deepseek-ai/deepseek-harness` ("dsh") through resync anchor tags ([upstream-resync-0.2.2-rc.1.md](upstream-resync-0.2.2-rc.1.md)); there is no merge, so a new upstream release surfaces only when someone notices it by hand. Between the 0.2.2-rc.1 resync landing on 2026-11-13 and 2026-11-17, upstream published `dsh-v0.2.2-rc.2` and `dsh-v0.2.2-rc.3` undetected. The fork needs a periodic check that notifies the maintainer through a Feishu group bot webhook when upstream publishes a new release.

## [S2] Design

### S2.1 — Workflow shape and trigger

`.github/workflows/upstream-watch.yml` runs one job, `watch`, on `ubuntu-latest`. It triggers on a daily `schedule` (`cron: "17 3 * * *"`, UTC — GitHub-hosted schedules run late by minutes to hours, tolerable for a daily notifier) and on `workflow_dispatch` for manual runs; `concurrency` group `upstream-watch` with `cancel-in-progress: false` serializes overlapping runs. This is the ZedG cron-check-act pattern ([ZedG 01-translate.yml](https://github.com/WenYin-Community/ZedG/blob/main/.github/workflows/01-translate.yml)) reduced to notification only, styled after the fork's existing `desktop-release.yml`.

### S2.2 — Detection against a committed seen-state

The state is `.github/dsh-upstream-seen.json`: a JSON array of upstream release tag names already notified, newest first. Detection fetches every upstream release (`gh api --paginate repos/deepseek-ai/deepseek-harness/releases`, env `UPSTREAM_REPO` at the workflow top) and reports the tags missing from the state, keeping the upstream list order. It is a set difference with no semver comparison anywhere, because upstream interleaves lines (0.2.1-rc.5 sits between 0.2.2-alpha.2 and alpha.3). The upstream repository is public, so the workflow's `GITHUB_TOKEN` authorizes the reads.

### S2.3 — Feishu notification

The notification is one POST to the Feishu custom-bot webhook stored in the repository secret `FEISHU_WEBHOOK_URL`, as a `msg_type: text` message in Chinese listing every new tag and the upstream releases URL. When the optional secret `FEISHU_WEBHOOK_SECRET` is set, the request carries the Feishu custom-bot signature: `timestamp` in seconds, `string_to_sign = "<timestamp>\n<secret>"`, HMAC-SHA256 computed over `string_to_sign` with the secret as key, base64-encoded, both fields embedded in the body; without the secret the body stays unsigned. A response whose `code` (or legacy `StatusCode`) is not `0` counts as a send failure.

### S2.4 — State update ordering

The state is written only after a successful send: the new tags are prepended to the seen array, and the file is committed to `master` with `GITHUB_TOKEN` (`permissions: contents: write`, commit message `chore(ci): record upstream dsh release(s) <tags> as seen`). A send failure commits nothing, so the next run retries the notification. A push failure after a successful send fails the job and the next run re-notifies the same tags — a visible duplicate, accepted instead of silently losing the notification or the state.

### S2.5 — Seed and first run

The committed seed lists the 37 releases the fork has already reconciled through `dsh-v0.2.2-rc.1`, so the first run notifies exactly `dsh-v0.2.2-rc.2` and `dsh-v0.2.2-rc.3`. A run that finds zero new releases sends nothing and commits nothing.

### S2.6 — Failure behavior

A missing `FEISHU_WEBHOOK_URL` fails the job at run time (misconfiguration fails loud). Every network, API, webhook, or push failure fails the job; nothing is silently skipped. Setup after merge: add the two secrets to the GitHub repository, then run the workflow once via `workflow_dispatch`.

## Tasks

- [ ] T1: spec triplet (this document and its Chinese pairing plus the generated consistency record) (depends: none)
- [ ] T2: `.github/workflows/upstream-watch.yml` and the seeded `.github/dsh-upstream-seen.json` (depends: T1)
- [ ] T3: verification — detection dry-run against the live upstream API, workflow YAML parse, signature self-consistency, translation-pairing gate (depends: T2)

## [S4] Acceptance

- [ ] A1: the workflow triggers on the daily schedule and manual dispatch, and its concurrency group serializes overlapping runs.
- [ ] A2: executing the detection step locally with the committed seed against the live upstream API yields exactly `dsh-v0.2.2-rc.2` and `dsh-v0.2.2-rc.3`.
- [ ] A3: the notification body carries every new tag and the upstream releases URL, and a webhook failure or nonzero feishu error code fails the job before any state write.
- [ ] A4: a zero-new run performs no POST and no commit; after a successful notification the state file gains exactly the notified tags.
- [ ] A5: the request is signed per S2.3 when `FEISHU_WEBHOOK_SECRET` is set and unsigned when absent.
- [ ] A6: `verify-translation-pairing` passes for the spec triplet.
