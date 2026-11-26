# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.3-alpha.2] - 2026-11-26

Hotfix on top of 0.2.3: the desktop shell's trust fence no longer blocks its own first navigation, the runtime stops cleanly before an in-app update installs, and a stale package export is dropped.

### Fixed

- Make the merged tree pass the release gates
- Point the release bundle patches at the resynced package homes
- Cut the Tauri app version to 0.2.3 with the family
- In-app updates now finish installing on Windows: the download no longer stalls at 100% because the shell stops its local runtime the same way the quit path does before handing over to the installer.
- The app window no longer gets stuck on a 'forbidden' page at first launch: the trust fence now lets the shell's own tauri:// navigation through.
- Fixes carried over from another checkout: the guardrails runtime mount, the team bundle in the web composition, and the release gates they need; a stale package export without a build output is dropped.

## [0.2.3] - 2026-11-25

The first stable release: phone access now needs explicit approval with single-use sign-in links, the feishu/dingtalk/wecom bot channels delegate to the upstream connectors, speech recognition gains nine HTTP providers with long-audio splitting, and memory runs on autopilot with auditable claims.

### Highlights

- Add nine request forms to the HTTP ASR provider
- Delegate feishu/dingtalk/wecom to the upstream connectors
- The phone QR now opens an access-request page instead of embedding a login link: compare the code with the one shown under Settings → Pocket, allow the phone there, and it signs in once with a single-use link.

### Added

- **Breaking:** Prism memory runs on autopilot: claims stated in your own words save live immediately, inferences park until a second conversation corroborates them, contradictions settle by recency with rollback, and an optional per-turn model read captures what the form matcher misses
- Add durable minutes service and tools
- Package an installable dsh bundle
- Add the LLM-maintained knowledge vault package, its bundle mirror, and the ownership note
- Carry the stored page through the Web conflict envelope
- Plugin — remote status, web push, mobile adapter, settings
- Add secondary-press menus across the client surfaces
- Archive configuration, memory, and project folders to WebDAV, SMB, or S3
- Add the transfer package with a CRC-verified zip reader (T1)
- Export engine over the shared session exporter plus the settings transfer applier (T2, T4)
- Import engine with single-flight job store (T3)
- Host routes for export, import, job poll, and settings application (T5)
- Client transfer section, nav icon, and web-app composition row (T5, T6)
- Custom-theme inputs, hex validation, and token synthesis
- Paper, blueprint, phosphor, sumi, and sage palettes with custom boot passthrough
- Synthesize the custom theme in the runtime with a setCustom write face
- The Appearance section with the custom-theme group and its own nav glyph
- One distinct preview motif per theme, textures riding the gallery entries
- Save, apply, and delete named custom-theme presets
- Mirror customPresets in the host Config with regenerated catalogs
- Regroup the settings entry surfaces
- Scaffold the dual-face plugin and the Models-page footer card
- Pin the four-family catalog and add the durable registry
- Verified downloads and the install lifecycle
- Runtime provisioning and the BGE embedding engine
- The RapidOCR engine behind the default OCR capability
- The PaddleOCR sidecar on the pip-provisioned venv
- HY-MT1.5 translation over the provisioned llama.cpp
- Card selection state and pure presentation helpers
- Bilingual README and the as-built BGE engine wiring
- Command palette, region cycling, tree navigation, approval arrows
- Composer focus command and behavior specs
- Add a native Git workbench tab
- Give a person their own read and write surface
- Auto-archive idle conversations on a schedule
- Sensitive-read denial, command guard, and a /guardrails report
- Answer a pending approval from its Session row
- Refresh the brand copy and drop the hero preview badge
- Retire the dsh-tauri local bundle
- Add an observe mode and a decision ledger
- Finish the Git workbench tests and gates
- Add a keyless 18-engine web search provider
- Answer a pending approval from the panel
- Restore the approval line in the session row
- Offer the approval placement in General settings
- A pending approval now shows in the conversation list and in the Progress panel. A new choice — in the panel header and in Settings → General — decides where you answer it, the panel by default; the other place still shows what is being asked with a hint naming the one that answers.
- The Pocket page now carries nine chat-bot channels — Telegram, Discord, Slack, 飞书/Lark, DingTalk, QQ connect outbound with no public IP; 微信, 企业微信, and WhatsApp receive through signed callback routes the page walks you through exposing. A bot drives one bound session: its messages run the agent, replies return to the chat, and pending approvals or questions arrive as numbered choices you answer by reply. The page itself gained a scannable QR for the phone link, per-channel cards with live status and a credential probe, and the same settings material as the app's own pages — it previously rendered unstyled on desktop.
- Add prism-team and the compose mode
- Add the session-header team panel
- Make the local network the default remote route
- Open side conversations in the right Sidebar
- Carry plugin rows in the assistant message context menu
- Export a project from its context menu
- The Pocket page now exposes this workspace three ways. It starts on the local network: it finds the machine's private IPv4 address (192.168 first), and a server bound to it gives the phone a direct `http://192.168.x.y:port` link with no trust entry, since the fence already admits the listener's own bind address. When the server listens on loopback only, the page says so and prints the `prism web --host <address> --port <port>` step instead of a link; the desktop app always starts on loopback. Tailscale and a stable Cloudflare tunnel hostname remain one click away as fallbacks: the page reports both probes, prints the steps they need, and measures an advertised address before calling it ready. The choice is stored in the DSH home's `pocket/remote.json` and survives restarts. The plugin still starts no daemon and changes no trust policy.
- A session now shows its estimated cost in the conversation header; opening it reveals the priced token buckets, the built-in DeepSeek rate table with the peak-hour multiple, and an editor for custom per-model prices. A model with no price reads "No price yet" and opens the same editor. Completed turns also show their own cost beside the token total, and both figures follow custom prices you save.
- Session rows now carry their own filing marks: favorite, review-later, a 1–5 priority, up to 20 tags, and a note, all set from the row menu's new entries or the Tags & note… dialog. The marks show in the row, View options can filter the list and search to favorites or review-later and order by priority, and search matches tag and note text. The dialog's Copy prompt and Import move an annotation through the clipboard without calling a model. A batch mode entered from the header's checklist button puts a checkbox on every row and runs archive, unarchive, favorite, unfavorite, review-later, priority, or clear-tags over the selection, then reports how many succeeded and failed. Annotations stay in this browser, and a Session still cannot be moved to another Workspace, because its working directory lives in the immutable Session header that decides Workspace membership.
- Classify auxiliary memory extraction with a purpose of its own
- Add the Web meetings page with speech preparation and in-page answers
- Offer the DashScope online recognizer beside SenseVoice
- Register config-driven third-party HTTP ASR providers
- The web listener's request-header byte bound is configurable as `maxRequestHeaderBytes` in the `dsh-host-webserver` config, defaulting to 64 KiB with a 1 KiB minimum, instead of a fixed constant.
- Port the microcompact guard into the new prism-guardrails plugin
- Bridge subagent delegations into the job registry
- Give prism-memory cited-source verification, claim comparison, digest parent lineage, and a mirror audit
- Bridge the HachimoDock desktop terminal to prism sessions
- Give prism-memory an opt-in model-assisted distillation window and a `/memory bootstrap` pass over past sessions

  With `assistedDistill` on, the turn-stopping path keeps a rolling buffer of recent turns and, every `assistedDistillEveryTurns` turns, asks the deployment's own model to propose the durable claims the form-recognizing reader cannot see. Every candidate is written `pending` — the model proposes, a person promotes — and one that names its source message is cited with the same fingerprint `/memory verify` re-reads. `/memory bootstrap apply` closes a fresh install's cold start: it distills past sessions of the calling working directory through the same protocol, once per session, skipping sessions a completed pass already processed, and fails loud when the session-query engine, the llm service, or a routed model is missing.
- Give prism-guardrails a stuck-nudge rail that reminds instead of enforcing

  When one turn piles up `stuckNudgeAfterFailures` consecutive failed calls (3 by default), a one-shot judge call through the agent's own provider route decides whether the failures are one loop. A confident yes attaches a reminder to the failing call's accepted result — change the approach, or say plainly that you are stuck and stop — and the call itself is never refused. Any success clears the run, a new turn starts fresh, `stuckNudgePerTurn` bounds the reminders, and the rail ships on because it refuses nothing: `stuckNudgeAfterFailures: 0` turns it off. `/guardrails` lists the rail and records each reminder as a `steer`.
- The config-driven HTTP speech provider can speak the audio-bearing chat-completions request form (mode: `chat-completions`) beside the OpenAI multipart transcription form, so chat-completions ASR endpoints such as MiMo-V2.5-ASR join voice input and the meetings page by configuration alone; recognition reads the answer's `choices[0].message.content`.
- Split long imports past a recognizer's declared cap at quiet boundaries
- Ship DeepSeek ASR and DashScope qwen3-asr as built-in recognizers
- Add a speech recognition settings section
- Seat speech and local models as Models-page tabs
- Keep the LAN listener reachable through the installer
- Check updates from the domestic mirror first
- Ship the prism-wiki knowledge vault and unify the @prism scope
- Bind the web GUI on the machine's LAN addresses with `dsh --profile web --bind-lan`
- Auto-archive idle conversations and projects
- The memory hygiene pass now also runs on a wall clock: every `scheduledMaintainMinutes` (default 360) and once shortly after load, the plugin applies expiry archiving, near-duplicate merging, and capacity eviction with no turn and no operator command, so a quiet workspace stays tidy. `scheduledMaintain: false` keeps tidying on the turn path and operator command alone.
- The memory page can now rewrite a claim and retire one. An edit supersedes the old wording and inherits the record's layer, class, scope, and tags, so the supersede chain keeps the old wording readable and `/memory restore` rolls an edit back; retirement takes the same path as `/memory forget`. Project- and conversation-scoped claims stay under their session's authority: the page lists them, and the new routes refuse them.
- Ship the archived-projects settings section, opt-in defaults, and the default-Workspace exemption
- Auto-answer approvals under the autonomous-guarded preset
- Bind one more local address at runtime (T1)
- Bind the LAN address from the settings page (T2)
- Offer the LAN bind action on the settings page (T3)
- Turn a dropped folder into an independent project
- Add a model-free microcompact pass that clears stale tool results before summarization compaction
- Conversations from ZCode can now be imported from the Settings import page, alongside the existing coding agents.
- Render contributed source cards ahead of the built-in stores
- Move the import entry to the import page's first source card
- Add the usage-reminder rail (usageReminderThresholds)
- Add the wait-time reminder rail (waitReminderAfterMs)
- Port the team bundle to the subagent-tree Team architecture

### Changed

- **Breaking:** The memory plugin's model-assisted distillation now admits each candidate through the same source trust tiers as the form distiller, keyed by the speaker of the message the candidate cites: a claim grounded in the person's own message can land active on the shipped defaults, while one grounded in the assistant's account parks until corroborated. The `assistedDistillConfidence` key is removed, and the per-turn `llmDistill` channel that existed only on an unreleased branch is retired in favor of the assisted window, whose call keeps the `memory-distill` purpose stamp for cost attribution.
- Converge settings-entry-regroup with appearance-themes
- Revert: Drop the approval line from the session row
- The local-model card on the Models settings page now matches the page around it: one settings card per model family with a lifecycle dot, a real variant selector, a download progress bar, and a confirmation dialog instead of the browser's own.
- Revert: Drop the upstream release watch in favor of manual resync
- The desktop installer is rebuilt on Tauri 2.12.6 with a re-synced NSIS template: upgrades keep offering the in-place upgrade first, downgrades are now also blocked in passive and update installs, and a successful upgrade uninstall no longer leaves the old uninstaller behind.
- The harness core, packages, catalogs, and documentation are resynced to upstream deepseek-harness `0.2.3-alpha.2` as one content merge, with the Prism desktop shell, branding, CLI identity, and workflow exclusions re-applied on top.

### Removed

- **Breaking:** The Cron scheduling stack is gone: the `cron_*` model tools, the `ctx.cron` and `ctx.remote.cron` APIs, the Session-header Cron panel, and the Cron overlay no longer exist. Scheduled tasks live in one place now, the Automation tasks page and the `schedule_*` tools, which already accept five-field cron timing in an explicit zone; recreate any Cron task there. Stored Cron records stay on disk and are no longer read.

### Fixed

- Recheck cancellation before commits
- Make the bundle patch upsertable
- Correct quoted list values, schema delivery, and the review findings
- Make concurrent writers safe and correct the claim
- Keep one malformed page from breaking every vault-wide operation
- Carry the stored page in a revision conflict
- Harden the vault walk and keep the conflict code when the stored page is unparsable
- WebServer service name, drawer anchor, subscription hardening
- Review findings — failure cards, fence-true trust badge, backdrop, zh README
- Review round 2 — error-card detail drops the session id; peer-declare the session-controller types
- Fill the Windows app icon slot
- Keep context menus out of layout and the draft usable
- Resolve review findings across wiring, transports, and the page
- Close the second review pass
- Refuse a credentialed endpoint and document why
- Close stale composer menus and close review gaps
- Update ThemeSnapshot consumers for the custom theme inputs
- Literal custom Config keys, regenerated catalogs, and review copy fixes
- Update ThemeSnapshot consumers for the customPresets field
- Review fixes — schema name pattern, safe aria params, IME guard, coverage tests
- Apply review findings to the settings entry regroup
- Clear the real lint gate on the presets change
- Narrow the tolerant reader colors for the strict aggregate check
- Cover the missing-color junk branch in the tolerant reader
- Review pass — wire projection checkpoints, mid-stream size caps, ADS and ancestor guards, skip-count surfacing, download handoff
- Label provisioned variants instead of a byte floor
- Review round — provisioning pre-check, placement scan, override validation
- Row controls keep their keys; palette spec
- Fence tool writes under the harness home
- Validate foreign events before a native import
- Enforce admission limits on image reads
- Sign updater artifacts in CI
- Authenticate every HTML entry
- Refuse cmd metacharacters in the popup fallback
- Close the review findings on the security-audit fixes
- Inline the reader validation and scope its claim
- Move the palette Web default off Mod+Alt+P
- Exclude the harness home from every shell profile
- Republish copied attachments read-only
- Leave latest.json to tauri-action
- Carry the home denial to the standalone runner
- Close the review findings on the operator surface
- Cap the search the way the service caps it, and state the review order
- Narrow the shipped credential segments, wait for the commands service, and correct the docs
- Read the volatile config through its references
- Keep the pending approval line inside its own row
- Tighten the observe report and record the README pair
- Resolve the provider through ctx.get and fetch pages through the web seam
- Resolve engine wrappers before reading pages through the fetch seam
- Close the Git workbench review findings
- Drop the unused path-validation parameters
- The desktop window no longer shows a scrollbar beside the interface at any window size.
- After a Prism Agent desktop upgrade the plugin page no longer marks app-provided plugins as "Problem": the copies seeded into the profile now follow the installation's manifest and build, so a bundled plugin such as prism-meeting, aegis, or prism-memory loads again once the installation ships a compatible build. The bundled plugins prism-pocket, prism-local-models, and prism-session-autoarchive now ship with their built `lib/`. When the app provides a plugin's files, the incompatibility hint now says to update and restart the app instead of uninstall and reinstall.
- Keep a loadable plugin copy through the swap
- A first sandboxed command in a large Windows workspace no longer freezes every conversation: the workspace's ACL preparation runs in a background helper, the interface stays responsive, and a preparation that takes longer than two minutes reports a retryable error instead of hanging.
- Ship the windows-acl entry chunks under the published glob
- Include the RestartManager macros the NSIS template calls
- Review round — merge saves, guard relay sends, re-mint stream URLs
- Follow-ups — Telegram is_bot filter, QQ reconnect token refresh
- Refresh the generated catalog entry for the widened writeHead, and assert the TLS prune is Secure
- Heal the cookie accumulation that wedged desktop web authentication
- Compare worktree paths against task write scopes
- Show the tunnel steps and trust flag before a hostname is stored
- Draw the cost-dashboard controls on hairline borders
- Keep the cost editor reachable for unpriced models
- Attach the side conversation to its Workspace and frame open failures
- Answer the review on annotations and batch actions
- End batch mode on a query by gesture, and tighten annotation edges
- Keep the provisional New Session row out of batch selection
- Close the review findings on the autopilot gates
- Pocket bot bindings now record the operator's sender identity, so a group member or a stranger in another chat can no longer rebind with `/new`, drive the session, or approve tool executions from the bound chat. A channel never claims a binding on its first message either: the Pocket page shows a pairing code beside the QR (copyable, rotatable in one click) and `/start <code>` from your chat binds the bot; the code rotates on every successful pairing. `/new` still rebinds — but only for the operator, whose sender identity also recovers the session from any other chat. The callback-signing tokens (WeCom/WeChat token, WhatsApp verify token) are now masked in the list route like the other secrets, callback signature checks compare in constant time, and replayed callback messages are deduplicated before any handling. The QR caption now notes that the scan is a login link and should not be shared or screenshotted.
- Delete stale cookies in both Secure variants
- Retire the dsh-agent-progress local bundle
- The session-header cost pill now prices its billing tier at the latest logged settlement instant instead of the render-time wall clock, so the same session log always renders the same estimate. The token-usage projection carries that instant as `lastSettledAt`.
- After a switch from an HTTPS listener back to plain HTTP, the stale Secure session cookie an earlier authority left behind is deleted again: mint responses now expire every stale session-cookie name with both secure variants of the deletion Set-Cookie, because a non-secure Set-Cookie cannot delete a Secure-only cookie (RFC 6265bis). Previously that cookie survived the prune and could push the browser's Cookie header back past the listener's request-header bound, wedging the launch-token exchange.
- Store the live transcript at the end and add a recognizer selector
- Repair the merged speech layout for the rc.4 aggregate
- Drop stray in-tree declaration emissions from the repair commit
- Land the meeting line against the rc.4 aggregate
- Restore the promoted speech packages the base bundle depends on
- Reconcile the lockfile with the restored speech packages
- Restore the authenticate_webview command the rc.4 lib.rs registers
- Consolidate the speech seam on the experimental packages
- Inject the WebKit session through a loopback proxy
- Complete lifecycle payload ripple and host aggregate wiring
- Close review findings — generated catalogs, product classification, ledger hygiene
- Reconcile the fork surfaces with the merged 0.2.2-rc.1 tree
- Review fixes — hub teardown, host-context reads, raw wire checks
- Restore the 0.2.2 composition seams the fork suites exercise
- Converge the merged menu architecture and close the A12 file-row gap
- Drop the retired inline menu seat from the browser contracts
- Close the review findings on the assisted distillation paths
- Tokenize the JSON-escaped cwd spelling and pin the refresh pass to the real cwd
- Close the review findings on the stuck-nudge rail
- Move the desktop shell's hub off the shared 3081 port

  Sibling dsh-fork desktop shells share the upstream 3081 default, so whichever
  product boots second loses the port and lands on a fallback port every launch.
  The port is part of the browser session's cookie authority, and each move
  invalidated every existing session cookie into the
  "authentication required; reopen the URL printed by dsh web" page. The shell
  now defaults to the private port 38081; the scan fallback and the README port
  contract move with it.
- Authenticate the desktop window through a loopback proxy

  The desktop window used to authenticate with the webview's own cookie jar.
  Inside the frame that jar is a third-party store, and because cookies ignore
  ports, a session minted for an earlier loopback port survived every port change
  and left the window on the "authentication required" page with no way to
  recover short of clearing the store by hand. The window now loads a loopback
  proxy that attaches the signed session to every request and WebSocket
  handshake and rewrites Host, Origin, and Referer; the webview's cookie jar is
  no longer involved. The proxy keeps its port for the app's lifetime, so a
  restarted server only replaces the session behind an origin that never changes.
- Reopen the hidden window on macOS activation
- Seed the web profile before the desktop's first boot

  A fresh Prism home has no `profiles/web/package.json` — the CLI writes it on
  its first `dsh web` boot, and the shell seeded its bundled bundle layers before
  that boot. The merge failed with ENOENT, `spawn_child` returned before spawning
  anything, and the window stayed on "starting local service" with no hub to
  connect to. Seeding now asks the installed CLI's own `initProfile` for the web
  template (manifest, patch layer, pnpm settings) when the manifest is missing,
  then merges the bundled layers into it as before.
- Read the host connection through ctx.get in the hachimodock bridge

  The hachimodock plugin used to read the host `connection` service with
  `Reflect.get(ctx, 'connection')`. The resynced cordis context proxy rejects
  undeclared property access, so every activation failed with "cannot get
  property \"connection\" without inject" and the desktop-side bridge entry
  never came up after the 0.2.2-rc.1 update. The plugin now reads the service
  through `ctx.get`, which needs no inject declaration and returns `undefined`
  when the service is absent, so the activation stream stays optional exactly
  as the surrounding guard intends.
- Read host services through ctx.get in prism-pocket and prism-local-models

  Both plugins still read host services with `Reflect.get(ctx, name)`. The
  resynced cordis context proxy rejects undeclared property access, so those
  reads fail with "cannot get property ... without inject" the moment they run
  in a fiber context — the same failure that broke the hachimodock bridge
  entry after the 0.2.2-rc.1 update. All reads now go through `ctx.get`, which
  needs no inject declaration and returns `undefined` when the service is
  absent; the guards around the required services keep their localized errors.
  pocket's tsconfig maps cordis to the built vendor types like prism-hachimodock
  already does, and local-models widens its pinned cordis declaration with
  `ctx.get` beside the existing `ctx.provide` widening.
- Defer unparseable audio to the provider and declare caps in test rosters
- Correct the TC3 canonical form and close review findings
- Map feishu secrets and run the watch step with pipefail
- Keep the service list live so settings can edit it
- Cite dropped folders through the WebView2 File.path fallback
- Open a claimed link only through its own route
- Withhold the LAN address while the listener is bound elsewhere
- Lock the mirror host on the update wire and refresh stale docs
- Let the shell's own drawer present while it is open
- The phone settings pages keep their facts and their buttons
- Align the test fixtures with the resynced agent and client APIs
- Pass the package directory to clientBundle
- The approval buttons in a Session row stay inside the sidebar, and answering from the row no longer also opens that Session.
- The Meetings page loads its records again

  The shipped base composition mounted the meeting service and its model-facing tools, and the client module roster therefore also served the Meetings page. Its browser routes came only from the separately installed plugin bundle, so every request from the page answered a plain-text 404 and the page showed the browser's JSON parser message, "The string did not match the expected pattern." The base bundle now composes the page's browser routes beside the service row, and an answer that carries no JSON envelope is reported by its HTTP status.
- Clear every tool when schemastery empties the tools list
- Resolve runtime native deps for the bundle target arch
- Refresh the generated slot catalog and lockfile
- Cover shell reads in the sensitive-read rail
- Stop a bot adapter whose start failed
- Honor supersedes on identical claims and count corroboration per conversation
- Carry ASR credentials in handshake headers, not URLs
- Parse the serialization before writing a page
- Read callback XML fields with a linear scan
- Read engine and fetched pages with a linear scanner

### For contributors

- The guardrails bundle gains an observe mode: every rail still decides, but a `deny` or `ask` is recorded instead of applied, so a deployment can read a rail's reach before arming it. `/guardrails` now leads with the mode and the configuration hash a decision was made under, and lists the calls the observing run would have stopped.

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
