---
feature: adb-workspace-executable-guard
status: designed
updated: 2026-11-24
branch: feat/adb-workspace-executable-guard
commits: 待交付时回填
---

# Command guard：可执行文件工作区限定（adb）

English | [中文](adb-workspace-executable-guard.zh.md)

## Report

待实施后回填。

## [S1] Problem

模型可以通过 bash/pwsh 调用 PATH 上的任意可执行文件，`adb` 是典型代表（可操作已连接的 Android 设备，ZCode v3.19.1 因此把 adb 限定为"仅允许使用工作区内的可执行文件"）。prism-agent 的 command guard（`plugins/prism-guardrails`）目前只能按命令原文正则匹配、命中即 ask（`src/index.ts:1107-1121`），表达不了"该命令的可执行文件必须位于工作区内"的语义，对 adb 也没有任何限制。

## [S2] Design

### S2.1 规则结构扩展（`src/config.ts`）

- `CommandRule`（`config.ts:62-67`）增加可选字段 `workspaceBinary?: boolean`（缺省 `false` = 现行为完全不变）；键名加入 `COMMAND_RULE_KEYS`（`config.ts:247`）。
- 语义：命中该规则且**可执行文件不在工作区内（或无法确认在工作区内）→ deny；可执行文件在工作区内 → 放行（不 ask，继续后续规则）**。即该类规则是"合规放行、违规拒绝"，不同于普通规则的"命中即 ask"。
- `resolveCommandRules`（`config.ts:746-778`）做布尔校验（非法值加载即 throw），并把标志保留进 `ResolvedCommandRule`（`config.ts:78-85`）。
- 出厂配置（`cordis.patch.yml` 的 commandGuard 段）为 bash 与 pwsh 各新增一条：`{ pattern: "\\badb\\b", reason: "adb 仅允许使用工作区内的可执行文件", workspaceBinary: true }`。

### S2.2 可执行文件提取与工作区判定（新 helper + `installCommandGuard`）

- 新增小 helper（`src/executable.ts`）：从命令原文提取可执行文件 token——取首 token，剥离前置 `VAR=value` 赋值；识别 `bash -c "..."`/`sh -c "..."` 包装时取内层首 token。精度与现有"raw text matching"同级，`shortcut:` 注明升级点（完整语义需 shell 解析器，见 `index.ts:1099-1101` 既有注释）。
- 判定：token 含路径分隔符 → 相对路径按 `exec.agent.session.header.cwd` 解析为绝对路径；裸名 → 按 `PATH`×`PATHEXT`（Windows）逐目录查找（插件内实现最小版，对齐 `packages/subprocess/subprocess-local/src/index.ts:155-195` 的候选逻辑）。
- 结论：解析出的绝对路径位于 `cwd` 之下 → 合规放行；位于之外或解析失败 → deny。工作区根取 `exec.agent.session.header.cwd`（与插件现有用法一致，如 `index.ts:344`、`src/ponytail.ts:495`），不引入 sandboxPolicy 依赖。
- deny 消息（`index.ts:1116-1117` 拼装点）：引用规则 `reason` + 实际解析路径 + 工作区根，不含命令原文。

### S2.3 observe 模式

走既有 `decide()` 通道（`index.ts:183-194`）：observe 时记 `observed` 并放行，enforce 时 deny。deny 无需审批通道。

### S2.4 配置与治理

- 不新增顶层配置键（`commandGuard` 结构内扩展）；`configVersion` 对整个 config 做哈希，自动覆盖新字段。
- README 配置表补 `workspaceBinary` 字段说明与 adb 示例；`cordis.patch.yml` 同步。

## [S3] Scope

- In scope: `CommandRule` 扩展与校验、可执行文件提取/PATH 解析 helper、工作区判定、deny 消息、出厂 adb 规则（bash+pwsh）、README 与 patch 示例、config 单测与行为测试。
- Out of scope: 通用 shell 解析器；对 adb 之外命令的批量限定；沙箱层（`packages/sandbox`）改动；基库 `resolveExecutable` 行为变化。

## Tasks

- [ ] T1: config.ts 规则字段 + 校验 + 键集同步（depends: none）
- [ ] T2: `src/executable.ts` 提取/解析 helper + 工作区判定（depends: none）
- [ ] T3: `installCommandGuard` 集成新判定与 deny 消息（depends: T1, T2）
- [ ] T4: 出厂 `cordis.patch.yml` adb 规则 + README 示例（depends: T1）
- [ ] T5: 测试——config 非法值 throw；行为：区外 deny、区内放行、裸名解析失败 deny、`VAR=` 前缀与 `bash -c` 包装、observe 放行、无规则命令不受影响（depends: T3）

## [S4] Acceptance

- [ ] 未配置 `workspaceBinary` 的规则行为与现状完全一致（命中即 ask）
- [ ] `adb devices` 且 adb 位于系统 PATH（工作区外）→ deny，消息说明原因并给出工作区根
- [ ] 工作区内 `./adb devices`（cwd 下存在 adb）→ 放行，不 ask
- [ ] `adb` 裸名且 PATH 解析不到 → deny，消息说明"未能确认可执行文件位于工作区内"
- [ ] `VAR=x adb devices`、`bash -c "adb devices"` 均被正确提取并判定
- [ ] observe 模式下违规命令放行并记 `observed`
- [ ] `workspaceBinary: "yes"` 等非法值加载即 throw
- [ ] guardrails 既有测试全绿，新增用例覆盖上述路径；宿主面 `tsc --noEmit` 通过
