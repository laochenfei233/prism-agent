# Prism Logo 源文件与再生成

English | [中文](README.zh.md)

本目录的 SVG 是 Prism 品牌标识的唯一矢量来源；`apps/desktop/src-tauri/icons` 与
`apps/web/public/favicon*.svg` 中的位图与 favicon 都由它们派生。

## 源文件

| 文件 | 用途 |
| --- | --- |
| `prism-icon-badge.svg` | 应用图标（白色圆角方底 + 黑色六边形点阵），生成 `icon.ico`、`icon.icns` 与 `apps/desktop/src-tauri/icons` 的位图 |
| `prism-mark.svg` | 24 单位紧凑标记，`currentColor`，与应用内 `PrismLogo` 几何一致 |

## 几何约定

点阵以六边形外接圆半径 10、圆心 (12, 12) 为基准，尖顶朝上：

- 外圈半径 10、节点半径 2.6
- 中心节点半径 3.2
- 环与辐条线宽 2.4

应用内 `packages/client/ui-primitives/src/PrismLogo.tsx` 使用同一组数值，改动时两边必须同步。

## 再生成

位图由无头 Chromium 渲染 SVG 母版（1024px）后再逐级对半降采样，避免一次性
1024 → 16 的双三次缩放把点阵糊掉。

1. 把 SVG 内联进一个 `body{margin:0;background:transparent}` 的页面，以
   `--window-size=1024,1024 --default-background-color=00000000 --force-device-scale-factor=1`
   截图得到 1024 母版。
2. 用双三次插值按 1024 → 512 → 256 → 128 → 64 → 32 → 16 逐级降采样；非 2 的幂的
   平台尺寸取最近的上一级再次降采样。
3. Windows 与 macOS 桌面端使用 `prism-icon-badge.svg` 生成 `icon.ico`（16/32/48/64/128/256 的 PNG 载荷）与 `icon.icns`
   （icp4/icp5/icp6/ic07–ic14 的 PNG 载荷）。

`apps/web/public/favicon.svg` 与 `favicon-dark.svg` 是单色版本：整份文件只有一个
`color` 取值，`fill` 与 `stroke` 都继承 `currentColor`，两者除该取值外逐字节相同。
