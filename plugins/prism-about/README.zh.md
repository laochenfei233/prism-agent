# prism-about

[English](README.md) | 中文

一个 DeepSeek Harness 插件包，为桌面应用添加**设置·关于节**：当前版本、应用内更新器（更新源固定为本仓库的 GitHub Releases）与项目链接。

它是以已发布插件形态构成的非仓库内 bundle（`dsh.bundle.patch` + `dsh.client` 浏览器半），不是对 Harness 检出的修改。

## 展示内容

- 品牌块：应用名、一句话定位、版本胶囊，以及检查更新按钮（检查中 / 已是最新 / 立即更新 / 重试等状态）。
- 进度区：下载百分比（服务端未给出总长时显示不确定态）、正在安装、已安装待重启文案。
- 更新源卡片：GitHub Releases 徽标与提供更新的仓库，从壳配置的更新器 endpoint 解析。
- 链接行：更新日志（Releases 页）与意见反馈（GitHub issues）。

## 不做什么

没有 Host 服务、工具、RPC 面或存储。本节只读取壳注入的更新载具（`globalThis.dshDesktop`，`protocolVersion: 1`，桌面壳在打包时注入），从不选择工件、也从不授权安装——两者都归壳所有。在桌面壳之外降级为一行静态文案。

更新源是固定的：壳的更新器 endpoint 为
`https://github.com/laochenfei233/prism-agent/releases/latest/download/latest.json`，
没有自定义更新源入口。在首个携带更新器产物的 release 发布之前，检查会以「无法连接更新源」状态失败。

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
