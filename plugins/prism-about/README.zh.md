# prism-about

[English](README.md) | 中文

一个 DeepSeek Harness 插件包，为桌面应用添加**设置·关于节**：当前版本、应用内更新器（国内镜像在前、GitHub Releases 兜底）与项目链接。

它是以已发布插件形态构成的非仓库内 bundle（`dsh.bundle.patch` + `dsh.client` 浏览器半），不是对 Harness 检出的修改。

## 展示内容

- 品牌块：应用名、一句话定位、版本胶囊，以及检查更新按钮（检查中 / 已是最新 / 立即更新 / 重试等状态）。
- 进度区：下载百分比（服务端未给出总长时显示不确定态）、正在安装、已安装待重启文案。
- 更新源卡片：所配置的更新源——壳配置了国内镜像 endpoint 时显示官方地址 `prism.xyern.com` 与镜像徽标，否则显示提供更新的仓库与 GitHub Releases 徽标，从壳配置的更新器 endpoint 解析。
- 链接行：更新日志（Releases 页）与意见反馈（GitHub issues），始终落在 GitHub。

## 不做什么

没有 Host 服务、工具、RPC 面或存储。本节只读取壳注入的更新载具（`globalThis.dshDesktop`，`protocolVersion: 1`，桌面壳在打包时注入），从不选择工件、也从不授权安装——两者都归壳所有。在桌面壳之外降级为一行静态文案。

更新源是固定的：壳的更新器 endpoint 为国内镜像
`https://cdn.xyern.com/prism-agent/updates/latest.json` 在前、本仓库 GitHub Releases
`https://github.com/laochenfei233/prism-agent/releases/latest/download/latest.json` 兜底，
没有自定义更新源入口。关于卡片显示官方地址 `prism.xyern.com`，更新器实际请求 CDN 清单——显示与实际有意分离。CDN 清单就绪前检查自动落到 GitHub；全部不可达时以「无法连接更新源」状态失败。

## 目录结构

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

## 构建

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

## 安装到 profile

桌面壳在首次启动时把每个带 `dsh.bundle.patch` 的 `plugins/` 目录复制进
profile 并选作 bundle layer，打包应用无需任何配置即可携带本插件。其他
profile 可用：

```sh
dsh plugin --profile web add prism-about
```

安装后重启服务。
