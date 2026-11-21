---
feature: custom-theme-presets
status: delivered
updated: 2026-10-31
branch: feat/custom-theme-presets
commits: 0d1cb5bf50..81d23f693f
---

# 自定义主题预设：保存、应用与删除命名配色方案

[English](custom-theme-presets.md) | 中文

## Report

**做了什么** —— 自定义主题的三个输入现在可以存成命名预设：自定义主题组里的一行保存区（名称输入框 + 保存）把当前 scheme/canvas/accent 存到一个名字下，每个已保存的预设是一枚 chip，经既有 `setCustom` 路径重新应用它的颜色（把偏好切到 `custom` 并实时重新合成），每枚 chip 上的 × 删除该条目且不动当前外观。预设持久化为 `ThemeSettings.customPresets`（增量字段，缺省 `[]`，条目 schema 要求非空名称与十六进制颜色，由写入方与运行时采纳方共同限高 16 个，后者还会丢弃手改的垃圾数据并规范化颜色），镜像进 Host `Config`（字面量键，catalog 已重新生成），经设置节 store 随 `ThemeSnapshot.customPresets` 传递，从不影响首次绘制。

**验证** —— `pnpm vitest run packages/client/ui-theme/tests/ …packages/client/ui-settings-general/tests/` 245 通过（2 个失败为 base 上既有：corner-shape-styles 与 scrollbar-styles 样式表扫描标记的 session-import CSS）；`pnpm run typecheck` 通过；`pnpm run build`（含 build:check）通过；`verify-config-catalog` 重新生成后通过；对 `packages/client/ui-theme` 的限定范围 oxlint 干净（全仓库 `pnpm run lint` 带着来自 master 的约 310 个既有错误）；联合运行中 `client/index.ts`/`CustomThemeGroup.tsx`/`theme-settings.ts` 覆盖率 100/100/100/100（设置节标签箭头由 general-shell 组合规格覆盖，CI 也是这样跑的）；真实应用中的可视化走查保存并应用了两个预设（截图已评审）。评审 subagent：4/4 条发现已修复并复验通过。

**过程记录** ——

- staged 的 pre-commit lint（49 条规则）与真实门禁（`run-oxlint.ts`，90 条规则）不一致：`keyCode` 只对真实门禁弃用，且禁止用字符串展开数码点。在宣称 lint 干净之前，先用 `tsx scripts/run-oxlint.ts <package>` 验证。
- `ThemeSnapshot` 是 pre-stable 形态：加一个字段就意味着改每个消费方的快照字面量（ui-layout、ui-settings-account、ui-sidebar-terminal），否则客户端聚合检查在 `exactOptionalPropertyTypes` 上失败。
- `{name}` 的 aria 插值必须用 `String.replace` 的函数形式（或 Translate params 机制）——原始替换会破坏含 `$&` 类序列的名称。
- 对任何按 Enter 提交的文本输入框，IME Enter 守卫（isComposing + keyCode 229）都是强制的；该弃用用法需要旁边有记录说明的 oxlint-disable。
- 宽容读取器的垃圾分支（null/非字符串/半截条目）经校验过的线上数据不可达，但手改文档需要它们；这些分支必须有显式测试，否则逐文件 100% 门禁变红。

## [S1] 问题

自定义主题只持有一组输入（`customScheme`、`customCanvas`、`customAccent`）：保存第二套外观会覆盖第一套。调出多套方案（一种心情或一个工作区一套）的用户无处保存它们。

## [S2] 设计

### S2.1 存储

- `theme-settings.ts` 增加 `CustomThemePreset { name, scheme, canvas, accent }` 与 `ThemeSettings.customPresets: CustomThemePreset[]`（缺省 `[]`，增量字段——旧文档加载不变）。schema 校验每个条目：非空字符串名称、scheme 联合类型、十六进制 canvas/accent。
- `ui-theme` 的 Host `Config` 镜像该字段（volatile），浏览器写入路径因此接受它；`docs/config-catalog*.md` 重新生成。

### S2.2 运行时

- `ThemeRuntime` 在状态中携带预设，经与其他自定义字段相同的宽容读取器采纳（丢弃无效条目、规范化颜色、重名保留第一个、限高 16 个），并发布到 `ThemeSnapshot.customPresets`。
- `saveCustomPreset(name)`：修剪名称（空名或超过 24 个码点在任何写入前抛出），以名称对当前自定义输入做 upsert，并在一次设置写入中写回整个数组。保存从不改变激活偏好。
- `deleteCustomPreset(name)`：移除条目并写回数组；删除激活预设不动当前输入。
- 应用预设复用 `setCustom`（它会把偏好切到 `custom`）；不存在新的激活路径。

### S2.3 界面

自定义主题组在强调色字段下方增加一块预设区：一行保存区（文本输入 + 保存按钮，名称有内容时可用）与每枚预设一个 chip。chip 经 `setCustom` 应用它的 scheme/canvas/accent；每枚 chip 上的 × 删除它（可访问名称携带预设名）。预设留在自定义组内——画廊仍是有界的、注册表驱动的面。

### S2.4 文案

`settings.theme` 命名空间，zh 与 en 同步：组标签、占位符、保存与删除标签。

## [S3] 范围

- 范围内：schema/宿主镜像、运行时保存/删除/采纳/快照、设置节 store + 组 UI、i18n、ThemeSnapshot 消费方更新、config-catalog 重新生成、README 同步、测试。
- 范围外：重命名（删除 + 重存）、画廊中的预设行、导入/导出、重排、boot 改动（预设从不影响首次绘制）。

## Tasks

- [x] T1：schema + 类型、运行时保存/删除/采纳、快照字段、消费方字面量 + 测试 (depends: none)
- [x] T2：设置节 store、`CustomThemeGroup` 预设 UI、i18n (depends: T1)
- [x] T3：Host `Config` 镜像、config-catalog 重新生成、README 同步 (depends: T1)
- [x] T4：验证、可视化走查、评审 subagent、定稿 spec (depends: T1–T3)

## [S4] 验收

- 以名称保存当前输入会持久化条目、显示为 chip，并在重载后仍在（持久文档）。✅
- 点击 chip 应用它的颜色、把偏好切到 `custom`，合成 token 实时更新。✅
- chip 上的 × 删除条目；删除激活预设保留当前外观；以已有名称保存会替换它。✅
- 格式错误的预设文档在运行时被丢弃；schema 拒绝格式错误的线上值；数组限高 16 条。✅
- 旧文档加载不变；zh/en 词典保持完整。✅
- 聚焦规格、`typecheck`、`build`（含 build:check）、catalog 门禁与评审 subagent 通过。✅
