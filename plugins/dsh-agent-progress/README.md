# dsh-agent-progress

English | [中文](README.zh.md)

A DeepSeek Harness plugin bundle that adds an **Agent work-progress panel**: a
sidebar entry at the viewport foot and a native overlay page listing every
session with what each agent is doing.

It is an out-of-tree bundle in the shape of a published plugin
(`dsh.bundle.patch` + a `dsh.client` browser half), not a change to the
Harness checkout.

## What it shows

One row per session, most relevant first (running, then most recently active):

| Column | Source |
|---|---|
| running / idle | the session list row's running flag, with the session-status snapshot as the live fallback |
| title, workspace basename, last activity | session list rows |
| `3/7 待办` plus a progress bar and the `in_progress` line | the Host-computed `todos` projection value |
| goal chip | the `goal` projection value |
| plan-mode chip | the `plan` projection value |
| waiting / new-result chips | the session-status snapshot (`pendingInteraction`, `completionUnread`) |
| approval strip | the `pendingInteraction` value when it is an approval: the requester's one-line text plus Reject and Allow once |

The header summarises running sessions and open todos. Clicking a row opens
that session through `ctx.uiWorkspace.openSession` and closes the panel.

A session waiting on an **approval** also carries a strip under its row: the
request's own text (the requester's localized copy when it supplies one, else
its audit reason) and the two decisions. The strip renders beside the row
rather than inside it, because the row is itself a button and a decision nested
in a button is not a control a browser can activate. Answering there settles
the same request the conversation's approval card shows, and both disappear
together. The panel reads the value structurally — `kind`, the text fields, and
an `answer` callback — so it needs no import from the package that publishes
it and no Host surface of its own.

## What it does not do

No Host service, tool, RPC surface, or storage. Every fact it renders already
reaches the browser for the shipped UI, so the panel works against any
assembled Host that provides the baseline client services (`slots`, `locale`,
`sessions`, `uiWorkspace`) and degrades to rows-only when a projection is
absent.

## Layout

```
src/index.ts             Host half: a Loader-loadable no-op plugin
src/client/index.tsx     registrations: sidebar.footer.action + shell.overlay
src/client/progress.ts   pure derivation from list + status snapshots
src/client/locales.ts    zh / en dictionaries
src/client/styles.ts     panel stylesheet (rendered in a <style> element)
src/client/externals.d.ts  local stand-ins for the two baseline modules used
```

## Build

```sh
# from this directory, using the checkout's own tsdown
../../node_modules/.bin/tsdown --config tsdown.config.ts
```

Artifacts: `lib/index.js` (Node half) and `lib/client.js` (browser half). The
browser half is a CJS closure registered through
`window.__ModuleLoader__.load({ id, factory })`; `react`, `react/jsx-runtime`,
and `@deepseek-ai/dsh-client-store` stay external and resolve through the
shell's module table, so nothing is duplicated into the page.

Typecheck: `node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`
(needs `@types/react`, declared in `devDependencies`).

Smoke test — loads `lib/client.js` through a `window.__ModuleLoader__` stub with
the baseline modules injected, drives `apply` with a recording context, and
renders the panel against a synthetic three-session list:

```sh
node scripts/smoke.mjs
# smoke: ok — 2 registrations, panel renders, closed panel is null, nav counts 1 running session
```

## Install into a profile

```sh
dsh plugin --profile web add -w <absolute path to this directory>
```

Then restart the Harness process: client modules are scanned only at startup,
so a freshly installed bundle is not served until the process restarts.

Verify before/after the restart:

```sh
curl -s http://127.0.0.1:3080/ | grep -c 'dsh-agent-progress'          # > 0 once composed
curl -s -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:3080/plugins/dsh-agent-progress/client.js         # 200 once served
```

After a reload the sidebar foot shows the progress entry; it carries a green
count badge while any session is running.
