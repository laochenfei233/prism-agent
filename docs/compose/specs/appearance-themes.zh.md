---
feature: appearance-themes
status: delivered
updated: 2026-10-31
branch: feat/appearance-themes
commits: 42f8b7cfed..745b01c530
---

# 外观主题：独立设置节、自定义主题、五套配色与各异的预览

[English](appearance-themes.md) | 中文

## Report

**做了什么** —— 主题选择器现在是设置侧栏里独立的「外观」设置节（nav order 5，自己的色块图标），收纳主题画廊、自定义主题组与字体设置；General 不再列出这些条目。画廊渲染十二行——`system`、十套内置配色（`light`、`dark`、`graph-glass`、`mono-accent`、`strata-dark`，以及新的 `paper`、`blueprint`、`phosphor`、`sumi`、`sage`）与 `custom`——每行绘制自己的预览图样；设计主题通过与运行时应用的同一批 token 展示画布纹理。

自定义主题在运行时由三个持久化输入（`customScheme`、`customCanvas`、`customAccent`，在设置边界做十六进制校验）合成一个部分覆盖层：表面色从画布按钳制后的中性饱和度推导，强调色的花费方式与 `mono-accent` 一致并按亮度解析反色文字，label/state 色阶回落到已验证的基础配色。`ThemeRuntime.setCustom` 在一次设置写入中同时写变更字段与偏好切换，并重新发布 `theme/change`；boot 脚本在首次绘制前绘制存储的自定义画布。所有 `ThemeSnapshot` 消费方都已为新 `custom` 字段更新，config/slot catalog 已重新生成。

**验证** —— `pnpm vitest run packages/client/ui-theme/tests/` 通过（2 个失败为 base 上既有：corner-shape-styles 与 scrollbar-styles 样式表扫描）；`packages/client/ui-settings-general/tests/` 86 通过（2 个此前失败的 ledger 测试已通过记录真实交付名册修复）；ThemeSnapshot 消费方规格覆盖 ui-layout/ui-settings-account/ui-sidebar-terminal 共 164 通过；`pnpm run build`（build:artifacts + build:check）通过；`pnpm run typecheck` 通过；`pnpm run duplication` 失败（既有，13 个克隆与 base 完全相同，不在被改文件中）；web e2e `settings-chrome.e2e.ts` 18 通过，`settings-appearance.e2e.ts` 通过且 `DSH_SNAPSHOT=refresh` 金标已提交；`verify-config-catalog`/`verify-client-catalog` 重新生成后通过；被改包的文档门禁干净（ui-chat/ui-conversation 的 summary 预算与 prism-backup README 骨架因 master 上其他合并而既有失败）；对全部十二个图样、五套应用主题与实时自定义合成的可视化走查截图已评审。评审 subagent：规格符合通过、正确性通过、代码库一致性通过（catalog 修复后）；复审全项通过。

**过程记录** ——

- 一条 `settings.section` 注册只带一个 store，因此两个 `settings.general.item` 行 store 合并为一个设置节 store；画廊、自定义组与字体行变成设置节内部组件，按 store + locale 定型，而不是 slot 运行时。
- 宿主 `Config` z.object 里的计算键（`[CUSTOM_SCHEME_FIELD]:`）弄坏了 config-catalog 生成器，它无法求值这些键；生成的 catalog 需要字面量键。评审发现，改为字面量。
- 自定义主题以部分覆盖层交付（表面 + 强调色集合推导，label/state 色阶回落到基础配色），而不是合成全部约 60 个 token——对比度沿用已验证的值，推导面保持很小。
- 新设置节让两个叫 深色/浅色 的按钮同屏出现（主题卡片 vs 基础配色分段控件）；画廊上的 `role="group"` 加 aria-label 为辅助技术与 e2e（`openAppearanceGallery`）消歧。
- master 带着此前合并的既有红灯（样式表扫描、summary 预算、prism-backup README 骨架、duplication 克隆）；每项都在 base 树上验证相同后才记为 PRE-EXISTING。

## [S1] 问题

主题选择器是 General 设置节里的一行，六个可选项全部渲染同一预览小样、只有颜色不同，没有办法自定义颜色，配色名册里也缺用户要的暖纸方向。用户想要：

1. 主题提升为独立的设置侧栏条目（「外观」），字体设置一并移入。
2. 完整的自定义主题：基础配色 + 画布颜色 + 强调色，运行时合成完整的别名 token 集。
3. 五套新的内置配色：一个受 easel.xyern.com 启发的纸感主题，加上蓝晒图（Blueprint）、琥珀磷光 CRT（Amber Phosphor CRT）、墨韵（Sumi）与苔原绿（Sage）。
4. 画廊每行一个不同的预览图标，而不是同一布局的重新配色。

设计已在 plan 模式批准（用户确认范围：完整自定义主题、全部四个额外方向、字体移入、compose-next 工作流）。

## [S2] 设计

### S2.1 独立的外观设置节

- `packages/client/ui-theme/src/client/index.ts` 去掉两条 `settings.general.item` 注册（`appearance`、`font-size`），改注册一条 `settings.section` 条目：`{ id: 'appearance', order: 5 }`（位于 General 0 与 Models 10 之间）、`label: () => t('appearance.title')`、`locale: SETTINGS_NS`。
- 新的 `AppearanceSection.tsx` 组合主题画廊组、自定义主题组（S2.2）与既有 `FontSettingsGroup`。
- 两个行 store（`createAppearanceRowStore`、`createFontRowStore`）合并为一个 `createAppearanceSectionStore`，持有 `{ preference, entries, revision, fontSizes, fontFamilies }`——一个设置节是一个 slot 面，一条 slot 注册只带一个 store。
- `SettingsRoot.navIcon` 增加 `appearance` 分支，渲染新的 `IconThemeOutlineMedium`（`packages/client/ui-primitives/src/icons/index.tsx` 中手写的 16x16 SVG，house 风格）。
- `packages/client/ui-settings-general/tests/settings-root.client.spec.tsx` 的图标测试与外壳 ledger 测试加入新 id。

### S2.2 自定义主题（运行时合成）

- `theme-settings.ts`：`THEME_PREFERENCES` 增加 `'custom'`（排在内置 id 之后；`BUILTIN_THEME_IDS` 仍表示「随产品发布的配色」）。`ThemeSettings` 增加平铺字段：
  - `customScheme: 'light' | 'dark'`（缺省 `'light'`）。
  - `customCanvas: string`（hex3/hex6，缺省 `'#ffffff'`）。
  - `customAccent: string`（hex3/hex6，缺省 `'#ff6900'`）。缺省值使初始自定义主题等于带 Prism 橙的浅色基础主题。schema 增量添加且带默认值——无需升级指南。
- `synthesizeThemeTokens({ scheme, canvas, accent }): ThemeTokens`——纯函数，Host 与浏览器共享，有单元测试：
  - 表面色从画布推导：layer 各级按固定增量提亮（浅色 +3/6/9%，深色 +5/10/15%），饱和度钳制在 <= 8%；边框用去饱和的画布色相加既有 alpha 色阶（浅色 7/11/15/20%，深色 6/12/16/20%）。
  - label 色阶是每个 scheme 已验证的基础配色墨色值，从不推导——对落在该 scheme 明度带内的画布，对比度有保证（已记录的假设；画布由用户挑选）。
  - 强调色的花费方式与 `mono-accent` 一致：brand/链接/按钮填充/business = 强调色；hover 在浅色下加深 8%、深色下提亮 10%；弱化与交互层用强调色 alpha；`brand-primary-invert` 按 WCAG 亮度解析为白色或近黑。success/warn 折叠为中性色；error 保留平台红（mono-accent 先例）。
  - 无纹理 token（`--dsh-theme-*-image` 保持未设置）。
- `ThemeRuntime`：当 `preference === 'custom'` 时，激活主题与画廊快照携带合成后的定义（id `'custom'`）。单一 `setCustom(patch)` 一次写入自定义字段并把 `preference` 切到 `'custom'`（编辑这些控件就是在使用该主题）；volatile 字段让重新合成经由既有 `theme/change` 发布实时生效。`setTheme('custom')` 只翻转偏好。
- Boot：`bootThemeInjections` 接受解析后的自定义 `{ canvas, dark }`；Host 的 `apply()` 读取自己的 Config 并传入，因此绘制前的画布一致，不会闪色。

### S2.3 新配色

`builtin-themes.ts` 增加五套完整 token 集（既有设计主题覆盖的每个别名与具体 token，外加 `bootBackground`）：

- `paper` 纸感（浅色，boot `#f4eee1`）：canvas-image 是内联 SVG feTurbulence 颗粒 data-URI（3.5% alpha）；暖奶油色阶 `#f4eee1`/`#faf6ec`/`#fcf9f2`/`#fefcf6`；暖褐发丝边框；墨色 `#35291a` label 色阶；朱红 `#c2402a` 强调色与按钮。
- `blueprint` 蓝晒图（深色，boot `#10293f`）：32px 白色网格 canvas-image；氰版色阶 `#10293f`/`#16324c`/`#1b3a57`/`#20425f`；白色 alpha 边框；淡蓝白 `#e6eef6` label；淡青线条 brand `#dcebf7`；琥珀 `#e8a33d` 作标记/选中色。
- `phosphor` 琥珀磷光（深色，boot `#0d0a05`）：扫描线 center-image（3px）；暖近黑色阶 `#0d0a05`/`#161006`/`#1c1509`/`#231a0c`；琥珀调 label 色阶 `#f2e8d8`…；brand/链接/按钮/business 只用琥珀 `#ffb000`；success/warn 折叠为中性；error 保留平台红。
- `sumi` 墨韵（浅色，boot `#fafaf8`）：无纹理；冷纸色阶 `#fafaf8`/`#f3f3f0`/`#ecece8`/`#e4e4df`；中性墨色边框；墨色 `#1c1c1a` label；brand 与按钮用墨黑，链接、business 状态与选中行用朱砂 `#b53a26`。
- `sage` 苔原绿（浅色，boot `#edf0e8`）：绿灰色阶 `#edf0e8`/`#f4f6ef`/`#f9faf4`/`#fcfdf9`；绿灰发丝线；深绿墨 `#26332a` label；苔绿 `#3f6b4a` 强调色。

Boot 的 `DARK_THEME_IDS` 自动从 `BUILTIN_THEMES` 推导。

### S2.4 各异的预览图样

- `gallery.ts`：`ThemeGalleryEntry` 增加 `motif: PreviewMotif`；同包的 `THEME_MOTIFS` 映射为每个已知 id 指定一个图样（`system: 'split'`、`light: 'sheet'`、`dark: 'night'`、`graph-glass: 'grid'`、`mono-accent: 'beacon'`、`strata-dark: 'strata'`、`paper: 'grain'`、`blueprint: 'plan'`、`phosphor: 'crt'`、`sumi: 'ink'`、`sage: 'fern'`、`custom: 'bespoke'`）；未知的已注册主题回落到 `'plain'`（当前组合），第三方注册因此继续工作。
- `AppearanceRow.module.css` 用既有三个预览变量加静态渐变/伪元素渲染每个图样（对角 system 分割、网格线、扫描线、阴影线、印章点、光条）。JSX 只通过带类型的 `Record<PreviewMotif, string>` 查找添加图样类——预览保持由注册表驱动，从不硬编码主题颜色。

### S2.5 文案

所有新文案都在 `settings.theme` 命名空间字典里（`packages/client/ui-theme/src/client/locales.ts`），zh 与 en 在同一改动中提交：五个主题名、`appearance.custom`、自定义组标签（scheme 切换、画布、强调色、重置、输入框 aria 标签）。`LocaleDictOf` 让键集合保持编译期校验。

## [S3] 范围

- 范围内：设置节迁移、合并后的设置节 store、自定义主题字段/合成/运行时/boot、五套配色、预览图样、导航图标、i18n、测试与预期输出更新、README/文档同步。
- 范围外：第三方主题 API 改动（`register()` 不动）、桌面原生主题转发、越带自定义画布的对比度自动校正、保存/命名多个自定义预设、跨主题共享的强调色预设。

## Tasks

- [x] T1：`theme-settings.ts` 自定义偏好/字段/schema、hex 校验、`synthesizeThemeTokens` 与单元测试 (depends: none)
- [x] T2：`builtin-themes.ts` 五套配色；boot 自定义透传 + Host `apply()` (depends: T1)
- [x] T3：`ThemeRuntime` 自定义合成、`setCustom`、快照暴露 (depends: T1)
- [x] T4：外壳迁移——`settings.section` 注册、`AppearanceSection.tsx`、设置节 store 合并、导航图标 (depends: T3)
- [x] T5：预览图样——`gallery.ts` + `AppearanceRow.module.css` (depends: T4)
- [x] T6：i18n 键；更新 ui-theme / ui-settings-general 规格、web e2e 助手与 expected markdown (depends: T4, T5)
- [x] T7：README/文档同步 (depends: T6)
- [x] T8：完整验证、可视化走查、评审 subagent、定稿 spec (depends: T1–T7)

## [S4] 验收

- 设置侧栏在 通用 与 模型 之间显示带自己图标的外观；设置节包含主题画廊、自定义主题组与字体设置；General 不再列出它们。
- 画廊渲染 12 行（system、十个内置、自定义），每行图样各异；选择经既有设置传输持久化。
- 每个新主题应用完整配色（含纹理 token）；启动画布与激活主题一致（首次绘制无闪烁），自定义主题同样。
- 编辑自定义 scheme/canvas/accent 会持久化、激活 `custom` 并实时重新合成 token；重置恢复默认值；格式错误的十六进制被 schema 拒绝。
- 旧设置文档加载不变（增量默认值）；zh/en 词典保持完整（编译期强制）。
- 聚焦单元规格、`typecheck`、`build:artifacts` 之后的 `build:check`、`duplication` 与 settings web e2e 本地通过，expected markdown 已更新。
- 评审 subagent 对规格符合、正确性与代码库一致性返回通过。
