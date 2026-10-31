# prism-about

English | [中文](README.zh.md)

A DeepSeek Harness plugin bundle that adds the desktop app's **About settings
section**: the running version, the in-app updater (update source fixed to this
repository's GitHub Releases), and the project links.

It is an out-of-tree bundle in the shape of a published plugin
(`dsh.bundle.patch` + a `dsh.client` browser half), not a change to the
Harness checkout.

## What it shows

- Brand block: app name, tagline, version capsule, and the check-update button
  (checking / up to date / update now / retry states).
- Progress area: download percent (indeterminate while the server sends no
  content length), installing, and installed-needs-restart lines.
- Update source card: the GitHub Releases badge and the serving repository,
  parsed from the shell's configured updater endpoint.
- Links row: release notes (the Releases page) and feedback (GitHub issues).

## What it does not do

No Host service, tool, RPC surface, or storage. The section reads only the
shell-injected update carrier (`globalThis.dshDesktop` with
`protocolVersion: 1`, injected at bundle time by the desktop shell) and never
selects artifacts or authorizes installation — the shell owns both. Outside
the desktop shell it degrades to one static line.

The update source is fixed: the shell's updater endpoint is
`https://github.com/laochenfei233/prism-agent/releases/latest/download/latest.json`,
and there is no custom-source override. Until the first release carrying
updater artifacts is published, checks fail with the source-unreachable state.

## Layout

```
src/index.ts
src/client/index.tsx
src/client/AboutSection.tsx
src/client/about-bridge.ts
src/client/locales.ts
src/client/styles.ts
src/client/externals.d.ts
tests/
```

## Build

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## Install into a profile

The desktop shell copies every `plugins/` directory that has a
`dsh.bundle.patch` into the profile on first launch and selects it as a bundle
layer, so the bundled app ships this plugin with no configuration. For other
profiles:

```sh
dsh plugin --profile web add prism-about
```

Restart the service after installing.
