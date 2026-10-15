---
feature: install-isolation
status: in-progress
updated: 2026-10-15
branch: feat/install-isolation
commits: pending (filled at delivery)
---

# Install Isolation

English | [中文](install-isolation.zh.md)

## Report

Finalized at delivery.

## [S1] Problem

Every build of the harness family shares one command surface: the CLI npm package is `@deepseek-ai/dsh`, its bin is `dsh`, and the default harness home is `~/.dsh` (`packages/util/home-paths/src/index.ts` resolves `$DSH_HOME`, then `~/.dsh`). A machine that runs this fork beside any other harness build — the official release, a self-built checkout of `deepseek-ai/deepseek-harness`, or this fork from source — mixes them: a global `npm i -g` of one build replaces the other's bin, and CLI runs from source read and write the same profiles, credentials, `.env`, plugin profiles, and session store. The desktop point of the fork is already separated (Tauri product "Prism Agent" / bundle id `ai.prism.agent.desktop`, home `$PRISM_HOME` or `~/.prism`, NSIS single-user install), so today's collisions are concentrated on the install surface and the data root.

The decisions below were asked in a prior session (2026-10-15) and confirmed by the user in this session; nothing here is inferred.

## [S2] Design

**D1 — Scope: install artifacts plus data root.** The renamed surfaces are the CLI npm package, its bin, the CLI's default home, and the references the changed names make untrue. The internal workspace namespace `@deepseek-ai/*` stays untouched — several hundred packages resolve through tsconfig paths and the `workspace:*` graph, and renaming them would invalidate the replayable fork-divergence index wholesale. The desktop application, its bundled runtime layout, the `.dsh`-prefixed `package.json` manifest keys (`dsh.bundle`, `dsh.client`), and the `DSH_HOME` environment protocol keep their names.

**D2 — Names.** bin `prism`, npm package `prism-agent`, default home `~/.prism`. The home matches the desktop's so one data root serves both; `PRISM_HOME` remains the desktop's shell override and `DSH_HOME` remains the child-process protocol variable, so `~/.prism` is both shells' zero-configuration root.

**D3 — The one behavioral change is the default home.** `DSH_HOME_DIR_NAME` becomes `.prism`; `DEFAULT_DSH_HOME_DISPLAY`, the `resolveDshHome` JSDoc, and the `dshHomeDisplay` labels follow. Every entry including the desktop child spawn already routes through `resolveDshHome`, so a source-run CLI stops sharing `~/.dsh` and there is no second seam to pass. Precedence is unchanged: explicit configured path, then `$DSH_HOME`, then the default.

**D4 — Identity ring around the renamed package.** The CLI package name appears in four consumer sites that must follow: the `workspace:*` dependency rows in `packages/sdk/client/package.json` (imports `./profile-boot`) and `python/sdk-runtime/package.json`; the bundled-runtime deploy search `--filter` in `apps/desktop/scripts/bundle-runtime.mjs`; and the bundled-carrier node_modules path join in `python/sdk-runtime/src/deepseek_harness_runtime/__init__.py`, whose asset lookup resolves `node_modules/prism-agent/lib/bin.js`. The commander program name `apps/cli/src/args.ts` `.name('dsh')` becomes `prism`, and the recorded help expectation `apps/cli/tests/expected/launcher-help.txt` is regenerated so the banner names the real bin. The Python runtime wheel's console script `python/sdk-runtime/pyproject.toml` renames from `dsh` to `prism` for the same reason, with its runtime resolution paths following to `node_modules/prism-agent/lib/bin.js`. The root README's install line becomes `npx prism-agent web`, and the CLI package's `repository` points at this fork.

**D4b — Boundary of the rename.** Strings owned by the fork's launcher (`apps/cli`) and the documents this change touches follow `prism`: the help banner and examples, the risk-acceptance command, the CLI package's own README pair, the CLI usage guide pages here, the Python wheel's console command and its docs. Strings owned by the harness kernel — stderr diagnostic prefixes, inner-app help banners, kernel JSDoc and package READMEs (and therefore the generated `config-catalog` rows those JSDoc feed), instruction literals inside kernel packages, and the wider documentation site's examples — keep upstream's `dsh` spelling; renaming that vocabulary is a harness-wide rebrand rather than install separation and is recorded as out of scope below.

**D5 — Recorded resolution stays upstream.** `docs/dependency-catalog.json` with its generator (`scripts/gen-dependency-catalog.ts`, `scripts/dependency-catalog/`) records the published `@deepseek-ai/dsh` npm closure and is regenerated against the public registry. The fork does not publish `prism-agent` yet, so no prism-side regeneration is possible and the recorded artifact stays a replica of the upstream story; the area rows below record that it is deliberately left untouched.

**D6 — Divergence index.** The new divergence sites enter `docs/compose/spec/fork-upstream-divergence.md` as areas A8 (CLI install identity: package name, bin, program name, help expectation, README install line, consumer dependency rows, bundle deploy filter, carrier paths) and A9 (default harness home `.prism`). Files upstream also owns carry the `PRISM-DIVERGENCE` marker on the line above the divergent construct; `package.json` and the help expectation have no comment syntax, so those two sites are excluded from the marker rule and named only in the index — `rg -n PRISM-DIVERGENCE` alone cannot find them, and the index row says so.

## [S3] Scope

- In scope: the CLI package identity change, the default-home change, the D4 ring, the A8/A9 index rows and markers, this document.
- Out of scope: the internal `@deepseek-ai/*` package namespace; the root `pnpm dsh` source-launch script alias (name-external, `node --import tsx/esm apps/cli/src/bin.ts`); `docs/dependency-catalog.json` and its generator per D5; the desktop product identity, installer, and `runtime/dsh` closure directory name; the Python PyPI carrier package name (`deepseek-harness-runtime-bin`) and its SDK profile grammar (its console script does rename, per D4); the harness kernel's `dsh` command vocabulary per D4b, including kernel package READMEs, kernel JSDoc, the generated catalog rows they feed, and documentation-site examples outside the files this change touches (recorded as a follow-up, not a defect); renaming the `.dsh`-prefixed `package.json` manifest keys; a data-carrier for existing `~/.dsh` users (the fork is unpublished; the already-delivered cross-home session import plan names candidate homes explicitly and its spec must keep `~/.dsh` as a listed source when implemented); plugin and profile contents under `plugins/` and `home-mods/`.

## Tasks

- [x] T1: default home — `DSH_HOME_DIR_NAME` to `.prism`, display and JSDoc strings, A9 marker above the constants, and the home-paths spec expectations (depends: none)
- [x] T2: CLI identity — `apps/cli/package.json` name, bin, description, repository; `args.ts` program name with marker; regenerate `launcher-help.txt` (depends: none)
- [x] T3: consumer ring — `packages/sdk/client` and `python/sdk-runtime` workspace dependency rows, `bundle-runtime.mjs` deploy filter, `deepseek_harness_runtime` path joins and message text, root README install line (depends: T2)
- [x] T4: divergence index — A8 and A9 rows in `fork-upstream-divergence.md` and `.zh.md`, marker placement review, desktop comment truthfulness in `setup.rs`/`dsh_runner.rs` (depends: T1, T2)
- [x] T5: verification — record each command and result under [S4] (depends: T3, T4)
- [x] T6: review remediation — Python wheel console script, the four repository gates that keyed the CLI by its old name (`verify-application-entrypoints`, `verify-default-product-isolation`, `check-workspace-constraints`, `verify-dsh-package-licenses`), the session-migration corpus default via `dshHomePath`, package README default-home statements, and the CLI usage-guide command examples (depends: T5)

## [S4] Acceptance

- [ ] A1: with neither `$DSH_HOME` nor a configured path, `resolveDshHome()` in the built package resolves to `~/.prism`; a set `$DSH_HOME` still wins.
- [ ] A2: `npm pack` from `apps/cli` (built `lib/`) produces `prism-agent-<version>.tgz` whose manifest declares bin `prism → lib/bin.js`.
- [ ] A3: a source launch `node --import tsx/esm apps/cli/src/bin.ts --help` prints a banner whose usage lines say `prism`.
- [ ] A4: `rg -n PRISM-DIVERGENCE` reports the A8 sites it can (source files) and none of the removed markers; `fork-upstream-divergence.md` lists A8 and A9 with the JSON-no-marker exception named.
- [ ] A5: `packages/util/home-paths` and the `args.ts` unit segment pass their vitest run; the changed bilingual pairs pass `verify-translation-pairing` and `verify-md-wrap`; `verify-md-links` and `verify-doc-budgets` report no new failure for changed paths.
- [ ] A6: the desktop spawn path is untouched at the code level: `dsh_runner.rs` passes `DSH_HOME = setup::dsh_home()` and its adopt record key remains the bin file identity, so no colliding hub of another build is ever adopted.
