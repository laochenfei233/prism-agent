# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1-rc.4] - 2026-10-31

Prism gains in-app updates with a new About page, imports conversations from ten coding agents, and installs under its own prism-agent identity with a dedicated data root.

### Highlights

- The desktop app now updates itself: the new About page shows the current version and lets you check for, download, and install updates in place.
- Existing conversations from ten coding agents - Claude Code, Codex, Grok, DeepSeek Harness, MiMo Code, OpenCode, OpenClaw, Hermes, Pi, and Gemini CLI - can now be imported into the session list, with titles visible right away.
- Prism installs under its own identity: the prism-agent command and a dedicated ~/.prism data root, isolated from any other DeepSeek Harness build on the machine.

### Added

- Launching the app while it is already running focuses the existing window instead of starting a second copy; instances left over from a previous install are closed first.
- DeepSeek Harness sessions keep their full fidelity on import: the original log is copied natively instead of converted to plain text.

### Changed

- The installed desktop app now runs as prism-agent.exe, and the installer no longer closes unrelated DeepSeek Harness processes.
- The runtime is synced to upstream DeepSeek Harness 0.2.1-rc.4, replaying the upstream changes from alpha.4 through rc.2 and rc.4.
- In the sidebar Last updated mode, project sections now rank by the newest activity of their sessions.

### Fixed

- The desktop shell now quits cleanly before an installer replaces it, instead of leaving a stale tray icon behind.
- The Windows app icon now fills its slot correctly in the window, taskbar, and installer.

### For contributors

- Desktop packaging no longer runs the pnpm-11-incompatible native rebuild step; the shipped closure relies on the prebuilt node-pty bindings.
