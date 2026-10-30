# Prism Logo 源文件与再生成

[English](README.md) | 中文

本目录的 SVG 是 Prism 品牌标识的唯一矢量来源；`apps/desktop/src-tauri/icons` 与
`apps/web/public/favicon*.svg` 中的位图与 favicon 都由它们派生。

## 源文件

| 文件 | 用途 |
| --- | --- |
| `prism-icon-badge.svg` | macOS 应用图标（白色圆角方底 + 黑色六边形点阵），生成 `icon.icns`；Windows 安装程序插画沿用它的底板比例 |
| `prism-icon-badge-windows.svg` | Windows 版同一标识：底板与标记放大到适合任务栏的比例，生成 `icon.ico` 与 `apps/desktop/src-tauri/icons` 的位图 |
| `prism-mark.svg` | 24 单位紧凑标记，`currentColor`，与应用内 `PrismLogo` 几何一致 |

## 几何约定

点阵以六边形外接圆半径 10、圆心 (12, 12) 为基准，尖顶朝上：

- 外圈半径 10、节点半径 2.6
- 中心节点半径 3.2
- 环与辐条线宽 2.4

应用内 `packages/client/ui-primitives/src/PrismLogo.tsx` 使用同一组数值，改动时两边必须同步。

## 两种底板比例

macOS 不给图标加遮罩，`prism-icon-badge.svg` 按 Apple 图标网格把底板取在 800/1024（约 78%）。
Windows 由资源管理器把位图直接放进 24px 任务栏槽位、同样不加遮罩，沿用同一底板时标记在
100% 缩放下只有约 11px，比同排图标明显小一圈。`prism-icon-badge-windows.svg` 因此把底板
放大到 960/1024、标记按 30 倍缩放（点阵直径占底板 62.5%），并去掉投影：更大的底板没有
投影余量，Windows 的窗口与任务栏也自备背景。两份源文件的点阵几何完全相同，改动时一起改。
macOS 的 Dock 图标仍用 78% 的 `icon.icns`；macOS 与 Linux 的默认窗口、托盘图标取首个 PNG
（`32x32.png`），随位图一起放大。

## 再生成

位图由 1024px 母版逐级降采样，避免一次性 1024 → 16 的缩放把点阵糊掉。

1. macOS 母版用无头 Chromium 渲染 `prism-icon-badge.svg`：把 SVG 内联进一个
   `body{margin:0;background:transparent}` 的页面，以
   `--window-size=1024,1024 --default-background-color=00000000 --force-device-scale-factor=1`
   截图；源文件带 `feDropShadow`，ImageMagick 7.1 附带的 librsvg 2.40 会忽略该滤镜。
2. Windows 母版用 `magick -background none prism-icon-badge-windows.svg PNG32:master.png`
   渲染（源文件不含滤镜）。
3. 用 Lanczos 插值（`-filter Lanczos`）按 1024 → 512 → 256 → 128 → 64 → 32 → 16 逐级降采样；
   非 2 的幂的平台尺寸取最近的上一级再次降采样。
4. Windows 用 `prism-icon-badge-windows.svg` 的母版生成 `icon.ico` 与
   `apps/desktop/src-tauri/icons` 的位图。`icon.ico` 含 16/24/32/48/64/128/256，条目从大到小
   排列：tauri-codegen 2.6.3 取首个条目作为 Windows 的默认窗口与托盘图标，24px 则是任务栏
   在 100% 缩放下的槽位尺寸。`icon.png` 由壳在启动时设为窗口图标；`32x32.png` 等 PNG 同时是
   macOS 与 Linux 的默认窗口图标，Linux 的包图标也取自它们。
5. macOS 用 `prism-icon-badge.svg` 的母版生成 `icon.icns`（ic07–ic14 的 PNG 载荷）。

`apps/web/public/favicon.svg` 与 `favicon-dark.svg` 是单色版本：整份文件只有一个
`color` 取值，`fill` 与 `stroke` 都继承 `currentColor`，两者除该取值外逐字节相同。
