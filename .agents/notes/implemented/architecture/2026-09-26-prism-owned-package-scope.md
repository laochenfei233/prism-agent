# Agent Note: Prism-owned package scope

Status: implemented

English | [中文](2026-09-26-prism-owned-package-scope.zh.md)

## Problem

Prism needs product capabilities that build on DeepSeek Harness without pretending they are upstream DSH packages. Reusing the `@deepseek-ai/dsh-*` namespace would make publication ownership ambiguous, would force Prism releases onto the DSH version sequence, and would make future upstream synchronization harder to classify.

The first such capability is meeting minutes. It combines a Host service, durable storage, configured model calls, speech ingestion, and model-facing tools, so the ownership rule has to work for a real multi-entry plugin rather than only a library.

## Decision

Prism-owned packages live under `packages/prism/<package>` and use the `@prism-ai/` npm scope. Their repository metadata points at `git+https://github.com/laochenfei233/prism-agent-e.git` and their own directory, not at the upstream DeepSeek Harness repository.

`@prism-ai/prism-meeting` is the first package under this rule. It lives at `packages/prism/prism-meeting`, exports the meeting service from its root, and exports the model-facing plugin from `./tools`. Its root and subpath plugins are registered by the base bundle beside the DSH services they consume.

Workspace tooling recognizes both package scopes as first-party source:

- `check-workspace-constraints` accepts the Prism repository URL for `@prism-ai/` release members while retaining DSH-only version, Cordis peer, and publication-payload rules for `@deepseek-ai/dsh-*`.
- `collectPackageGraph` includes `@prism-ai/` packages and strips either recognized scope for short graph names.
- `tsconfig.base.json` carries an explicit Prism path alias because generated aliases cover only the DSH scope.

Upstream DSH packages keep their names, versions, repository metadata, and release family. Prism does not rename an upstream package merely because Prism composes it.

## Alternatives considered

**Keep `@deepseek-ai/dsh-meeting-minutes` and `@deepseek-ai/dsh-tool-meeting-minutes`.** This preserved the original package split, but it claimed the upstream namespace for Prism-owned behavior, coupled the feature to the DSH release sequence, and made future syncs unable to distinguish copied upstream code from Prism additions.

**Use `@prism-ai/prism-meeting-service` and `@prism-ai/prism-meeting-tools`.** Two packages would preserve separate dependency surfaces, but the service and tools have one deployment lifecycle and no independent versioning requirement. A root service plus a `./tools` export keeps one package identity and one repository directory.

**Keep the package under `packages/meetings/`.** The path would describe the capability but not the owner. `packages/prism/` makes ownership reviewable and gives future Prism packages one home without changing the upstream group taxonomy.

## Consequences

Prism can add product-specific packages without occupying DSH package names or changing upstream package versions. Import and documentation tooling now has a second recognized scope, so future changes to package discovery must test both scopes.

Prism packages are not part of the `dsh` release family. Publishing them through npm requires an explicit Prism release process or direct package publication; this change establishes package identity and repository ownership, not an automated release lane.
